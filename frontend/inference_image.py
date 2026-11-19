"""Bounded, standalone inference-copy preparation; NOT wired into Flask routes.

prepare_inference_jpeg(original_bytes) returns a new baseline JPEG. It never
writes files or applies installation screen/camera mirror/rotation settings.
Only the source file's EXIF orientation is honored. Keep original bytes for
photo preview/download/storage. Requires Pillow.
"""
import io
import warnings
from PIL import Image, ImageOps, UnidentifiedImageError

MIN_SIDE = 280
MAX_SIDE = 1568
MAX_JPEG_BYTES = 2_500_000
MAX_INPUT_BYTES = 32_000_000
MAX_DECODE_PIXELS = 24_000_000


def prepare_inference_jpeg(original_bytes, *, max_bytes=MAX_JPEG_BYTES):
    """Return RGB baseline JPEG, 280–1568 per axis, bounded to <=2.5 MB.

    Aspect ratio is preserved by resizing; extreme ratios get centered white
    padding rather than distortion/cropping. Reject invalid/oversized decodes
    before loading pixels. max_bytes may tighten, never relax, the output cap.
    """
    if not isinstance(original_bytes, (bytes, bytearray, memoryview)):
        raise TypeError('Image input must be bytes')
    if not original_bytes or len(original_bytes) > MAX_INPUT_BYTES:
        raise ValueError('Image input is empty or exceeds the 32 MB input bound')
    if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or not 0 < max_bytes <= MAX_JPEG_BYTES:
        raise ValueError('max_bytes must be a positive integer no larger than 2500000')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(original_bytes)) as source:
                if source.format not in ('JPEG', 'PNG'):
                    raise ValueError('Use a JPEG or PNG source image')
                width, height = source.size
                if width <= 0 or height <= 0 or width * height > MAX_DECODE_PIXELS:
                    raise ValueError('Source image exceeds the 24 million decoded-pixel bound')
                if getattr(source, 'n_frames', 1) != 1:
                    raise ValueError('Animated/multi-frame images are not supported')
                source.load()
                oriented = ImageOps.exif_transpose(source)
                try:
                    if oriented.mode in ('RGBA', 'LA') or 'transparency' in oriented.info:
                        rgba = oriented.convert('RGBA')
                        rgb = Image.new('RGB', oriented.size, 'white')
                        try:
                            rgb.paste(rgba, mask=rgba.getchannel('A'))
                        finally:
                            rgba.close()
                    else:
                        rgb = oriented.convert('RGB')
                finally:
                    oriented.close()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise ValueError('Invalid, truncated or oversized source image') from error

    try:
        width, height = rgb.size
        scale = min(max(1.0, MIN_SIDE / min(width, height)), MAX_SIDE / max(width, height))
        size = (max(1, min(MAX_SIDE, round(width * scale))), max(1, min(MAX_SIDE, round(height * scale))))
        resized = rgb.resize(size, Image.Resampling.LANCZOS)
        try:
            padded = Image.new('RGB', (max(MIN_SIDE, size[0]), max(MIN_SIDE, size[1])), 'white')
            try:
                padded.paste(resized, ((padded.width - size[0]) // 2, (padded.height - size[1]) // 2))
                # A bounded number of encodes, no retry/inference or metadata copies.
                for quality in (90, 85, 80, 75, 65, 55, 45):
                    output = io.BytesIO()
                    padded.save(output, format='JPEG', quality=quality, optimize=True, progressive=False)
                    data = output.getvalue()
                    if len(data) <= max_bytes:
                        return data
                raise ValueError('Could not encode within the requested JPEG byte bound')
            finally:
                padded.close()
        finally:
            resized.close()
    finally:
        rgb.close()
