# Benny web demo: photos, live analysis and verification

The generated [web demo](../worker/public/benny.html) shares the Pi kiosk's real
renderer, styles, result adapter and orientation helper. Browser controls live in
[benny-web.js](../frontend/static/benny-web.js); rebuild through
[build-benny-web.mjs](../worker/scripts/build-benny-web.mjs), not by editing the HTML.

## Your photo first

On HTTP/HTTPS the primary section offers **Choose Photo** and an explicit
**Take Photo** browser-camera action. The browser-camera helper requests
`getUserMedia` only after that button is clicked, never on page load. On supported
secure origins it prefers a rear camera (`facingMode: {ideal: 'environment'}`),
without requiring one or requesting microphone access. Desktop webcams therefore
remain usable. The camera panel lets you capture a JPEG or close the view; neither
opening nor capturing a photo performs inference.

Capture, Close and page exit stop the helper's acquired camera tracks and clear
the video stream. A camera stream that arrives after cancellation must also be
stopped rather than attached. Permission denial, missing hardware/API and insecure
origins produce guidance to use file upload or the native camera app instead.
Camera permission and device behavior still depend on the actual browser/OS.

The mobile native-camera file picker (`capture="environment"`) remains a fallback,
alongside a regular file picker. Native capture support varies; where unsupported,
choose an existing photo or take one with the device's camera app and upload it.
This web camera never starts a Pi MJPEG/SSE stream.

Choosing or taking a photo does not upload it. Review the preview and press
**Analyze photo** to send one live request. Personal photos are never put in the
sample-result cache. Only analyze photos you have permission to share.

## Three real example photos

The secondary gallery contains a drink can, bare hand and wood board, with
[author/source/license attribution](../worker/public/benny-media/ATTRIBUTION.md).
The real JPEG bytes and credits are embedded in the generated file; no external
photo fetch is needed. These photos are public licensed examples, not private
user photos.

- **HTTP/HTTPS default:** clicking an example requests live exact-mode analysis.
  Loading the page alone never starts inference.
- **Show simulated examples:** this button switches the gallery to labeled
  fixtures with no health or inference request.
- **Local `file:` preview:** gallery clicks are always simulated. Personal-photo
  live controls are hidden.

Simulated responses are a can identity with Blue Bin guidance, a bare-hand
no-item response, and an unresolved wood case displayed as **Item not confirmed**,
with no guessed material name or bin. They carry `fixture: true` and
`build_id: benny-demo-sample`. They exercise the real renderer, not recognition
accuracy. Real-photo inputs do not turn these fixtures into model evidence.

For accepted identity, the UI wording is **Model confidence: …%**. This is a model
estimate, not guaranteed correctness or calibrated accuracy. Unresolved/no-item results show the relevant model score if returned, or
“unavailable,” and never a guessed bin. All results remain open until
Back rather than using the Pi's five-second return.

## Safety gates, cache and image handling

Both live gallery and personal upload first request same-origin `/api/health` and
require `ready: true`, an `exact` mode, `rate_limit_enforced: true` and
`kiosk_open_set: true`. An older backend is not assumed equivalent. Failed checks
send no image; explicit simulation remains available. All live controls share one
busy guard through health and inference, so double clicks or switching controls
cannot send overlapping analyses. There is no silent provider retry.

Successful gallery responses may be reused from optional per-tab `sessionStorage`,
keyed by embedded sample/build version, for 30 minutes. Cached live results are
labeled **Cached live result · no new request** and replay a bounded loading
delay based on the previous response time.
Different photos/builds, expired/malformed cache entries and failed analyses do
not reuse that response. Missing/blocked storage degrades to a guarded live request;
it must not break examples. This cache excludes personal uploads entirely.

Personal input is JPEG/PNG, nonempty, at most 10,000,000 bytes and 24 million decoded
pixels. A separate JPEG inference copy honors browser EXIF orientation, preserves
aspect with white padding, bounds each axis to 280–1568 pixels and caps output at
2,500,000 bytes. Preview/zoom uses the original selected Blob, not the prepared
copy. Licensed gallery JPEGs already meet these dimensions/bytes. Live transmission
is one exact-mode multipart POST to same-origin `/predict`.

The web UI never calls the Pi photo-save route. This does not promise anything
about external provider retention. Provider failures clear previous bin advice
while retaining the current original preview; simulation remains usable. No paid
inference or external network calls are used by the tests below.

## Build and offline tests

From this repository root:

```sh
# Explicit generation (writes the artifact).
node worker/scripts/build-benny-web.mjs
# Read-only freshness check.
node worker/scripts/build-benny-web.mjs --check
# Semantic regressions: mocked DOM/media/storage/network, real generated scripts.
node --test worker/test/benny-web.test.mjs
# Isolated browser-camera lifecycle; no real camera or permission prompt.
node --test worker/test/benny-camera.test.mjs
```

The isolated [camera tests](../worker/test/benny-camera.test.mjs) execute the real
[browser-camera helper](../frontend/static/benny-camera.js) against fake media and
DOM. They verify idle startup, explicit permission requests, rear-camera preference
without excluding desktop webcams, frame readiness, JPEG File emission without
HTTP, capture/close/pagehide track teardown, late permission/playback/encoding
cancellation, duplicate-click guards, missing/denied/busy/insecure fallbacks,
encoding failure and busy-operation guards. Camera capture alone never implies
permission to transmit the image; Only the separate Analyze action sends the photo.

Tests verify artifact parity/shared renderer, real JPEG fixtures, idle startup,
file/simulated zero-request behavior, first live gallery request, confidence
wording/withholding, explicit Analyze submission, health gates, cross-control busy
guards, cache scope/expiry/storage failure, no personal caching, exact multipart,
original-preview separation, image bounds and provider-error recovery. They do
not prove browser layout, native mobile picker behavior or image-codec conformance.
Browser review should separately check zoom/Back, responsive layout, photo credits,
live/cached/simulated labels and no traffic in file-mode simulation. Local passing
tests are not a deployment, camera calibration or recognition-accuracy result.
