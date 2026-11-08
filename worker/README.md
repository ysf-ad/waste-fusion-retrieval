# Production WasteWizard Worker

Versioned production source for the Pi endpoint:
`https://waste-wizard-clef.yousifaldakoki.workers.dev/predict`.
The original local Worker workspace was outside this Git repository; this directory
now preserves its deployed source, static demo, API regression tests and release evidence.
It includes the existing sorting policies and exact-mode compatibility, not a new model.

## 10 MB release (2026-11-07)

- Maximum decoded JPEG/PNG: **10,000,000 bytes** (decimal 10 MB).
- Maximum base64: **13,333,336 characters**.
- Maximum HTTP envelope: **13,398,872 bytes** (base64 plus 64 KiB).
- Applies consistently to raw images, multipart images and JSON aliases on
  `/predict`, `/api/classify` and root POST. Over-limit uploads return 413.
- Streamed bodies are bounded even without/trusting Content-Length. Uploads have
  a 15-second deadline. Only one image pipeline runs per isolate to bound memory;
  concurrent requests in that isolate get 503 and `Retry-After: 2`.
- Duplicate internal JSON serialization/parsing removed; signature validation
  only decodes the first bytes, not another full image copy.
- Existing 60/IP/minute and 120/location/minute limits, provider, timeout and
  sorting safety behavior retained. No automatic retries or paid fallbacks.
- Health exposes the byte limits and build ID `jev-image10mb-20261107-r1`.

**The live device needs no update/restart to receive the server-side limit fix.**
The Pi diagnostics in the parent frontend are optional additional observability:
status/capture responses report JPEG bytes, and latest-image sends `X-Image-Bytes`.

Provider restrictions remain separate: [TypeSafe image documentation](https://docs.typesafe.ai/images.md)
specifies nonanimated JPEG/PNG, each side 280–1568 pixels, 16 MiB/file and a 32 MiB
HTTP body. Raising our byte cap does not resize tall phone pictures or guarantee
provider acceptance. The configured Pi JPEG is 800×480.

## Tests / deployment

Node 22+; no dependencies are needed for offline tests:

```sh
npm test
npm run build
# Only with authorized Cloudflare credentials and after reviewing the live version:
npm run deploy
```

Wrangler is pinned to 4.155.0 because older versions silently omit rate-limit bindings.
Secrets (`TYPESAFE_API_KEY`, optional `WASTEWIZARD_CLIENT_TOKEN`) belong in Cloudflare,
never Git. Public inference is enabled with rate limits as previously authorized;
approximate per-location counters are not a global spending cap.

`deployment/2026-11-07-image10mb/result.json` records the verified live version,
previous rollback version, source hashes, health and probes. Production raw,
JSON and multipart 10 MB uploads passed the size checks then deliberately failed
signature validation (400). 10,000,001-byte images were rejected with 413.
All probes used invalid images to guarantee **zero inference requests**; successful
classification of a real 10 MB image has not been tested. The deployed homepage
hash did not change. The secondary `waste-classifier` Worker was not redeployed.

`deployment/image10mb-offline-tests.txt` captures the full original workspace
regression run, including benchmark-related suites not vendored here. The
self-contained API suites in this directory can be rerun independently.
`scripts/deploy-image-limits.mjs` is the audited one-release deployment tool;
it intentionally refuses repeated deployment or unexpected production versions.
