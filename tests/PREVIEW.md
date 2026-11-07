# Photo preview verification

The result screen displays the exact submitted image without cropping or mirroring,
its byte count, and an original-photo link. Reset clears the previous image before
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
