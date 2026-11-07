"""Independent, offline checks of the minimal Pi countdown fix and legacy API wire format."""
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch


class CountdownFixTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.photos = tempfile.TemporaryDirectory()
        path = Path(__file__).resolve().parents[1] / 'frontend' / 'pi_camera_service.py'
        spec = importlib.util.spec_from_file_location('minimal_pi_under_test', path)
        cls.service = importlib.util.module_from_spec(spec)
        camera_module, gpio_module = types.ModuleType('picamera2'), types.ModuleType('gpiozero')
        camera_module.Picamera2, gpio_module.MotionSensor = Mock(), Mock()
        with patch.dict(sys.modules, picamera2=camera_module, gpiozero=gpio_module), \
                patch.dict(os.environ, PHOTOS_DIR=cls.photos.name):
            spec.loader.exec_module(cls.service)
        cls.service.app.config['TESTING'] = True

    @classmethod
    def tearDownClass(cls):
        cls.photos.cleanup()

    def setUp(self):
        self.s = self.service
        self.camera = self.s.camera = Mock()
        self.jpeg = b'\xff\xd8Pi-camera-contract\x00\x80\xff\xd9'
        self.camera.capture_file.side_effect = lambda stream, format: stream.write(self.jpeg)
        self.s.latest_capture = self.s.latest_capture_time = None
        self.s.capture_in_progress = False
        self.s.motion_enabled = True
        self.s.event_queue = []
        self.client = self.s.app.test_client()
        blocker = patch.object(self.s.requests, 'post', side_effect=AssertionError('Network forbidden'))
        self.http = blocker.start()
        self.addCleanup(blocker.stop)

    def test_original_picamera_configuration_and_gpio_are_preserved(self):
        with patch.object(self.s, 'Picamera2', return_value=self.camera), \
                patch.object(self.s, 'MotionSensor', return_value=Mock()) as sensor:
            self.assertTrue(self.s.init_hardware())
        self.camera.create_video_configuration.assert_called_once_with(
            main={'size': (800, 480)}, lores={'size': (640, 480)}, display='lores')
        self.camera.configure.assert_called_once_with(self.camera.create_video_configuration.return_value)
        self.camera.start.assert_called_once_with()
        sensor.assert_called_once_with(17)
        self.assertEqual(self.s.pir.when_motion, self.s.on_motion_detected)
        self.assertEqual(self.s.pir.when_no_motion, self.s.on_motion_stopped)

    def test_motion_countdown_ends_at_zero_and_publishes_fresh_jpeg(self):
        self.assertEqual(self.client.get('/api/latest-image').status_code, 404)
        with patch.object(self.s.time, 'sleep'):
            self.s.delayed_capture()
        events = self.s.event_queue
        self.assertEqual([e['data']['number'] for e in events if e['event'] == 'countdown'], [3, 2, 1, 0])
        self.assertEqual(events[0]['event'], 'motion_detected')
        self.assertEqual(events[-1]['event'], 'image_captured')
        self.assertEqual(self.client.get('/api/latest-image').data, self.jpeg)
        self.assertIsNotNone(self.s.latest_capture_time)
        self.assertFalse(self.s.capture_in_progress)
        self.assertFalse(self.s.motion_enabled)
        self.assertEqual(self.camera.capture_file.call_count, 1)
        self.assertEqual(self.camera.capture_file.call_args.kwargs, {'format': 'jpeg'})

    def test_motion_failure_and_absent_camera_emit_error_and_reset(self):
        for camera in (self.camera, None):
            with self.subTest(camera_available=camera is not None):
                self.s.camera, self.s.event_queue = camera, []
                self.camera.capture_file.side_effect = RuntimeError('Camera failed')
                with patch.object(self.s.time, 'sleep'):
                    self.s.delayed_capture()
                events = self.s.event_queue
                self.assertEqual([e['data']['number'] for e in events if e['event'] == 'countdown'], [3, 2, 1, 0])
                self.assertEqual(events[-1]['event'], 'capture_error')
                self.assertTrue(events[-1]['data'])
                self.assertNotIn('image_captured', [e['event'] for e in events])
                self.assertFalse(self.s.capture_in_progress)
                self.assertTrue(self.s.motion_enabled)
                self.assertEqual(self.client.get('/api/latest-image').status_code, 404)

    def test_manual_capture_uses_original_jpeg_signature_and_returns_fresh_image(self):
        response = self.client.get('/api/capture')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json['success'])
        self.assertEqual(response.json['timestamp'], self.s.latest_capture_time)
        self.assertEqual(self.client.get('/api/latest-image').data, self.jpeg)
        self.assertEqual(self.camera.capture_file.call_args.kwargs, {'format': 'jpeg'})
        self.assertEqual(self.camera.capture_file.call_args.args[0].getvalue(), self.jpeg)

    def preview_request(self, fail=False):
        request, image = Mock(), Mock()
        request.make_image.return_value = image
        def save(stream, **kwargs):
            self.assertEqual(kwargs, {'format': 'JPEG', 'quality': 85})
            if fail:
                raise RuntimeError('Encoding failed')
            stream.write(b'preview-jpeg')
        image.save.side_effect = save
        return request, image

    def test_preview_releases_request_and_closes_image_before_yield(self):
        request, image = self.preview_request()
        self.camera.capture_request.return_value = request
        response = self.client.get('/api/stream', buffered=False)
        self.addCleanup(response.close)
        self.assertIn(b'preview-jpeg', next(iter(response.response)))
        request.make_image.assert_called_once_with('main')
        request.release.assert_called_once_with()
        image.close.assert_called_once_with()
        self.assertTrue(self.s.camera_lock.acquire(blocking=False))
        self.s.camera_lock.release()

    def test_preview_encoding_failure_releases_before_retry(self):
        failed, bad_image = self.preview_request(fail=True)
        good, good_image = self.preview_request()
        self.camera.capture_request.side_effect = [failed, good]
        with patch.object(self.s.time, 'sleep'):
            response = self.client.get('/api/stream', buffered=False)
        self.addCleanup(response.close)
        self.assertIn(b'preview-jpeg', next(iter(response.response)))
        for request, image in ((failed, bad_image), (good, good_image)):
            request.release.assert_called_once_with()
            image.close.assert_called_once_with()

    def proxy(self, body, status=200):
        upstream = self.s.requests.Response()
        upstream.status_code = status
        upstream.headers['Content-Type'] = 'application/json'
        upstream._content = json.dumps(body).encode()
        self.http.side_effect, self.http.return_value = None, upstream
        return self.client.post('/api/predict', data={'file': (io.BytesIO(self.jpeg), 'pi.jpg', 'image/jpeg')})

    def test_remote_proxy_preserves_multipart_jpeg_exact_mode_and_legacy_schema(self):
        body = {'results': [{'item': 'Bottle', 'category': 'Blue Bin', 'instruction': 'Rinse'}], 'request_id': 'offline'}
        response = self.proxy(body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, body)
        self.http.assert_called_once_with(self.s.API_ENDPOINT,
            files={'file': ('pi.jpg', self.jpeg, 'image/jpeg')}, data={'mode': 'exact'}, timeout=30)
        self.assertNotIn('json', self.http.call_args.kwargs)

    def test_remote_proxy_normalizes_existing_modern_item_schema(self):
        for key in ('selected_item', 'item_name'):
            with self.subTest(key=key):
                response = self.proxy({key: 'Metal bowl', 'category': 'Recycling',
                                       'match_probability': 0.9, 'instruction': 'Empty first'})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json['results'], [{'item': 'Metal bowl', 'category': 'Recycling',
                                                            'confidence': 0.9, 'instruction': 'Empty first'}])

    def test_remote_upstream_http_error_is_preserved(self):
        response = self.proxy({'error': 'Rate limited'}, status=429)
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json, {'error': 'Rate limited'})


if __name__ == '__main__':
    unittest.main()
