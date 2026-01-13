"""
Raspberry Pi Camera Service with People Detection
Integrates with the Waste Classifier frontend and API
Uses YOLOv8 for real-time people detection
"""

import os
import time
import io
import base64
import json
import threading
import numpy as np
from flask import Flask, Response, jsonify, send_file
from flask_cors import CORS

# Try to import Pi-specific libraries (will fail on non-Pi systems)
try:
    from picamera2 import Picamera2
    PI_AVAILABLE = True
except ImportError:
    PI_AVAILABLE = False
    print("Warning: Running without Pi hardware support (picamera2 not available)")

# Import YOLOv8 for people detection
try:
    from ultralytics import YOLO
    YOLO_AVAILABLE = True
except ImportError:
    YOLO_AVAILABLE = False
    print("Warning: YOLOv8 not available (install with: pip install ultralytics)")

# --- Configuration ---
PEOPLE_DETECTION_THRESHOLD = 0.5  # Confidence threshold for people detection
CAPTURE_DELAY = 2        # Seconds to wait after person detected before capturing
DETECTION_COOLDOWN = 10  # Seconds between captures to avoid spam
API_ENDPOINT = os.getenv('API_ENDPOINT', 'https://api.biswa.ca/predict')
STATIC_DIR = '/app/static'

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path='')
CORS(app)

# Global state
camera = None
yolo_model = None
latest_capture = None
latest_capture_time = None
person_detected_flag = False
capture_in_progress = False
last_capture_time = 0
detection_thread = None
stream_enabled = True


def init_hardware():
    """Initialize camera and YOLOv8 model"""
    global camera, yolo_model
    
    if not PI_AVAILABLE:
        print("Pi camera hardware not available, running in demo mode")
    
    if not YOLO_AVAILABLE:
        print("YOLOv8 not available, people detection will be disabled")
        return False
    
    try:
        # Initialize camera
        if PI_AVAILABLE:
            camera = Picamera2()
            camera_config = camera.create_still_configuration(
                main={"size": (1280, 720)}
            )
            camera.configure(camera_config)
            camera.start()
            print("Camera initialized successfully")
        
        # Load YOLOv8 model for people detection
        print("Loading YOLOv8 model for people detection...")
        yolo_model = YOLO('yolov8n.pt')  # nano model for faster inference on Pi
        print("YOLOv8 model loaded successfully")
        
        # Start detection thread
        threading.Thread(target=continuous_people_detection, daemon=True).start()
        print("People detection thread started")
        
        return True
    except Exception as e:
        print(f"Failed to initialize hardware: {e}")
        return False


def detect_people_in_frame(frame_array):
    """Detect people in a frame using YOLOv8"""
    if yolo_model is None:
        return False, 0
    
    try:
        # Run inference
        results = yolo_model(frame_array, conf=PEOPLE_DETECTION_THRESHOLD, verbose=False)
        
        # Check if people (class 0) were detected
        person_detected = False
        max_confidence = 0
        
        for result in results:
            for detection in result.boxes:
                class_id = int(detection.cls)
                confidence = float(detection.conf)
                
                # Class 0 in COCO is 'person'
                if class_id == 0:
                    person_detected = True
                    max_confidence = max(max_confidence, confidence)
        
        return person_detected, max_confidence
    except Exception as e:
        print(f"Error detecting people: {e}")
        return False, 0


def continuous_people_detection():
    """Continuous thread for detecting people in the video stream"""
    global person_detected_flag, camera, latest_capture, latest_capture_time, last_capture_time
    
    while stream_enabled:
        try:
            if not camera or not yolo_model:
                time.sleep(1)
                continue
            
            # Capture frame
            stream = io.BytesIO()
            camera.capture_file(stream, format='jpeg')
            stream.seek(0)
            frame_bytes = stream.getvalue()
            
            # Convert to numpy array for YOLO
            from PIL import Image
            frame_image = Image.open(io.BytesIO(frame_bytes))
            frame_array = np.array(frame_image)
            
            # Detect people
            person_detected, confidence = detect_people_in_frame(frame_array)
            
            if person_detected:
                person_detected_flag = True
                print(f"Person detected! Confidence: {confidence:.2f}")
                
                # Trigger capture if cooldown has passed
                current_time = time.time()
                if current_time - last_capture_time >= DETECTION_COOLDOWN:
                    if not capture_in_progress:
                        threading.Thread(target=delayed_capture).start()
                    last_capture_time = current_time
            else:
                person_detected_flag = False
            
            time.sleep(0.1)  # ~10 FPS detection
        except Exception as e:
            print(f"Error in detection thread: {e}")
            time.sleep(1)


def delayed_capture():
    """Wait for CAPTURE_DELAY seconds then capture image"""
    global capture_in_progress, latest_capture, latest_capture_time
    
    if capture_in_progress:
        return
    
    capture_in_progress = True
    print(f"Waiting {CAPTURE_DELAY} seconds before capture...")
    time.sleep(CAPTURE_DELAY)
    
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
        'yolo_available': YOLO_AVAILABLE,
        'person_detected': person_detected_flag,
        'capture_in_progress': capture_in_progress,
        'has_capture': latest_capture is not None,
        'capture_delay': CAPTURE_DELAY,
        'detection_cooldown': DETECTION_COOLDOWN,
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
        'detection_cooldown': DETECTION_COOLDOWN,
        'detection_threshold': PEOPLE_DETECTION_THRESHOLD,
        'api_endpoint': API_ENDPOINT
    })


if __name__ == '__main__':
    print("Starting Waste Classifier Pi Camera Service with People Detection...")
    print(f"Capture delay: {CAPTURE_DELAY} seconds")
    print(f"Detection cooldown: {DETECTION_COOLDOWN} seconds")
    print(f"Detection threshold: {PEOPLE_DETECTION_THRESHOLD}")
    print(f"API endpoint: {API_ENDPOINT}")
    
    # Initialize hardware
    init_hardware()
    
    # Start Flask server
    app.run(host='0.0.0.0', port=80, threaded=True)
