import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../frontend/static/index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('        async function showCountdown()'), html.indexOf('        async function startCamera()'))
  + html.slice(html.indexOf('        async function processImage('), html.indexOf('        let autoReturnTimer = null;'));
function fixture({ captureFails = false, predictionFails = false } = {}) {
  const calls = [], numbers = [], errors = [], streams = [], timers = new Map();
  const jpeg = new Blob(['fresh captured JPEG'], { type: 'image/jpeg' });
  const result = { results: [{ item: 'API item', category: 'Blue Bin', instruction: 'API instructions' }] };
  const ctx = {
    usingPiCamera: true, captureBtn: { disabled: false }, autoReturnTimer: 10, uploadMode: true,
    countdownOverlay: { style: {} }, countdownNumber: { set textContent(n) { numbers.push(n); } },
    PI_SERVICE: { capture: '/api/capture', latestImage: '/api/latest-image' }, API_ENDPOINT: '/api/predict',
    video: {}, loadingPage: {}, performance: { now: () => 1 }, Blob, FormData, Date,
    setInterval(fn) { timers.set(1, fn); return 1; }, clearInterval(id) { timers.delete(id); },
    clearTimeout(id) { calls.push(['clearTimeout', id]); }, startScanTimer() {},
    setScanImage(blob) { calls.push(['image', blob]); }, showPage() {},
    showError(message) { errors.push(message); },
    async displayResult(data, blob) { calls.push(['display', data, blob]); },
    EventSource: class { constructor(url) { this.url = url; this.handlers = {}; streams.push(this); }
      addEventListener(name, fn) { this.handlers[name] = fn; } },
    async fetch(url, options) {
      calls.push(['fetch', url, options]);
      if (url === '/api/capture') return { ok: !captureFails, status: captureFails ? 500 : 200 };
      if (url === '/api/latest-image') return { ok: true, blob: async () => jpeg };
      if (url === '/api/predict') return { ok: !predictionFails, status: 502, json: async () => result };
      throw new Error('Unexpected URL: ' + url);
    },
  };
  vm.createContext(ctx); vm.runInContext(source, ctx);
  return { ctx, calls, numbers, errors, streams, jpeg, result,
    run: expression => vm.runInContext(expression, ctx),
    async countdown() { for (let i = 0; i < 3; i++) { timers.get(1)(); await Promise.resolve(); } },
    urls: () => calls.filter(call => call[0] === 'fetch').map(call => call[1]),
  };
}
test('manual 3→2→1→0 captures FIRST, uploads fresh JPEG, and passes API schema to display', async () => {
  const f = fixture(); const pending = f.run('captureAndProcess()');
  assert.deepEqual(f.urls(), []); await f.countdown(); await pending;
  assert.deepEqual(f.numbers, [3, 2, 1, 0]);
  assert.deepEqual(f.urls(), ['/api/capture', '/api/latest-image', '/api/predict']);
  const upload = f.calls.find(call => call[1] === '/api/predict')[2];
  assert.equal(upload.method, 'POST');
  assert.equal(await upload.body.get('file').text(), await f.jpeg.text());
  assert.deepEqual(f.calls.find(call => call[0] === 'display').slice(1), [f.result, f.jpeg]);
  assert.equal(f.ctx.captureBtn.disabled, false);
  assert.equal(f.ctx.countdownOverlay.style.display, 'none');
});
test('double click cannot start two manual captures', async () => {
  const f = fixture(); const first = f.run('captureAndProcess()'); await f.run('captureAndProcess()');
  await f.countdown(); await first; assert.equal(f.urls().filter(url => url === '/api/capture').length, 1);
});
test('failed capture never classifies an old image; button recovers', async () => {
  const f = fixture({ captureFails: true }); const pending = f.run('captureAndProcess()');
  await f.countdown(); await pending;
  assert.deepEqual(f.urls(), ['/api/capture']); assert.match(f.errors[0], /Capture failed: 500/);
  assert.equal(f.ctx.captureBtn.disabled, false); assert.equal(f.ctx.countdownOverlay.style.display, 'none');
});
test('prediction failure reaches existing error handler and releases capture button', async () => {
  const f = fixture({ predictionFails: true }); const pending = f.run('captureAndProcess()');
  await f.countdown(); await pending;
  assert.match(f.errors[0], /Server error: 502/); assert.equal(f.ctx.captureBtn.disabled, false);
});
test('camera restarts reuse one SSE connection; zero and capture errors clear overlay', async () => {
  const f = fixture(); f.run('connectToEventStream(); connectToEventStream()');
  assert.equal(f.streams.length, 1);
  const handlers = f.streams[0].handlers;
  handlers.countdown({ data: '{"number":3}' }); assert.equal(f.ctx.countdownOverlay.style.display, 'flex');
  handlers.countdown({ data: '{"number":0}' }); assert.equal(f.ctx.countdownOverlay.style.display, 'none');
  handlers.capture_error({ data: '{"message":"Camera unavailable"}' });
  assert.match(f.errors[0], /Camera unavailable/); assert.deepEqual(f.urls(), []);
});
test('motion completion fetches and classifies existing server capture without capturing twice', async () => {
  const f = fixture(); f.run('connectToEventStream()'); await f.streams[0].handlers.image_captured({ data: '{}' });
  assert.deepEqual(f.urls(), ['/api/latest-image', '/api/predict']);
  assert.equal(f.ctx.countdownOverlay.style.display, 'none');
});
