"""SOFTWARE-ONLY preview: fake Pi hardware, actual unchanged Flask/UI and local Worker.

Run from repository root (start preview-worker.mjs separately):
  $env:PYTHONPATH='.test-deps'
  $env:E2E_IMAGE='C:/absolute/path/to/existing-can.jpg'
  python tests/preview-camera.py

Serves only 127.0.0.1:18775. Still captures copy the exact supplied JPEG bytes;
preview frames may be re-encoded by the real service. No hardware/accuracy claims,
cloud calls, credentials or paid inference. Photos are saved only in a tempdir.
"""
import atexit
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile
import threading
import types
from unittest.mock import patch

import requests
from flask import jsonify
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
WORKER_ENDPOINT = 'http://127.0.0.1:18776/predict'


def create_preview(image_path=None):
    raw_path = image_path or os.environ.get('E2E_IMAGE')
    if not raw_path or not Path(raw_path).is_absolute():
        raise ValueError('E2E_IMAGE must be an absolute path to an existing JPEG')
    jpeg = Path(raw_path).read_bytes()
    with Image.open(io.BytesIO(jpeg)) as image:
        if image.format != 'JPEG':
            raise ValueError('E2E_IMAGE must contain a real JPEG (no conversion is performed)')
        image.verify()
    photo_dir = tempfile.TemporaryDirectory(prefix='software-only-preview-')
    state = {'software_only': True, 'captures': 0, 'capture_attempts': 0,
             'held_requests': 0, 'released_requests': 0, 'preview_frames': 0,
             'predictions': 0, 'blocked_outbound': 0, 'fail_next': False,
             'image_sha256': hashlib.sha256(jpeg).hexdigest(), 'image_bytes': len(jpeg)}
    lock = threading.Lock()

    class CameraRequest:
        def __init__(self):
            self.released = False

        def make_image(self, *args, **kwargs):
            return Image.open(io.BytesIO(jpeg))

        def release(self):
            with lock:
                if not self.released:
                    self.released = True
                    state['held_requests'] -= 1
                    state['released_requests'] += 1

    class Camera:
        def create_video_configuration(self, **kwargs):
            state['camera_configuration'] = kwargs
            return kwargs

        def configure(self, config):
            pass

        def start(self):
            pass

        def stop(self):
            pass

        def close(self):
            pass

        def capture_request(self):
            with lock:
                state['held_requests'] += 1
                state['preview_frames'] += 1
            return CameraRequest()

        def capture_file(self, stream, format='jpeg'):
            with lock:
                state['capture_attempts'] += 1
                if state['held_requests']:
                    raise RuntimeError('Preview holds a camera buffer during capture')
                if state['fail_next']:
                    state['fail_next'] = False
                    raise RuntimeError('Software fixture: emulated camera disconnected')
                if format.lower() != 'jpeg':
                    raise ValueError('Software fixture supports unchanged JPEG capture only')
                state['captures'] += 1
            stream.write(jpeg)

    class MotionSensor:
        def __init__(self, pin):
            state['motion_pin'] = pin
            self.when_motion = None
            self.when_no_motion = None

    fake_camera = types.ModuleType('picamera2')
    fake_camera.Picamera2 = Camera
    fake_gpio = types.ModuleType('gpiozero')
    fake_gpio.MotionSensor = MotionSensor
    # Force software hardware even when executed on a real Pi. STATIC_DIR is not
    # overridden: the actual service's bundled frontend is served unchanged.
    with patch.dict(sys.modules, {'picamera2': fake_camera, 'gpiozero': fake_gpio}), patch.dict(
            os.environ, {'API_ENDPOINT': WORKER_ENDPOINT, 'PHOTOS_DIR': photo_dir.name}):
        os.environ.pop('STATIC_DIR', None)
        spec = importlib.util.spec_from_file_location('software_preview_camera_service', ROOT / 'frontend/pi_camera_service.py')
        service = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = service
        spec.loader.exec_module(service)
    if not service.init_hardware():
        photo_dir.cleanup()
        raise RuntimeError('Software hardware initialization failed')

    original_request = requests.sessions.Session.request

    def local_only_request(session, method, url, **kwargs):
        # Exact destination/method allowlist; reject redirects and environment
        # proxies so no cloud endpoint can be reached by this Flask process.
        if str(method).upper() != 'POST' or str(url) != WORKER_ENDPOINT:
            state['blocked_outbound'] += 1
            raise RuntimeError('Software preview blocks outbound requests except local Worker /predict')
        session.trust_env = False
        kwargs['allow_redirects'] = False
        kwargs['proxies'] = {}
        state['predictions'] += 1
        return original_request(session, method, url, **kwargs)

    network_guard = patch.object(requests.sessions.Session, 'request', local_only_request)
    network_guard.start()

    @service.app.get('/__test__/state')
    def fixture_state():
        with lock:
            snapshot = dict(state)
        snapshot.update(capture_in_progress=service.capture_in_progress,
                        motion_enabled=service.motion_enabled,
                        queued_events=len(service.event_queue))
        return jsonify(snapshot)

    @service.app.post('/__test__/motion')
    def fixture_motion():
        service.pir.when_motion()
        return jsonify(software_only=True, ok=True)

    @service.app.post('/__test__/fail-capture')
    def fixture_fail_capture():
        with lock:
            state['fail_next'] = True
        return jsonify(software_only=True, ok=True)

    cleaned = False

    def cleanup():
        nonlocal cleaned
        if not cleaned:
            cleaned = True
            network_guard.stop()
            photo_dir.cleanup()
            sys.modules.pop(spec.name, None)

    atexit.register(cleanup)
    return service, state, cleanup


if __name__ == '__main__':
    service, state, cleanup = create_preview()
    print('SOFTWARE ONLY: unchanged Flask/UI at http://127.0.0.1:18775; fake camera + local Worker; no paid inference', flush=True)
    try:
        service.app.run(host='127.0.0.1', port=18775, threaded=True, use_reloader=False)
    finally:
        cleanup()
