"""Offline JPEG byte-count diagnostics; no hardware or upstream HTTP calls."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


class CaptureSizeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.photos = tempfile.TemporaryDirectory()
        path = Path(__file__).resolve().parents[1] / 'frontend' / 'pi_camera_service.py'
        spec = importlib.util.spec_from_file_location('capture_size_service', path)
        cls.service = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {'PHOTOS_DIR': cls.photos.name}):
            spec.loader.exec_module(cls.service)
        cls.service.app.config['TESTING'] = True

    @classmethod
    def tearDownClass(cls):
        cls.photos.cleanup()

    def setUp(self):
        self.s = self.service
        self.s.latest_capture = None
        self.s.latest_capture_time = None
        self.s.capture_in_progress = False
        self.s.event_queue = []
        self.s.motion_enabled = True
        self.jpeg = b'\xff\xd8\xff\xe0offline-jpeg\x00\x80\xff\xd9'
        jpeg = self.jpeg

        class Camera:
            def capture_file(self, stream, format):
                assert format == 'jpeg'
                stream.write(jpeg)

        self.s.camera = Camera()
        self.client = self.s.app.test_client()
        self.network = patch.object(self.s.requests, 'post', side_effect=AssertionError('No network allowed'))
        self.post = self.network.start()
        self.addCleanup(self.network.stop)
        self.addCleanup(self.post.assert_not_called)

    def test_no_capture_has_null_size_and_image_is_404(self):
        self.assertIsNone(self.client.get('/api/status').json['latest_capture_bytes'])
        self.assertEqual(self.client.get('/api/latest-image').status_code, 404)

    def assert_image_size(self):
        self.assertEqual(self.client.get('/api/status').json['latest_capture_bytes'], len(self.jpeg))
        response = self.client.get('/api/latest-image')
        self.assertEqual(response.data, self.jpeg)
        self.assertEqual(response.content_length, len(self.jpeg))
        self.assertEqual(response.headers['X-Image-Bytes'], str(len(self.jpeg)))

    def test_manual_capture_reports_exact_bytes_without_changing_image(self):
        response = self.client.get('/api/capture')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['image_bytes'], len(self.jpeg))
        self.assert_image_size()

    def test_motion_capture_reports_exact_bytes_without_prediction(self):
        with patch.object(self.s.time, 'sleep', return_value=None):
            self.s.delayed_capture()
        self.assert_image_size()


if __name__ == '__main__':
    unittest.main()
