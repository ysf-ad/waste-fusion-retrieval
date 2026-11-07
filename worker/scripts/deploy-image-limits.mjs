// One-release production deployment. Every live POST has an invalid image signature;
// no probe can reach inference. Run after the full offline suite passes.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { MAX_IMAGE_BYTES, MAX_REQUEST_BYTES, MAX_BASE64_CHARS } from '../src/image-limits.mjs';
const cli = process.argv[2];
if (!cli) throw Error('Pass Wrangler 4.36+ CLI path');
const baseline = '109c9fa7-74f3-4001-9126-aa6d8502710a';
const build = 'jev-image10mb-20261107-r1';
const name = 'waste-wizard-clef';
const url = 'https://waste-wizard-clef.yousifaldakoki.workers.dev';
const dir = new URL('../deployment/2026-11-07-image10mb/', import.meta.url);
try { await access(new URL('result.json', dir)); throw Error('Evidence already exists; refusing repeat deployment'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(dir, { recursive: true });
function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 180000, windowsHide: true,
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } });
  if (result.status !== 0) throw Error(`Wrangler failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
function current() {
  return JSON.parse(run(['deployments', 'list', '--name', name, '--json'])).sort((a,b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0];
}
async function get(path, init = {}) { return fetch(url + path, { ...init, signal: AbortSignal.timeout(60000) }); }
const hash = value => createHash('sha256').update(value).digest('hex');
const evidence = { started_at: new Date().toISOString(), name, url, rollback_version: baseline,
  model_inference_requests: 0, probes: [], success: false };
let deployed = false;
try {
  const before = current();
  assert.equal(before.versions.length, 1);
  assert.equal(before.versions[0].version_id, baseline, 'Production changed; refusing overwrite');
  await writeFile(new URL('before.json', dir), JSON.stringify(before, null, 2));
  const healthBefore = await (await get('/api/health')).json();
  assert.equal(healthBefore.provider, 'jev');
  assert.equal(healthBefore.ready, true);
  evidence.baseline_health = healthBefore;
  const homepageBefore = await get('/'); assert.equal(homepageBefore.status, 200);
  evidence.home_sha256_before = hash(await homepageBefore.text());
  evidence.source_hashes = {};
  for (const file of ['src/deployment.mjs', 'src/service.mjs', 'src/image-limits.mjs', 'wrangler.toml']) {
    evidence.source_hashes[file] = hash(await readFile(new URL('../' + file, import.meta.url)));
  }
  const deployLog = run(['deploy', '--name', name, '--keep-vars', '--message', 'Raise image cap to 10 MB; coordinate base64 envelope, bound upload concurrency and preserve inference safety']);
  deployed = true;
  await writeFile(new URL('deploy.txt', dir), deployLog);
  const after = current();
  assert.equal(after.versions.length, 1);
  evidence.version = after.versions[0].version_id;
  assert.notEqual(evidence.version, baseline);
  const expected = { ...healthBefore, build_id: build, image: { ...healthBefore.image,
    maximum_bytes: MAX_IMAGE_BYTES, maximum_base64_chars: MAX_BASE64_CHARS, maximum_request_bytes: MAX_REQUEST_BYTES } };
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 1000));
    const health = await (await get('/api/health')).json();
    if (health.build_id === build) { assert.deepEqual(health, expected); evidence.health = health; break; }
  }
  assert.ok(evidence.health, 'Updated production health not visible');
  async function probe(label, path, headers, body, status) {
    const response = await get(path, { method: 'POST', headers, body });
    const data = await response.json();
    evidence.probes.push({ label, path, status: response.status, body: data });
    assert.equal(response.status, status, label);
    assert.equal(data.automatic_routing_enabled, false, label);
    assert.equal(data.results, undefined, label);
  }
  // All-zero bytes are deliberately NOT a JPEG/PNG. These exercise the upload
  // limits then fail signature validation, before askModel is ever called.
  for (const size of [385107, 948703, MAX_IMAGE_BYTES, MAX_IMAGE_BYTES + 1]) {
    await probe(`raw invalid JPEG ${size} bytes`, '/predict', { 'Content-Type': 'image/jpeg' }, new Uint8Array(size), size > MAX_IMAGE_BYTES ? 413 : 400);
  }
  for (const path of ['/predict', '/api/classify', '/']) {
    const image = 'data:image/jpeg;base64,' + Buffer.alloc(MAX_IMAGE_BYTES).toString('base64');
    await probe('10 MB JSON image invalid signature', path, { 'Content-Type': 'application/json' }, JSON.stringify({ image }), 400);
  }
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(MAX_IMAGE_BYTES)], { type: 'image/jpeg' }), 'invalid-signature.jpg');
  await probe('10 MB multipart invalid signature', '/predict', {}, form, 400);
  await probe('request envelope over limit', '/api/classify', { 'Content-Type': 'application/json' }, ' '.repeat(MAX_REQUEST_BYTES + 1), 413);
  await probe('malformed JSON', '/predict', { 'Content-Type': 'application/json' }, '{', 400);
  const preflight = await get('/predict', { method: 'OPTIONS', headers: { Origin: 'https://pi.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  evidence.probes.push({ label: 'CORS preflight', status: preflight.status });
  const homepageAfter = await get('/'); assert.equal(homepageAfter.status, 200);
  evidence.home_sha256_after = hash(await homepageAfter.text());
  assert.equal(evidence.home_sha256_after, evidence.home_sha256_before, 'Homepage unexpectedly changed');
  assert.equal(current().versions[0].version_id, evidence.version, 'Concurrent deployment during verification');
  evidence.success = true;
  evidence.verified_at = new Date().toISOString();
} catch (error) {
  evidence.error = error.message;
  if (deployed) {
    try {
      // Do not roll back someone else's concurrent deployment.
      assert.equal(current().versions[0].version_id, evidence.version, 'Concurrent version; refusing rollback');
      run(['rollback', baseline, '--name', name, '--message', '10 MB image limit verification failed', '--yes']);
      evidence.rollback_verified = current().versions[0].version_id === baseline;
    } catch (rollbackError) { evidence.rollback_error = rollbackError.message; }
  }
  process.exitCode = 1;
}
await writeFile(new URL('result.json', dir), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
