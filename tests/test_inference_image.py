"""Offline tests for standalone inference copy; no Flask wiring or paid calls."""
import hashlib
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch
from PIL import Image

spec = importlib.util.spec_from_file_location('inference_image', Path(__file__).resolve().parents[1] / 'frontend/inference_image.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def image_bytes(size=(640, 480), mode='RGB', color='red', format='JPEG', **save_options):
    output = io.BytesIO()
    with Image.new(mode, size, color) as image:
        image.save(output, format=format, **save_options)
    return output.getvalue()


class InferenceImageTests(unittest.TestCase):
    def inspect(self, data):
        self.assertLessEqual(len(data), 2_500_000)
        image = Image.open(io.BytesIO(data))
        self.addCleanup(image.close)
        image.load()
        self.assertEqual(image.format, 'JPEG')
        self.assertEqual(image.mode, 'RGB')
        self.assertFalse(image.info.get('progressive'))
        self.assertFalse(image.info.get('progression'))
        for side in image.size:
            self.assertGreaterEqual(side, 280)
            self.assertLessEqual(side, 1568)
        self.assertEqual(len(image.getexif()), 0)
        return image

    def test_normal_photo_keeps_dimensions_and_original_bytes(self):
        original = bytearray(image_bytes())
        before = hashlib.sha256(original).digest()
        copy = helper.prepare_inference_jpeg(original)
        self.assertEqual(self.inspect(copy).size, (640, 480))
        self.assertEqual(hashlib.sha256(original).digest(), before)

    def test_exif_rotation_is_honored_and_not_copied_to_output(self):
        exif = Image.Exif()
        exif[274] = 6
        original = image_bytes((640, 480), exif=exif)
        self.assertEqual(self.inspect(helper.prepare_inference_jpeg(original)).size, (480, 640))
        with Image.open(io.BytesIO(original)) as source:
            self.assertEqual(source.size, (640, 480))
            self.assertEqual(source.getexif()[274], 6)

    def test_extreme_landscape_and_portrait_are_padded_not_stretched(self):
        for size, expected in [((4000, 100), (1568, 280)), ((100, 4000), (280, 1568))]:
            with self.subTest(size=size):
                image = self.inspect(helper.prepare_inference_jpeg(image_bytes(size)))
                self.assertEqual(image.size, expected)
                self.assertGreater(min(image.getpixel((0, 0))), 245)
                self.assertGreater(image.getpixel((image.width // 2, image.height // 2))[0], 240)
                self.assertLess(image.getpixel((image.width // 2, image.height // 2))[1], 20)

    def test_small_input_upscales_and_large_input_downscales_with_aspect(self):
        self.assertEqual(self.inspect(helper.prepare_inference_jpeg(image_bytes((100, 100)))).size, (280, 280))
        self.assertEqual(self.inspect(helper.prepare_inference_jpeg(image_bytes((2400, 1800)))).size, (1568, 1176))

    def test_transparent_png_is_composited_on_white(self):
        original = image_bytes((300, 300), mode='RGBA', color=(0, 0, 0, 0), format='PNG')
        output = self.inspect(helper.prepare_inference_jpeg(original))
        self.assertGreater(min(output.getpixel((150, 150))), 250)

    def test_noisy_large_image_obeys_byte_and_baseline_bounds(self):
        output = io.BytesIO()
        with Image.effect_noise((2000, 1600), 100) as noisy:
            noisy.convert('RGB').save(output, format='PNG')
        self.inspect(helper.prepare_inference_jpeg(output.getvalue()))

    def test_pixel_limit_is_checked_before_decode(self):
        source = image_bytes((300, 300))
        with patch.object(helper, 'MAX_DECODE_PIXELS', 50_000):
            with self.assertRaisesRegex(ValueError, 'decoded-pixel'):
                helper.prepare_inference_jpeg(source)

    def test_bad_unsupported_and_over_byte_inputs_are_rejected(self):
        for source in [b'', b'not an image', image_bytes(format='GIF')]:
            with self.subTest(length=len(source)), self.assertRaises(ValueError):
                helper.prepare_inference_jpeg(source)
        with patch.object(helper, 'MAX_INPUT_BYTES', 10):
            with self.assertRaisesRegex(ValueError, '32 MB'):
                helper.prepare_inference_jpeg(b'x' * 11)
        with self.assertRaises(TypeError):
            helper.prepare_inference_jpeg('path-is-not-bytes')

    def test_tighter_cap_cannot_be_relaxed_or_silently_exceeded(self):
        source = image_bytes((300, 300))
        for cap in [0, True, 2_500_001, 1.5]:
            with self.subTest(cap=cap), self.assertRaises(ValueError):
                helper.prepare_inference_jpeg(source, max_bytes=cap)
        with self.assertRaisesRegex(ValueError, 'byte bound'):
            helper.prepare_inference_jpeg(source, max_bytes=100)


if __name__ == '__main__':
    unittest.main()
