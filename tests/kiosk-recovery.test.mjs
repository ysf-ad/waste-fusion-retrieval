import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../frontend/static/index.html', import.meta.url), 'utf8');
const info = readFileSync(new URL('../frontend/static/result-info.js', import.meta.url), 'utf8');
const response = JSON.parse(readFileSync(new URL('../worker/deployment/2026-11-07-exact-upload/live-response.json', import.meta.url)));
const section = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
const source = info + section('        const arm =', '        const cameraFallback =')
  + section('        async function showCountdown()', '        async function startCamera()')
  + section('        async function processImage(', '        let autoReturnTimer = null;')
  + section('        async function displayResult(', '        async function savePhotoWithResults(')
  + section('        function resetCamera()', '        uploadBtn.addEventListener(');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(override) {
  const nodes = new Map(), timers = new Map(), calls = [], events = new Map();
  let now = 0, serial = 0;
  const element = () => ({ style: {}, children: [], textContent: '', open: false,
    replaceChildren(...children) { this.children = children; }, appendChild(child) { this.children.push(child); } });
  const get = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const jpeg = new Blob(['fixture JPEG'], { type: 'image/jpeg' });
  const timer = (fn, ms, repeat = false) => { const id = ++serial; timers.set(id, { fn, due: now + ms, ms, repeat }); return id; };
  const ctx = { document: { getElementById: get, createElement: element }, localStorage: { getItem: () => 'en' },
    AbortController, Blob, FormData, Date, console: { info() {} }, FileReader: class { readAsDataURL() {} },
    usingPiCamera: true, debugMode: false, uploadMode: false, autoReturnTimer: null,
    countdownOverlay: element(), countdownNumber: element(), captureBtn: element(), video: element(),
    cameraPage: element(), loadingPage: element(), resultPage: element(), errorContainer: element(),
    itemName: element(), whyText: element(), actionText: element(), binNameLarge: element(), largeIconContainer: element(), inferenceTimeDisplay: element(),
    PI_SERVICE: { capture: '/api/capture', latestImage: '/api/latest-image', stream: '/api/stream' }, API_ENDPOINT: '/api/predict',
    performance: { now: () => now }, startScanTimer() {}, setScanImage() {}, clearImagePreview() { ctx.clearedPreview = true; }, applyLayout() {},
    showPage(page) { ctx.currentPage = page; },
    setTimeout: (fn, ms) => timer(fn, ms), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => timer(fn, ms, true), clearInterval: id => timers.delete(id),
    EventSource: class { addEventListener(name, fn) { events.set(name, fn); } },
    async fetch(url, options = {}) { calls.push({ url, options }); return await override?.(url, options) ?? { ok: true, status: 200, blob: async () => jpeg, json: async () => response }; },
  };
  vm.createContext(ctx); vm.runInContext(source, ctx);
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const advance = async ms => {
    const until = now + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, t]) => t.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      const [id, t] = next; now = t.due;
      if (t.repeat) t.due += t.ms; else timers.delete(id);
      t.fn(); await flush();
    }
    now = until; await flush();
  };
  return { ctx, get, calls, events, advance, flush, run: code => vm.runInContext(code, ctx) };
}

test('results return home in five seconds even with Full response open; a second scan works', async () => {
  const f = fixture();
  for (let cycle = 0; cycle < 2; cycle++) {
    const pending = f.run('captureAndProcess()'); await f.advance(3000); await pending;
    assert.equal(f.ctx.currentPage, f.ctx.resultPage);
    f.get('api-details').open = true;
    await f.advance(4999); assert.equal(f.ctx.currentPage, f.ctx.resultPage);
    await f.advance(1); assert.equal(f.ctx.currentPage, f.ctx.cameraPage);
    assert.equal(f.ctx.captureBtn.disabled, false);
    assert.equal(f.get('api-details').open, false);
    assert.equal(f.ctx.video.src, '/api/stream');
  }
  assert.equal(f.calls.filter(c => c.url === '/api/predict').length, 2);
});

test('prediction errors also return home after five seconds', async () => {
  const f = fixture(url => url === '/api/predict' ? { ok: false, status: 503 } : undefined);
  const pending = f.run('captureAndProcess()'); await f.advance(3000); await pending;
  assert.match(f.ctx.errorContainer.textContent, /503/);
  assert.equal(f.ctx.currentPage, f.ctx.resultPage);
  await f.advance(5000);
  assert.equal(f.ctx.currentPage, f.ctx.cameraPage);
  assert.equal(f.ctx.errorContainer.style.display, 'none');
  assert.equal(f.ctx.countdownOverlay.style.display, 'none');
});

for (const stage of ['capture', 'image body', 'prediction body']) {
  test(`stalled ${stage} is aborted; late completion cannot reopen an expired result`, async () => {
    const late = deferred(); let signal;
    const f = fixture((url, options) => {
      if (stage === 'capture' && url === '/api/capture') { signal = options.signal; return late.promise; }
      if (stage === 'image body' && url === '/api/latest-image') { signal = options.signal; return { ok: true, blob: () => late.promise }; }
      if (stage === 'prediction body' && url === '/api/predict') { signal = options.signal; return { ok: true, json: () => late.promise }; }
    });
    const pending = f.run('captureAndProcess()'); await f.advance(3000);
    await f.advance(22000);
    assert.equal(signal.aborted, true);
    assert.match(f.ctx.errorContainer.textContent, /timed out/);
    await f.advance(5000); assert.equal(f.ctx.currentPage, f.ctx.cameraPage);
    late.resolve(stage === 'capture' ? { ok: true } : stage === 'image body' ? new Blob(['late JPEG']) : response);
    await f.flush(); await pending;
    assert.equal(f.ctx.currentPage, f.ctx.cameraPage);
    assert.equal(f.ctx.captureBtn.disabled, false);
  });
}

test('reset during countdown cancels capture, clears the overlay and re-enables the camera', async () => {
  const f = fixture(); const pending = f.run('captureAndProcess()');
  await f.advance(1000); f.run('resetCamera()'); await f.flush(); await pending;
  await f.advance(30000);
  assert.equal(f.calls.some(c => c.url === '/api/capture' || c.url === '/api/predict'), false);
  assert.equal(f.ctx.currentPage, f.ctx.cameraPage);
  assert.equal(f.ctx.captureBtn.disabled, false);
  assert.equal(f.ctx.countdownOverlay.style.display, 'none');
});

test('late motion completion without an active countdown is ignored', async () => {
  const f = fixture(); f.run('connectToEventStream()');
  await f.events.get('image_captured')({ data: '{}' });
  assert.equal(f.calls.length, 0);
  f.events.get('countdown')({ data: '{"number":3}' });
  await f.events.get('image_captured')({ data: '{}' });
  await f.events.get('image_captured')({ data: '{}' });
  assert.equal(f.calls.filter(c => c.url === '/api/predict').length, 1);
  await f.advance(5000); assert.equal(f.ctx.currentPage, f.ctx.cameraPage);
});

test('motion events during a displayed result cannot cancel its five-second return', async () => {
  const f = fixture(); f.run('connectToEventStream()');
  const pending = f.run('captureAndProcess()'); await f.advance(3000); await pending;
  f.events.get('countdown')({ data: '{"number":3}' });
  f.events.get('capture_error')({ data: '{"message":"stale failure"}' });
  await f.events.get('image_captured')({ data: '{}' });
  assert.equal(f.ctx.currentPage, f.ctx.resultPage);
  assert.equal(f.ctx.errorContainer.style.display, 'none');
  await f.advance(5000);
  assert.equal(f.ctx.currentPage, f.ctx.cameraPage);
  assert.equal(f.calls.filter(c => c.url === '/api/predict').length, 1);
});
