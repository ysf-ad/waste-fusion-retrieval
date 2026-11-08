# Photo preview verification

The result screen displays the exact submitted image without cropping or mirroring,
its byte count, and an in-app photo zoom. Reset clears the previous image before
another capture. The Worker preserves multipart `mode=exact` and rejects duplicate
mode fields.

Offline checks (Node 22+ and the project's Python dependencies):

```text
node --test worker/test/*.test.mjs tests/*.test.mjs
python -m unittest discover -s tests -p "test_*.py"
```

Software preview: start `node tests/preview-worker.mjs`, then set `E2E_IMAGE` to an
absolute JPEG path and run `python tests/preview-camera.py`. Open
http://127.0.0.1:18775 and choose Take Photo. Both services bind only to loopback;
the camera is simulated and model responses are deterministic. These checks verify
the software flow and image integrity, not recognition accuracy or physical Pi
hardware. The preview services block outbound inference requests.

Release `jev-exact-upload-20261107-r2` is deployed to the existing
`waste-wizard-clef` Worker. Live verification in
`worker/deployment/2026-11-07-exact-upload/result.json` confirms the 10 MB cap and
multipart validation without model calls. The device must pull the frontend update
to receive the new original-photo preview; the Worker fix takes effect immediately.

Fresh live prediction: the original 1392 × 3013 phone photo passed our byte limit
but JEV returned HTTP 400. The provider requires each dimension to be 280–1568
pixels and never resizes inputs (https://docs.typesafe.ai/images.md). An EXIF-aware,
proportional full-frame resize to 724 × 1568 (342,743 bytes, no crop) succeeded on
the same `/predict` endpoint: HTTP 200, `beverage can`, match probability 0.99,
Blue Bin source instructions, condition unknown. It used two model calls in one
exact request. The Pi's configured 800 × 480 capture fits these dimensions;
arbitrary phone uploads still need preprocessing. Evidence is saved alongside
the release as `live-prediction.json`, `live-response.json`, and
`original-dimensions-attempt.json`. The screenshot renders that recorded real
response against the matching resized photo; rendering makes no further model calls.

## Passive instruction layout

The original analyzing screen, spinner and scan beam predate these changes
(present in commit `6e46d22`). The result screen keeps its two panels and moves
the existing instruction list to the wider destination panel. The bin heading
and icon are compact; Full response stays closed and subtle. No additional
controls, tabs or decisions were added.

At 800 × 480, browser geometry checks rendered all 2,205 catalogue entries with
every source instruction in each visible state (`applies`, `check`, `reference`):
6,615 layouts passed without instruction clipping, overlap with Full response,
or panel scrolling. The current catalogue contains at most three instructions
per entry. A separate mock with six instructions also fit, with every line
visible. The longest current source text was checked visually. These checks
exercise the real renderer with mocked applicability states, not model accuracy;
they do not guarantee unlimited future text or smaller displays will fit.

## Embedded kiosk recovery

Successful results and errors return to the camera after five seconds. Opening
Full response or photo zoom does not suspend that timer. Photo zoom uses an
in-app dialog with a large Close button, Escape and background-tap dismissal;
there is no raw-photo link or new browser tab. Reset also closes the dialog.
The zoom preserves the device's 180-degree orientation.

A 25-second deadline covers countdown, capture, image loading, upload and response
body processing. Expired requests are aborted; late responses and motion events
cannot replace the home screen or cancel a result's return timer. Reset clears
the countdown, releases the photo URL, re-enables capture and resumes motion.
The production Debug entry is hidden to prevent persistent sample screens.

Regression tests cover repeated scans, five-second result/error recovery, reset
during countdown, stalled capture/image/prediction bodies and stale completions.
Browser checks use the unchanged Flask proxy, simulated hardware and a recorded
real API response; they make no new prediction calls or physical-device claims.
