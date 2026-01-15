"""
Raspberry Pi Camera Service with Motion Detection
Integrates with the Waste Classifier frontend and API
"""

import os
import time
import io
import base64
import json
import threading
import requests
from flask import Flask, Response, jsonify, send_file, request
from flask_cors import CORS

# Try to import Pi-specific libraries (will fail on non-Pi systems)
try:
    from picamera2 import Picamera2
    from gpiozero import MotionSensor
    PI_AVAILABLE = True
except ImportError:
    PI_AVAILABLE = False
    print("Warning: Running without Pi hardware support (picamera2/gpiozero not available)")

# --- Configuration ---
MOTION_SENSOR_PIN = 17  # GPIO pin for motion sensor
CAPTURE_DELAY = 3     # Seconds to wait after motion before capturing
API_ENDPOINT = os.getenv('API_ENDPOINT', 'https://api.biswa.ca/predict')

# Use environment variable or default to local directory
STATIC_DIR = os.getenv('STATIC_DIR', os.path.join(os.path.dirname(__file__), 'static'))

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path='')
CORS(app)

# Global state
camera = None
pir = None
latest_capture = None
latest_capture_time = None
motion_detected_flag = False
capture_in_progress = False


def init_hardware():
    """Initialize camera and motion sensor"""
    global camera, pir
    
    if not PI_AVAILABLE:
        print("Pi hardware not available, running in demo mode")
        return False
    
    try:
        # Initialize camera
        camera = Picamera2()
        # Configure for both preview and still capture
        camera_config = camera.create_video_configuration(
            main={"size": (800, 480)},
            lores={"size": (640, 480)},
            display="lores"
        )
        camera.configure(camera_config)
        camera.start()
        print("Camera initialized successfully")
        
        # Initialize motion sensor
        pir = MotionSensor(MOTION_SENSOR_PIN)
        pir.when_motion = on_motion_detected
        pir.when_no_motion = on_motion_stopped
        print(f"Motion sensor initialized on GPIO {MOTION_SENSOR_PIN}")
        
        return True
    except Exception as e:
        print(f"Failed to initialize hardware: {e}")
        return False


def on_motion_detected():
    """Callback when motion is detected"""
    global motion_detected_flag
    motion_detected_flag = True
    print("Motion detected!")
    
    # Start capture sequence in a separate thread
    if not capture_in_progress:
        threading.Thread(target=delayed_capture).start()


def on_motion_stopped():
    """Callback when motion stops"""
    global motion_detected_flag
    motion_detected_flag = False
    print("Motion stopped")


def delayed_capture():
    """Wait for CAPTURE_DELAY seconds then countdown and capture image"""
    global capture_in_progress, latest_capture, latest_capture_time
    
    if capture_in_progress:
        return
    
    capture_in_progress = True
    print(f"Waiting {CAPTURE_DELAY} seconds before countdown...")
    time.sleep(CAPTURE_DELAY)
    
    # Countdown 3, 2, 1
    print("Countdown: 3...")
    time.sleep(1)
    print("Countdown: 2...")
    time.sleep(1)
    print("Countdown: 1...")
    time.sleep(1)
    print("Capturing now!")
    
    try:
        if camera:
            # Capture to bytes
            stream = io.BytesIO()
            camera.capture_file(stream, format='jpeg')
            stream.seek(0)
            latest_capture = stream.getvalue()
            latest_capture_time = time.time()
            print("Image captured successfully")
    except Exception as e:
        print(f"Capture failed: {e}")
    finally:
        capture_in_progress = False


@app.route('/')
def index():
    """Serve the main page"""
    return send_file(os.path.join(STATIC_DIR, 'index.html'))


@app.route('/api/status')
def status():
    """Get current system status"""
    return jsonify({
        'pi_available': PI_AVAILABLE,
        'camera_ready': camera is not None,
        'motion_sensor_ready': pir is not None,
        'motion_detected': motion_detected_flag,
        'capture_in_progress': capture_in_progress,
        'has_capture': latest_capture is not None,
        'capture_delay': CAPTURE_DELAY,
        'api_endpoint': API_ENDPOINT
    })


@app.route('/api/capture')
def manual_capture():
    """Manually trigger a capture"""
    global latest_capture, latest_capture_time
    
    if not camera:
        return jsonify({'error': 'Camera not available'}), 503
    
    try:
        stream = io.BytesIO()
        camera.capture_file(stream, format='jpeg')
        stream.seek(0)
        latest_capture = stream.getvalue()
        latest_capture_time = time.time()
        
        return jsonify({
            'success': True,
            'message': 'Image captured',
            'timestamp': latest_capture_time
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/latest-image')
def get_latest_image():
    """Get the latest captured image"""
    if latest_capture is None:
        return jsonify({'error': 'No image captured yet'}), 404
    
    return Response(latest_capture, mimetype='image/jpeg')


@app.route('/api/latest-image-base64')
def get_latest_image_base64():
    """Get the latest captured image as base64"""
    if latest_capture is None:
        return jsonify({'error': 'No image captured yet'}), 404
    
    b64_image = base64.b64encode(latest_capture).decode('utf-8')
    return jsonify({
        'image': b64_image,
        'timestamp': latest_capture_time
    })


@app.route('/api/stream')
def video_stream():
    """Stream video from camera (MJPEG)"""
    if not camera:
        return jsonify({'error': 'Camera not available'}), 503
    
    def generate():
        while True:
            stream = io.BytesIO()
            camera.capture_file(stream, format='jpeg')
            stream.seek(0)
            frame = stream.getvalue()
            
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n')
            time.sleep(0.1)  # ~10 FPS
    
    return Response(generate(), mimetype='multipart/x-mixed-replace; boundary=frame')


@app.route('/api/config', methods=['GET'])
def get_config():
    """Get current configuration"""
    return jsonify({
        'capture_delay': CAPTURE_DELAY,
        'motion_sensor_pin': MOTION_SENSOR_PIN,
        'api_endpoint': API_ENDPOINT
    })


@app.route('/api/predict', methods=['POST'])
def predict_proxy():
    """Proxy prediction requests to avoid CORS issues"""
    import requests
    
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    
    file = request.files['file']
    
    try:
        # Forward the file to the actual API
        files = {'file': (file.filename, file.stream, file.content_type)}
        response = requests.post(API_ENDPOINT, files=files, timeout=30)
        
        # Return the API response
        return Response(
            response.content,
            status=response.status_code,
            content_type=response.headers.get('Content-Type', 'application/json')
        )
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    print("Starting Waste Classifier Pi Camera Service...")
    print(f"Capture delay: {CAPTURE_DELAY} seconds")
    print(f"Motion sensor pin: GPIO {MOTION_SENSOR_PIN}")
    print(f"API endpoint: {API_ENDPOINT}")
    
    # Initialize hardware
    init_hardware()
    
    # Start Flask server
    app.run(host='0.0.0.0', port=8000, threaded=True)
