# Benny kiosk: calibration and build verification

These changes are local code only. They do not establish that a Pi has received
the build, that its camera is calibrated, or that recognition is accurate.
No inference requests are needed for build/orientation checks.

## Three independent concerns

1. **Screen installation:** the page and top-layer photo dialog use
   `KIOSK_SCREEN_ROTATION`. This rotates controls/text as well as images.
2. **Camera presentation:** `CAMERA_LIVE_*` controls the live camera view;
   `CAMERA_CAPTURED_*` controls the camera-origin scan, result and enlarged
   image. All are CSS only. The zoom image uses exactly the captured transform;
   the dialog separately gets the installation screen rotation.
3. **Photo data:** camera capture/latest-image and the browser photo view keep
   their original bytes. Uploaded photos bypass camera calibration, including
   mirrors. Screen rotation still applies to the whole interface. The upstream
   multipart request also keeps original bytes unless inference preparation is enabled.

| Environment setting | Default | Accepted values |
|---|---:|---|
| `KIOSK_SCREEN_ROTATION` | 180 | 0 or 180 degrees |
| `CAMERA_LIVE_ROTATION` | 180 | 0, 90, 180 or 270 degrees clockwise |
| `CAMERA_CAPTURED_ROTATION` | 0 | 0, 90, 180 or 270 degrees clockwise |
| `CAMERA_LIVE_MIRROR` | false | true or false |
| `CAMERA_CAPTURED_MIRROR` | legacy `FLIP_IMAGE`, otherwise false | true or false |
| `KIOSK_UI_BUILD` | benny-kiosk-vision-v1 | Operator-supplied build label |

The defaults deliberately retain the former body 180 + live-image 180 behavior.
They are compatibility defaults, **not measured camera calibration**. Do not
remove the existing effective live rotation simply because it appears redundant.
Legacy `FLIP_IMAGE` only supplies the captured mirror default; explicit
`CAMERA_CAPTURED_MIRROR` wins. Invalid environment values stop startup rather than
silently selecting a different orientation. Settings are read at process startup.
90/270 screen rotation is intentionally unsupported because it requires a separate
portrait layout. Rotated images remain within the existing image containers;
check framing/aspect on the actual display, especially 90/270 camera rotations.

## On-device calibration checklist

Use an asymmetric printed target: readable `TOP`, an upward arrow and distinct
left/right labels. Do not use a symmetric can alone.

1. Record current `/api/config` and `/api/ui-build` responses before changing
   anything. Record Pi identity, service command, port and display resolution.
2. With the hardware mounted normally, orient screen controls/text using only
   `KIOSK_SCREEN_ROTATION`. Do not change camera options to repair page text.
3. Observe the target live. Calibrate `CAMERA_LIVE_ROTATION`, then set
   `CAMERA_LIVE_MIRROR` only if the left/right text actually requires a mirror.
4. Capture the target. Compare scan, result, enlarged view and original download.
   Calibrate `CAMERA_CAPTURED_ROTATION`/`CAMERA_CAPTURED_MIRROR` as presentation
   settings. Scan/result/enlarged views must agree. The original download must
   retain its untransformed pixels/bytes. Do not bake installation transforms
   into the capture API or inference input.
5. Upload a known, upright existing JPEG. Verify that all upload views ignore
   camera calibration. A subsequent camera capture must restore camera settings.
6. Return, capture again, and inspect enlarged photo both before and after
   orientation changes. The modal must follow screen orientation once, not twice.
7. Repeat with mirrors independently on/off. Record the chosen settings and
   evidence; do not call the software fixture an on-device calibration result.

Set environment through the actual service configuration; restart only the
identified camera service when ready. A reboot/deployment is not part of this
checklist. Preserve the old settings for rollback. First validate locally with
fake hardware before any device change.

## Confirm which UI is actually served

The existing standalone camera service defaults to port 8000; a fixture may use
another port. Use the exact origin currently open in the kiosk browser:

```sh
BASE=http://127.0.0.1:8000
curl -fsS -H 'Cache-Control: no-cache' "$BASE/api/config"
curl -fsS -H 'Cache-Control: no-cache' "$BASE/api/ui-build"
curl -fsS -H 'Cache-Control: no-cache' "$BASE/index.html" | sha256sum
curl -fsS -H 'Cache-Control: no-cache' "$BASE/styles.css" | sha256sum
curl -fsS -H 'Cache-Control: no-cache' "$BASE/camera-orientation.js" | sha256sum
curl -fsS -H 'Cache-Control: no-cache' "$BASE/result-info.js" | sha256sum
```

`/api/ui-build` is no-store and reports:

- `ui_build`: label captured by the running Python service at import/startup;
- `expected_brand`: `Benny` (the intended brand, not proof the DOM is current);
- `asset_sha256`: hashes of the four currently served files; null means missing;
- `asset_set_sha256`: fingerprint of that hash map;
- `orientation`: effective validated settings of the running process.

Compare each fetched asset hash against this response and the intended checkout.
Then reload the existing browser origin with cache disabled and confirm the
visible Benny branding, helper request, API details build label and correct
orientation. A manually assigned build label, successful process restart, or
server-side hash alone cannot prove the browser loaded those assets. A stale
browser cache, wrong service working tree, wrong `STATIC_DIR`, reverse proxy,
wrong port or still-running old Python process can each explain a mismatch.
The endpoint intentionally exposes no filesystem paths or credentials.

## Integration contract

Load `camera-orientation.js` before the page's inline script. After fetching
`/api/config`, call `CameraOrientation.configure(config, document)`; on fetch
failure configure `{}` to retain compatibility defaults. Use:

```js
CameraOrientation.applyImage(video, {source: 'camera', view: 'live'});
CameraOrientation.applyImage(image, {
  source: uploadMode ? 'upload' : 'camera', view: 'captured'
});
```

Apply the captured form consistently to scan/result/zoom images. Remove
old inline flip transforms; do not apply both calibration and legacy flip logic.
The helper changes only `style.transform`, not sources, dimensions, canvas
contexts or blobs. Keep source provenance tied to the submitted photo, not to a
later camera/upload mode switch.

## Optional inference copy (off by default)

Set `PREPARE_INFERENCE_IMAGE=true` on the Pi when testing a provider that needs
bounded inference images. The proxy prepares a separate copy and forwards it as
JPEG; browser preview and capture endpoints still use the original. Screen and
camera-display calibration settings never alter this copy.

`frontend/inference_image.py` exports `prepare_inference_jpeg(original_bytes)`.
It returns a **new** RGB baseline JPEG, honors source EXIF orientation, preserves
aspect by resizing/padding rather than cropping/stretching, bounds each axis to
280–1568, strips metadata and caps output at 2,500,000 bytes. Input is limited to
32 MB and 24 million decoded pixels; animated images and non-JPEG/PNG are rejected.
Transparent input is composited on white. A bounded quality loop fails explicitly
if a tighter requested byte cap cannot be met. It does not use camera/screen
calibration or mutate/write originals. Flask routes remain deliberately unchanged;
callers must opt in separately and keep original preview/download bytes distinct
from the inference copy. This helper has no networking or paid-model fallback.

## Offline tests

From the nested kiosk repository:

```sh
node --test tests/camera-orientation.test.mjs
PYTHONPATH=.test-deps python -m unittest discover -s tests -p 'test_camera_orientation.py' -v
PYTHONPATH=.test-deps python -m unittest discover -s tests -p 'test_inference_image.py' -v
```

All HTTP inference is mocked. These cover config validation, build hashes,
unchanged capture/upload bytes, presentation transforms, EXIF, bounds, padding,
alpha compositing and malformed inputs. They do not replace browser/device checks.
