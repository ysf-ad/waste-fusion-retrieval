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
from datetime import datetime

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
FLIP_IMAGE = os.getenv('FLIP_IMAGE', 'false').lower() == 'true'

# Use environment variable or default to local directory
STATIC_DIR = os.getenv('STATIC_DIR', os.path.join(os.path.dirname(__file__), 'static'))

# Photo storage configuration
PHOTOS_DIR = os.getenv('PHOTOS_DIR', os.path.join(os.path.dirname(__file__), 'photos'))
os.makedirs(PHOTOS_DIR, exist_ok=True)
os.makedirs(os.path.join(PHOTOS_DIR, 'originals'), exist_ok=True)
os.makedirs(os.path.join(PHOTOS_DIR, 'metadata'), exist_ok=True)

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path='')
CORS(app)

# Global state
camera = None
pir = None
latest_capture = None
latest_capture_time = None
motion_detected_flag = False
capture_in_progress = False
event_queue = []  # Queue for SSE events
motion_enabled = True  # Flag to enable/disable motion detection


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
    global motion_detected_flag, motion_enabled
    
    if not motion_enabled:
        return  # Ignore motion when disabled
    
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
    """Countdown and capture image immediately when motion detected"""
    global capture_in_progress, latest_capture, latest_capture_time, event_queue, motion_enabled
    
    if capture_in_progress:
        return
    
    capture_in_progress = True
    
    # Notify frontend that motion was detected
    event_queue.append({'event': 'motion_detected', 'data': {}})
    
    # Countdown 3, 2, 1 - start immediately
    print("Countdown: 3...")
    event_queue.append({'event': 'countdown', 'data': {'number': 3}})
    time.sleep(1)
    print("Countdown: 2...")
    event_queue.append({'event': 'countdown', 'data': {'number': 2}})
    time.sleep(1)
    print("Countdown: 1...")
    event_queue.append({'event': 'countdown', 'data': {'number': 1}})
    time.sleep(1)
    print("Capturing now!")
    
    # Pause motion sensor to prevent double-triggering
    motion_enabled = False
    
    try:
        if camera:
            # Capture to bytes
            stream = io.BytesIO()
            camera.capture_file(stream, format='jpeg')
            stream.seek(0)
            latest_capture = stream.getvalue()
            latest_capture_time = time.time()
            print("Image captured successfully")
            
            # Notify frontend to process the captured image
            event_queue.append({'event': 'image_captured', 'data': {}})
    except Exception as e:
        print(f"Capture failed: {e}")
        # Re-enable motion if capture failed, as frontend won't get the event
        motion_enabled = True
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


@app.route('/api/events')
def events():
    """SSE endpoint for real-time notifications"""
    def event_stream():
        global event_queue
        last_heartbeat = time.time()
        
        while True:
            # Send events from queue
            while event_queue:
                event = event_queue.pop(0)
                yield f"event: {event['event']}\ndata: {json.dumps(event['data'])}\n\n"
            
            # Send heartbeat every 15 seconds to keep connection alive
            if time.time() - last_heartbeat > 15:
                yield f"event: heartbeat\ndata: {json.dumps({'time': time.time()})}\n\n"
                last_heartbeat = time.time()
            
            time.sleep(0.5)
    
    response = Response(event_stream(), mimetype='text/event-stream')
    response.headers['Cache-Control'] = 'no-cache'
    response.headers['X-Accel-Buffering'] = 'no'
    return response


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
            try:
                # Capture frame directly from camera
                request_obj = camera.capture_request()
                img = request_obj.make_image('main')
                
                # Encode to JPEG
                jpeg_buffer = io.BytesIO()
                img.save(jpeg_buffer, format='JPEG', quality=85)
                frame = jpeg_buffer.getvalue()
                
                yield (b'--frame\r\n'
                       b'Content-Type: image/jpeg\r\n'
                       b'Content-Length: ' + str(len(frame)).encode() + b'\r\n\r\n' + frame + b'\r\n')
                
                request_obj.release()
                time.sleep(0.05)  # ~20 FPS
            except Exception as e:
                print(f"Stream error: {e}")
                time.sleep(0.1)
    
    return Response(generate(), mimetype='multipart/x-mixed-replace; boundary=frame')


@app.route('/api/config', methods=['GET'])
def get_config():
    """Get current configuration"""
    return jsonify({
        'capture_delay': CAPTURE_DELAY,
        'motion_sensor_pin': MOTION_SENSOR_PIN,
        'api_endpoint': API_ENDPOINT,
        'flip_image': FLIP_IMAGE
    })


@app.route('/api/motion/enable', methods=['POST'])
def enable_motion():
    """Enable motion detection"""
    global motion_enabled
    motion_enabled = True
    return jsonify({'status': 'enabled'})


@app.route('/api/motion/disable', methods=['POST'])
def disable_motion():
    """Disable motion detection"""
    global motion_enabled
    motion_enabled = False
    return jsonify({'status': 'disabled'})


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


@app.route('/api/save-photo', methods=['POST'])
def save_photo():
    """Save photo and results after classification"""
    try:
        data = request.json
        photo_base64 = data.get('photo')
        results = data.get('results')
        inference_time = data.get('inference_time')
        
        if not photo_base64:
            return jsonify({'error': 'No photo provided'}), 400
        
        # Generate timestamp-based filename
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        photo_id = timestamp
        
        # Decode base64 photo
        photo_data = base64.b64decode(photo_base64.split(',')[1] if ',' in photo_base64 else photo_base64)
        
        # Save photo
        photo_path = os.path.join(PHOTOS_DIR, 'originals', f'{photo_id}.jpg')
        with open(photo_path, 'wb') as f:
            f.write(photo_data)
        
        # Save metadata
        metadata = {
            'timestamp': datetime.now().isoformat(),
            'photo_id': photo_id,
            'filename': f'{photo_id}.jpg',
            'results': results,
            'inference_time_ms': inference_time
        }
        
        metadata_path = os.path.join(PHOTOS_DIR, 'metadata', f'{photo_id}.json')
        with open(metadata_path, 'w') as f:
            json.dump(metadata, f, indent=2)
        
        print(f"Photo saved: {photo_path}")
        print(f"Metadata saved: {metadata_path}")
        
        return jsonify({
            'status': 'success',
            'photo_id': photo_id,
            'photo_path': photo_path
        }), 200
        
    except Exception as e:
        print(f"Error saving photo: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/translate', methods=['POST'])
def translate_text():
    """Translate text from English to French using the inference API"""
    try:
        data = request.json
        text = data.get('text', '')
        
        if not text:
            return jsonify({'error': 'No text provided'}), 400
        
        # Extract the base URL from API_ENDPOINT
        # API_ENDPOINT is like https://api.biswa.ca/predict
        # We need https://api.biswa.ca/translate
        api_base = API_ENDPOINT.rsplit('/', 1)[0]  # Remove /predict
        translate_url = f"{api_base}/translate"
        
        print(f"Translating via: {translate_url}")
        
        response = requests.post(
            translate_url,
            json={'text': text},
            timeout=30
        )
        
        if response.ok:
            result = response.json()
            return jsonify({
                'translated_text': result.get('translated_text', text),
                'original_text': text
            }), 200
        else:
            print(f"Translation API error: {response.status_code}")
            return jsonify({'translated_text': text}), 200  # Return original on error
            
    except Exception as e:
        print(f"Translation error: {e}")
        return jsonify({'translated_text': data.get('text', '')}), 200  # Return original on error


if __name__ == '__main__':
    print("Starting Waste Classifier Pi Camera Service...")
    print(f"Capture delay: {CAPTURE_DELAY} seconds")
    print(f"Motion sensor pin: GPIO {MOTION_SENSOR_PIN}")
    print(f"API endpoint: {API_ENDPOINT}")
    
    # Initialize hardware
    init_hardware()
    
    # Start Flask server
    app.run(host='0.0.0.0', port=8000, threaded=True)
