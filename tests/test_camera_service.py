"""Offline contracts for the shipped Flask camera service.

Run: PYTHONPATH=.test-deps python -m unittest discover -s tests -p test_camera_service.py -v
Hardware and outbound requests.post are mocked; Flask routes/generators are real.
The current service uses a single-consumer event_queue and multipart inference.
It does not implement replay/broadcast, capture reservations, timestamp headers,
or proxy-side policy/schema validation; those obsolete scratch assertions are absent.
"""
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


class FakeImage:
    def __init__(self, camera):
        self.camera = camera

    def save(self, stream, **kwargs):
        if self.camera.fail_save:
            self.camera.fail_save = False
            raise RuntimeError('JPEG encoding failed')
        stream.write(b'preview-frame')

    def close(self):
        self.camera.closed_images += 1


class FakeRequest:
    def __init__(self, camera):
        self.camera = camera
        self.released = False

    def make_image(self, name):
        if self.camera.fail_make:
            self.camera.fail_make = False
            raise RuntimeError('Buffer conversion failed')
        return FakeImage(self.camera)

    def release(self):
        if self.released:
            raise AssertionError('Buffer released twice')
        self.released = True
        self.camera.outstanding -= 1
        self.camera.released += 1


class FakeCamera:
    def __init__(self):
        self.outstanding = self.released = self.closed_images = self.capture_calls = 0
        self.fail_make = self.fail_save = self.fail_capture = False
        self.requests = []
        self.config = None
        self.started = False

    def create_video_configuration(self, **kwargs):
        return kwargs

    def configure(self, config):
        self.config = config

    def start(self):
        self.started = True

    def capture_request(self):
        self.outstanding += 1
        result = FakeRequest(self)
        self.requests.append(result)
        return result

    def capture_file(self, stream, format):
        if self.outstanding:
            raise AssertionError('Still capture starved by an unreleased preview buffer')
        self.capture_calls += 1
        if self.fail_capture:
            raise RuntimeError('Camera capture failed')
        stream.write(b'still-' + str(self.capture_calls).encode())


class FakeMotionSensor:
    def __init__(self, pin):
        self.pin = pin
        self.when_motion = self.when_no_motion = None


def decode_event(chunk):
    if isinstance(chunk, bytes):
        chunk = chunk.decode()
    values = {}
    for line in chunk.splitlines():
        key, _, value = line.partition(': ')
        if key == 'data':
            values[key] = json.loads(value)
        elif key == 'event':
            values[key] = value
    return values


class CameraServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.photos = tempfile.TemporaryDirectory()
        module_path = Path(__file__).resolve().parents[1] / 'frontend' / 'pi_camera_service.py'
        spec = importlib.util.spec_from_file_location('camera_service_under_test', module_path)
        cls.service = importlib.util.module_from_spec(spec)
        picamera = types.ModuleType('picamera2')
        picamera.Picamera2 = FakeCamera
        gpio = types.ModuleType('gpiozero')
        gpio.MotionSensor = FakeMotionSensor
        with patch.dict(sys.modules, {'picamera2': picamera, 'gpiozero': gpio}), patch.dict(os.environ, {'PHOTOS_DIR': cls.photos.name}):
            spec.loader.exec_module(cls.service)
        cls.service.app.config['TESTING'] = True

    @classmethod
    def tearDownClass(cls):
        cls.photos.cleanup()

    def setUp(self):
        self.s = self.service
        self.s.camera = FakeCamera()
        self.s.pir = None
        self.s.latest_capture = self.s.latest_capture_time = None
        self.s.capture_in_progress = self.s.motion_detected_flag = False
        self.s.motion_enabled = True
        self.s.event_queue.clear()
        self.client = self.s.app.test_client()
        # A forgotten network fixture must fail locally rather than contact inference.
        self.post = self.enterContext(patch.object(self.s.requests, 'post', side_effect=AssertionError('Unexpected outbound HTTP')))

    def history(self, name):
        return [event['data'] for event in self.s.event_queue if event['event'] == name]

    def predict_with_upstream(self, body=None, status=200, content_type='application/json', error=None):
        upstream = self.s.requests.Response()
        upstream.status_code = status
        upstream.headers['Content-Type'] = content_type
        upstream._content = body if isinstance(body, bytes) else json.dumps(body).encode('utf-8')
        self.post.side_effect = error
        self.post.return_value = upstream
        jpeg = b'\xff\xd8\xff\xe0JPEG-contract\x00\x80\xff\xd9'
        response = self.client.post('/api/predict', data={
            'file': (io.BytesIO(jpeg), 'pi-frame.jpg', 'image/jpeg'),
            'mode': 'hybrid',  # Caller cannot weaken the kiosk's exact mode.
        })
        return response, jpeg

    def test_real_hardware_initialization_wires_gpio_callbacks(self):
        self.assertTrue(self.s.init_hardware())
        self.assertTrue(self.s.camera.started)
        self.assertEqual(self.s.camera.config, {
            'main': {'size': (800, 480)}, 'lores': {'size': (640, 480)}, 'display': 'lores',
        })
        self.assertEqual(self.s.pir.pin, 17)
        self.assertEqual(self.s.pir.when_motion, self.s.on_motion_detected)
        self.assertEqual(self.s.pir.when_no_motion, self.s.on_motion_stopped)

    def test_predict_forwards_exact_multipart_preserving_jpeg_bytes(self):
        body = {'results': [{'item': 'Bottle', 'category': 'Blue Bin', 'instruction': 'Rinse first'}]}
        response, jpeg = self.predict_with_upstream(body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, body)
        self.post.assert_called_once_with(self.s.API_ENDPOINT,
            files={'file': ('pi-frame.jpg', jpeg, 'image/jpeg')}, data={'mode': 'exact'}, timeout=30)
        self.assertNotIn('json', self.post.call_args.kwargs)

    def test_predict_missing_file_rejected_without_network(self):
        response = self.client.post('/api/predict', json={'image': 'not multipart'})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json['error'], 'No file provided')
        self.post.assert_not_called()

    def test_predict_legacy_envelope_metadata_preserved(self):
        body = {'results': [{'item': 'Bottle', 'category': 'Blue Bin', 'instruction': 'Rinse first', 'confidence': 0.91}],
                'request_id': 'offline-contract', 'latency_ms': 123, 'policy_version': 'test-v1', 'status': 'accepted'}
        response, _ = self.predict_with_upstream(body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, body)

    def test_predict_modern_response_adds_legacy_row_without_losing_exact_fields(self):
        body = {'selected_item': 'Glass container', 'category': None, 'policy_category': 'Blue Bin',
                'instruction': 'Original text', 'instructions': ['Empty contents.'],
                'rule_evaluation': [{'state': 'check', 'text': 'Remove lid.'}],
                'match_probability': 0.875, 'status': 'needs_clarification',
                'identity_uncertain': True, 'policy_conditions_pending': True}
        response, _ = self.predict_with_upstream(body)
        self.assertEqual(response.status_code, 200)
        for key, value in body.items():
            self.assertEqual(response.json[key], value)
        self.assertEqual(response.json['results'], [{
            'item': 'Glass container', 'category': None, 'confidence': 0.875, 'instruction': 'Original text',
        }])

    def test_predict_item_name_alias_normalizes(self):
        response, _ = self.predict_with_upstream({'item_name': 'Bottle', 'category': 'Blue Bin'})
        self.assertEqual(response.json['results'][0]['item'], 'Bottle')

    def test_predict_review_flags_and_null_category_pass_through_for_frontend_adapter(self):
        # The information renderer, not this transparent proxy, owns review presentation.
        body = {'results': [{'item': 'Bottle', 'category': None}], 'policy_category': 'Blue Bin',
                'identity_uncertain': True, 'policy_conditions_pending': True, 'status': 'manual_review'}
        response, _ = self.predict_with_upstream(body)
        self.assertEqual(response.json, body)

    def test_predict_upstream_http_errors_pass_through(self):
        for status in (400, 429, 502):
            with self.subTest(status=status):
                response, _ = self.predict_with_upstream({'error': 'Upstream rejected image'}, status=status)
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json, {'error': 'Upstream rejected image'})

    def test_predict_non_json_error_preserves_status_body_and_content_type(self):
        response, _ = self.predict_with_upstream(b'upstream unavailable', status=503, content_type='text/plain')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.data, b'upstream unavailable')
        self.assertEqual(response.mimetype, 'text/plain')

    def test_predict_invalid_json_and_transport_exceptions_fail_explicitly(self):
        response, _ = self.predict_with_upstream(b'not valid JSON')
        self.assertEqual(response.status_code, 500)
        self.assertTrue(response.json['error'])
        for error in (self.s.requests.Timeout('Offline timeout'), self.s.requests.ConnectionError('Offline connection')):
            with self.subTest(error=error):
                response, _ = self.predict_with_upstream(error=error)
                self.assertEqual(response.status_code, 500)
                self.assertEqual(response.json['error'], str(error))

    def test_capture_endpoint_returns_fresh_image_and_base64_timestamp(self):
        self.assertEqual(self.client.get('/api/latest-image').status_code, 404)
        self.assertEqual(self.client.get('/api/latest-image-base64').status_code, 404)
        response = self.client.get('/api/capture')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json['success'])
        self.assertEqual(response.json['image_bytes'], len(b'still-1'))
        latest = self.client.get('/api/latest-image-base64')
        self.assertEqual(base64.b64decode(latest.json['image']), b'still-1')
        self.assertEqual(latest.json['timestamp'], response.json['timestamp'])
        image = self.client.get('/api/latest-image')
        self.assertEqual(image.data, b'still-1')
        self.assertEqual(image.mimetype, 'image/jpeg')
        self.assertEqual(int(image.headers['X-Image-Bytes']), len(image.data))
        status = self.client.get('/api/status').json
        self.assertTrue(status['has_capture'])
        self.assertEqual(status['latest_capture_bytes'], len(image.data))

    def test_capture_failure_preserves_previous_photo(self):
        self.client.get('/api/capture')
        timestamp = self.s.latest_capture_time
        self.s.camera.fail_capture = True
        response = self.client.get('/api/capture')
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json['error'], 'Camera capture failed')
        self.assertEqual(self.s.latest_capture_time, timestamp)
        self.assertEqual(self.s.latest_capture, b'still-1')
        self.s.camera.fail_capture = False
        self.assertEqual(self.client.get('/api/capture').status_code, 200)
        self.assertEqual(self.s.latest_capture, b'still-3')

    def test_paused_mjpeg_client_cannot_hold_buffer_or_starve_capture(self):
        response = self.client.get('/api/stream', buffered=False)
        self.addCleanup(response.close)
        self.assertIn(b'preview-frame', next(iter(response.response)))
        self.assertEqual(self.s.camera.outstanding, 0)
        self.assertEqual(self.s.camera.released, 1)
        self.assertEqual(self.s.camera.closed_images, 1)
        self.assertEqual(self.client.get('/api/capture').status_code, 200)
        response.close()
        self.assertTrue(self.s.camera_lock.acquire(blocking=False))
        self.s.camera_lock.release()

    def test_preview_conversion_and_encoding_failure_release_buffers_before_retry(self):
        for failure, closed_images in (('fail_make', 1), ('fail_save', 2)):
            with self.subTest(failure=failure):
                self.s.camera = FakeCamera()
                setattr(self.s.camera, failure, True)
                with patch.object(self.s.time, 'sleep', return_value=None):
                    response = self.client.get('/api/stream', buffered=False)
                    try:
                        self.assertIn(b'preview-frame', next(iter(response.response)))
                    finally:
                        response.close()
                self.assertEqual(self.s.camera.closed_images, closed_images)
                self.assertEqual(self.s.camera.released, 2)
                self.assertEqual(self.s.camera.outstanding, 0)
                self.assertTrue(all(buffer.released for buffer in self.s.camera.requests))

    def test_no_camera_routes_fail_explicitly(self):
        self.s.camera = None
        for route in ('/api/stream', '/api/capture'):
            response = self.client.get(route)
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json['error'], 'Camera not available')
        self.assertFalse(self.client.get('/api/status').json['camera_ready'])

    def test_motion_sequence_emits_countdown_and_already_captured_image_notification(self):
        with patch.object(self.s.time, 'sleep', return_value=None):
            self.s.delayed_capture()
        self.assertEqual([event['number'] for event in self.history('countdown')], [3, 2, 1, 0])
        self.assertEqual(self.history('motion_detected'), [{}])
        self.assertEqual(self.history('image_captured'), [{}])
        self.assertEqual(self.s.latest_capture, b'still-1')
        self.assertFalse(self.s.capture_in_progress)
        self.assertFalse(self.s.motion_enabled)

    def test_motion_failure_reports_message_restores_motion_and_can_retry(self):
        self.s.camera.fail_capture = True
        with patch.object(self.s.time, 'sleep', return_value=None):
            self.s.delayed_capture()
        self.assertEqual(self.history('capture_error'), [{'message': 'Camera capture failed'}])
        self.assertEqual(self.history('image_captured'), [])
        self.assertIsNone(self.s.latest_capture)
        self.assertFalse(self.s.capture_in_progress)
        self.assertTrue(self.s.motion_enabled)
        self.s.camera.fail_capture = False
        with patch.object(self.s.time, 'sleep', return_value=None):
            self.s.delayed_capture()
        self.assertEqual(self.history('image_captured'), [{}])

    def test_motion_no_camera_emits_terminal_error(self):
        self.s.camera = None
        with patch.object(self.s.time, 'sleep', return_value=None):
            self.s.delayed_capture()
        self.assertEqual([event['number'] for event in self.history('countdown')], [3, 2, 1, 0])
        self.assertEqual(self.history('capture_error'), [{'message': 'Camera not available'}])
        self.assertFalse(self.s.capture_in_progress)
        self.assertTrue(self.s.motion_enabled)

    def test_disabled_or_in_progress_motion_does_not_start_worker(self):
        self.client.post('/api/motion/disable')
        with patch.object(self.s.threading, 'Thread') as worker:
            self.s.on_motion_detected()
            worker.assert_not_called()
            self.client.post('/api/motion/enable')
            self.s.capture_in_progress = True
            self.s.on_motion_detected()
            worker.assert_not_called()
        self.s.delayed_capture()
        self.assertEqual(self.s.camera.capture_calls, 0)

    def test_sse_drains_current_queue_with_headers(self):
        self.s.event_queue.extend([
            {'event': 'countdown', 'data': {'number': 0}},
            {'event': 'image_captured', 'data': {}},
        ])
        response = self.client.get('/api/events', buffered=False)
        try:
            self.assertEqual(response.mimetype, 'text/event-stream')
            self.assertEqual(response.headers['X-Accel-Buffering'], 'no')
            self.assertEqual(response.headers['Cache-Control'], 'no-cache')
            iterator = iter(response.response)
            self.assertEqual(decode_event(next(iterator)), {'event': 'countdown', 'data': {'number': 0}})
            self.assertEqual(decode_event(next(iterator)), {'event': 'image_captured', 'data': {}})
            self.assertEqual(self.s.event_queue, [])
        finally:
            response.close()

    def test_sse_idle_heartbeat_without_real_sleep(self):
        with patch.object(self.s.time, 'time', side_effect=[0, 16, 16]), patch.object(self.s.time, 'sleep', return_value=None):
            response = self.client.get('/api/events', buffered=False)
            try:
                self.assertEqual(decode_event(next(iter(response.response))), {'event': 'heartbeat', 'data': {'time': 16}})
            finally:
                response.close()


if __name__ == '__main__':
    unittest.main()
