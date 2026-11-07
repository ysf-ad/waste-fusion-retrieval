import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const base = new URL('../', import.meta.url);
const release = JSON.parse(await readFile(new URL('deployment/2026-11-07-image10mb/result.json', base), 'utf8'));
for (const [path, expected] of Object.entries(release.source_hashes)) {
  const bytes = await readFile(new URL(path, base));
  // Git for Windows may normalize text checkouts to CRLF.
  const normalized = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));
  assert.equal(createHash('sha256').update(normalized).digest('hex'), expected, path);
}
assert.equal(release.success, true);
assert.equal(release.model_inference_requests, 0);
console.log('Versioned source matches the verified 10 MB production release.');
