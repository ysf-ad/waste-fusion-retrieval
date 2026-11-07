import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDeployedHandler } from '../src/deployment.mjs';
import { createHandler } from '../src/service.mjs';
import { QUESTIONS } from '../src/questions.mjs';
import { MAX_IMAGE_BYTES, MAX_BASE64_CHARS, MAX_REQUEST_BYTES } from '../src/image-limits.mjs';

// Synthetic signature-bearing bytes exercise transport limits, not image decoding.
// All inference uses a local stub: no API keys, fetches or paid model calls.
const items = JSON.parse(await readFile(new URL('../src/items.json', import.meta.url), 'utf8'));
const signatures = { jpeg: [255, 216, 255, 224], png: [137, 80, 78, 71, 13, 10, 26, 10] };
const defaults = { kind: 'plastic_drink_bottle', hazard: 'absent', condition: 'empty_clean',
  plastic_color: 'non_black', compostable_mark: 'not_marked', paper_finish: 'uncoated', paper_soiling: 'clean' };
const answers = Object.fromEntries(Object.entries(QUESTIONS).map(([id, question]) => {
  const choices = Object.keys(question.criteria);
  return [id, { choice: defaults[id], probabilities: Object.fromEntries(choices.map(choice =>
    [choice, choice === defaults[id] ? 0.98 : 0.02 / (choices.length - 1)])) }];
}));
function fixture(core = false, ask) {
  const calls = [];
  const handler = (core ? createHandler : createDeployedHandler)(items, async options => {
    calls.push(options.image);
    return ask ? ask(options) : { answers };
  });
  return { calls, fetch: request => handler(request, { WASTEWIZARD_ALLOW_PUBLIC: 'true' }) };
}
function imageBytes(size, type) {
  const bytes = Buffer.alloc(size);
  bytes.set(signatures[type]);
  return bytes;
}
function imageUrl(bytes, type) { return `data:image/${type};base64,${bytes.toString('base64')}`; }
function request(path, format, bytes, type) {
  const mime = `image/${type}`;
  let body, headers = {};
  if (format === 'raw') { body = bytes; headers['Content-Type'] = mime; }
  else if (format === 'multipart') {
    body = new FormData();
    body.set('file', new Blob([bytes], { type: mime }), `camera.${type}`);
    body.set('mode', 'compact');
  } else {
    body = JSON.stringify({ image: imageUrl(bytes, type), mode: 'compact' });
    headers['Content-Type'] = 'application/json';
  }
  return new Request(`https://worker.example${path}`, { method: 'POST', headers, body });
}
async function assertAccepted(f, response, bytes, type) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0], imageUrl(bytes, type), 'mock model receives the unchanged image');
  assert.equal((await response.json()).model_calls, 1);
}
async function assertOversized(f, response) {
  assert.equal(response.status, 413, await response.clone().text());
  assert.equal(f.calls.length, 0, 'oversized input must never reach inference');
  assert.ok((await response.json()).error);
}

test('shared limits use decimal 10 MB decoded images and a base64-safe request envelope', () => {
  assert.equal(MAX_IMAGE_BYTES, 10_000_000);
  assert.equal(MAX_BASE64_CHARS, 4 * Math.ceil(MAX_IMAGE_BYTES / 3));
  assert.equal(MAX_REQUEST_BYTES, MAX_BASE64_CHARS + 64 * 1024);
});

for (const path of ['/', '/predict', '/api/classify']) {
  for (const format of ['json', 'raw', 'multipart']) {
    for (const type of ['jpeg', 'png']) {
      for (const size of [385_107, 948_703, MAX_IMAGE_BYTES, MAX_IMAGE_BYTES + 1]) {
        test(`${path} ${format} ${type}: decoded ${size} bytes`, async () => {
          const f = fixture();
          const bytes = imageBytes(size, type);
          const response = await f.fetch(request(path, format, bytes, type));
          if (size <= MAX_IMAGE_BYTES) await assertAccepted(f, response, bytes, type);
          else await assertOversized(f, response);
        });
      }
    }
  }
}

for (const core of [false, true]) {
  for (const type of ['jpeg', 'png']) {
    for (const offset of [-2, -1, 0, 1, 2]) {
      test(`${core ? 'direct core' : 'deployed'} JSON ${type} padding boundary max${offset >= 0 ? '+' : ''}${offset}`, async () => {
        const f = fixture(core);
        const bytes = imageBytes(MAX_IMAGE_BYTES + offset, type);
        const encoded = bytes.toString('base64');
        const padding = (3 - bytes.length % 3) % 3;
        assert.equal((encoded.match(/=+$/)?.[0] || '').length, padding);
        if (offset === 1 || offset === 0) assert.equal(encoded.length, MAX_BASE64_CHARS);
        const response = await f.fetch(request('/api/classify', 'json', bytes, type));
        if (offset <= 0) await assertAccepted(f, response, bytes, type);
        else await assertOversized(f, response);
      });
    }
  }
}

for (const core of [false, true]) {
  const name = core ? 'direct core' : 'deployed';
  for (const extra of [0, 1]) {
    test(`${name} accepts exact request cap, rejects cap+1 (${extra}) without Content-Length`, async () => {
      const f = fixture(core);
      const bytes = imageBytes(16, 'jpeg');
      const json = JSON.stringify({ image: imageUrl(bytes, 'jpeg') });
      const body = json + ' '.repeat(MAX_REQUEST_BYTES + extra - Buffer.byteLength(json));
      const req = new Request('https://worker.example/api/classify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      });
      assert.equal(req.headers.get('Content-Length'), null);
      const response = await f.fetch(req);
      if (extra) await assertOversized(f, response);
      else await assertAccepted(f, response, bytes, 'jpeg');
    });
  }
  for (const declared of [null, '1']) {
    test(`${name} cancels over-cap streaming body with ${declared === null ? 'missing' : 'understated'} Content-Length`, async () => {
      const f = fixture(core);
      let sent = 0, cancelled = false;
      const body = new ReadableStream({
        pull(controller) {
          const size = Math.min(64 * 1024, MAX_REQUEST_BYTES + 1 - sent);
          if (size) { controller.enqueue(new Uint8Array(size)); sent += size; }
          // Leave open so the handler must cancel as soon as its cap is exceeded.
        },
        cancel() { cancelled = true; },
      });
      const headers = { 'Content-Type': 'application/json' };
      if (declared !== null) headers['Content-Length'] = declared;
      const response = await f.fetch(new Request('https://worker.example/api/classify', {
        method: 'POST', headers, body, duplex: 'half',
      }));
      await assertOversized(f, response);
      assert.equal(cancelled, true);
      assert.equal(sent, MAX_REQUEST_BYTES + 1);
    });
  }
  test(`${name} rejects oversized declared length before consuming the body`, async () => {
    const f = fixture(core);
    let reads = 0;
    const req = new Request('https://worker.example/api/classify', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(MAX_REQUEST_BYTES + 1) },
      body: new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 }), duplex: 'half',
    });
    await assertOversized(f, await f.fetch(req));
    assert.equal(reads, 0);
  });
}

for (const fail of [false, true]) {
  test(`deployed pipeline rejects concurrent bodies unread and releases after ${fail ? 'model error' : 'success'}`, async t => {
    let release, entered;
    const hold = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    let count = 0;
    const f = fixture(false, async () => {
      if (++count === 1) {
        entered();
        await hold;
        if (fail) throw new Error('Offline model failure');
      }
      return { answers };
    });
    t.after(() => release());
    const bytes = imageBytes(16, 'jpeg');
    const first = f.fetch(request('/predict', 'json', bytes, 'jpeg'));
    await started;
    for (const path of ['/', '/predict', '/api/classify']) {
      let reads = 0;
      const blocked = new Request(`https://worker.example${path}`, {
        method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, duplex: 'half',
        body: new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 }),
      });
      const response = await f.fetch(blocked);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('Retry-After'), '2');
      assert.equal((await response.json()).code, 'image_pipeline_busy');
      assert.equal(reads, 0);
      assert.equal(blocked.bodyUsed, false);
      assert.equal(f.calls.length, 1);
    }
    // Health and CORS preflight must remain available during active inference.
    assert.equal((await f.fetch(new Request('https://worker.example/api/health'))).status, 200);
    assert.equal((await f.fetch(new Request('https://worker.example/predict', { method: 'OPTIONS' }))).status, 204);
    release();
    assert.equal((await first).status, fail ? 500 : 200);
    f.calls.length = 0;
    await assertAccepted(f, await f.fetch(request('/api/classify', 'json', bytes, 'jpeg')), bytes, 'jpeg');
  });
}

for (const failure of ['malformed', 'oversized', 'broken stream']) {
  test(`deployed pipeline releases after ${failure} ingress error`, async () => {
    const f = fixture();
    const body = failure === 'malformed' ? '{' : failure === 'oversized' ? ' '.repeat(MAX_REQUEST_BYTES + 1) :
      new ReadableStream({ start(controller) { controller.error(new Error('Offline read failure')); } });
    const response = await f.fetch(new Request('https://worker.example/predict', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      ...(failure === 'broken stream' ? { duplex: 'half' } : {}),
    }));
    assert.equal(response.status, failure === 'malformed' ? 400 : failure === 'oversized' ? 413 : 503);
    assert.equal(f.calls.length, 0);
    const bytes = imageBytes(16, 'png');
    await assertAccepted(f, await f.fetch(request('/', 'raw', bytes, 'png')), bytes, 'png');
  });
}

test('deployed upload deadline cancels nonblocking, returns 408 and releases the gate', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  let cancelled = false;
  const pending = f.fetch(new Request('https://worker.example/predict', {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, duplex: 'half',
    body: new ReadableStream({
      pull() {},
      cancel() { cancelled = true; return new Promise(() => {}); },
    }, { highWaterMark: 0 }),
  }));
  t.mock.timers.tick(15_000);
  assert.equal((await pending).status, 408);
  assert.equal(cancelled, true);
  assert.equal(f.calls.length, 0);
  const bytes = imageBytes(16, 'jpeg');
  await assertAccepted(f, await f.fetch(request('/', 'raw', bytes, 'jpeg')), bytes, 'jpeg');
});

test('deployed authorization rejects before touching an upload body', async () => {
  let reads = 0, calls = 0;
  const handler = createDeployedHandler(items, async () => { calls++; return { answers }; });
  const response = await handler(new Request('https://worker.example/predict', {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, duplex: 'half',
    body: new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 }),
  }), {});
  assert.equal(response.status, 403);
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test('health advertises the shared decoded, base64 and request byte limits', async () => {
  const f = fixture();
  const response = await f.fetch(new Request('https://worker.example/api/health'));
  assert.equal(response.status, 200);
  const { image } = await response.json();
  assert.equal(image.maximum_bytes, MAX_IMAGE_BYTES);
  assert.equal(image.maximum_base64_chars, MAX_BASE64_CHARS);
  assert.equal(image.maximum_request_bytes, MAX_REQUEST_BYTES);
  assert.equal(f.calls.length, 0);
});
