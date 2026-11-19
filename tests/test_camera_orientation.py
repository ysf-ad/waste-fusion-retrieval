"""Offline orientation/build contracts. Real Flask routes; no hardware/network."""
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SETTINGS = ('KIOSK_SCREEN_ROTATION', 'CAMERA_LIVE_ROTATION', 'CAMERA_CAPTURED_ROTATION',
            'CAMERA_LIVE_MIRROR', 'CAMERA_CAPTURED_MIRROR', 'FLIP_IMAGE', 'STATIC_DIR')


class CameraOrientationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def load(self, **environment):
        with patch.dict(os.environ, {'PHOTOS_DIR': self.temp.name}):
            for key in SETTINGS:
                os.environ.pop(key, None)
            os.environ.update(environment)
            spec = importlib.util.spec_from_file_location('orientation_service', ROOT / 'frontend/pi_camera_service.py')
            service = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(service)
        service.app.config['TESTING'] = True
        return service

    def test_default_configuration_preserves_legacy_screen_and_live_behavior(self):
        service = self.load()
        response = service.app.test_client().get('/api/config')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(response.json['orientation'], {'screen_rotation': 180, 'live_rotation': 180,
                         'captured_rotation': 0, 'live_mirror': False, 'captured_mirror': False})
        self.assertEqual(response.json['expected_brand'], 'Benny')

    def test_configured_display_settings_never_change_original_capture_or_upload(self):
        service = self.load(KIOSK_SCREEN_ROTATION='0', CAMERA_LIVE_ROTATION='90',
                            CAMERA_CAPTURED_ROTATION='270', CAMERA_LIVE_MIRROR='true', CAMERA_CAPTURED_MIRROR='true')
        jpeg = b'\xff\xd8\xff\xe0unchanged-original\x00\xff\xd9'

        class Camera:
            def capture_file(self, stream, format):
                self.assert_format = format
                stream.write(jpeg)

        service.camera = Camera()
        client = service.app.test_client()
        self.assertEqual(client.get('/api/capture').status_code, 200)
        self.assertEqual(client.get('/api/latest-image').data, jpeg)
        upstream = service.requests.Response()
        upstream.status_code = 200
        upstream.headers['Content-Type'] = 'application/json'
        upstream._content = b'{"selected_item":"can","category":"Blue Bin"}'
        with patch.object(service.requests, 'post', return_value=upstream) as post:
            self.assertEqual(client.post('/api/predict', data={'file': (io.BytesIO(jpeg), 'original.jpg', 'image/jpeg')}).status_code, 200)
            self.assertEqual(post.call_args.kwargs['files']['file'][1], jpeg)
            self.assertEqual(post.call_args.kwargs['data'], {'mode': 'exact'})
        self.assertEqual(service.camera.assert_format, 'jpeg')

    def test_legacy_flip_migrates_only_to_captured_mirror_and_can_be_overridden(self):
        self.assertTrue(self.load(FLIP_IMAGE='true').ORIENTATION['captured_mirror'])
        service = self.load(FLIP_IMAGE='true', CAMERA_CAPTURED_MIRROR='false')
        self.assertFalse(service.ORIENTATION['captured_mirror'])
        self.assertFalse(service.ORIENTATION['live_mirror'])

    def test_bad_environment_values_fail_early_instead_of_guessing_calibration(self):
        for key, value in [('KIOSK_SCREEN_ROTATION', '90'), ('CAMERA_LIVE_ROTATION', '45'),
                           ('CAMERA_CAPTURED_ROTATION', 'abc'), ('CAMERA_LIVE_MIRROR', 'yes')]:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, key):
                self.load(**{key: value})

    def test_build_endpoint_hashes_real_served_assets_not_a_claimed_browser_version(self):
        service = self.load(KIOSK_UI_BUILD='offline-test-build')
        response = service.app.test_client().get('/api/ui-build')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(response.json['ui_build'], 'offline-test-build')
        self.assertEqual(response.json['expected_brand'], 'Benny')
        for name, digest in response.json['asset_sha256'].items():
            self.assertEqual(digest, hashlib.sha256((Path(service.STATIC_DIR) / name).read_bytes()).hexdigest())
        self.assertEqual(len(response.json['asset_set_sha256']), 64)
        self.assertNotIn(str(ROOT), response.get_data(as_text=True))

    def test_missing_asset_is_explicit_and_assets_are_rehashed_after_edit(self):
        service = self.load(STATIC_DIR=self.temp.name)
        client = service.app.test_client()
        before = client.get('/api/ui-build').json
        self.assertTrue(all(value is None for value in before['asset_sha256'].values()))
        asset = Path(self.temp.name) / 'index.html'
        asset.write_bytes(b'Benny test')
        after = client.get('/api/ui-build').json
        self.assertEqual(after['asset_sha256']['index.html'], hashlib.sha256(b'Benny test').hexdigest())
        self.assertNotEqual(after['asset_set_sha256'], before['asset_set_sha256'])


if __name__ == '__main__':
    unittest.main()
