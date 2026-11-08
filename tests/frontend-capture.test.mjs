import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Execute shipped functions. The current page has no replay IDs, watchdog or SSE deduplication.
const html = readFileSync(new URL('../frontend/static/index.html', import.meta.url), 'utf8');
const start = html.indexOf('        async function showCountdown()');
const end = html.indexOf('        let autoReturnTimer = null;', start);
assert.ok(start >= 0 && end > start, 'capture function boundaries must exist');
const code = html.slice(start, end);
function harness(overrides = {}) {
    const requests = [], errors = [], results = [], intervals = new Map(), events = new Map(), countdown = [];
    let serial = 0;
    const number = {};
    Object.defineProperty(number, 'textContent', { get: () => countdown.at(-1), set: value => countdown.push(value) });
    const ctx = {
        console: { info() {} }, Blob, FormData, Date, Promise,
        setInterval(fn) { const id = ++serial; intervals.set(id, fn); return id; },
        clearInterval(id) { intervals.delete(id); }, clearTimeout() {},
        EventSource: class { constructor(url) { this.url = url; } addEventListener(name, fn) { events.set(name, fn); } },
        usingPiCamera: true, stream: null, flipImage: false, uploadMode: false, autoReturnTimer: null,
        inferenceStartTime: 0, countdownOverlay: { style: {} }, countdownNumber: number, captureBtn: { disabled: false },
        video: { style: {}, videoWidth: 640, videoHeight: 480 },
        canvas: { getContext: () => ({ drawImage() {} }), toBlob: fn => fn(new Blob(['jpeg'])) },
        cameraFallback: { style: {} }, uploadBtn: { style: {} },
        PI_SERVICE: { status: '/api/status', capture: '/api/capture', latestImage: '/api/latest-image' },
        API_ENDPOINT: '/api/predict', performance: { now: () => 1 },
        setScanImage() {}, showPage() {}, loadingPage: {}, startScanTimer() {},
        displayResult: async data => results.push(data), showError: message => errors.push(message),
        fetch: async (url, options = {}) => {
            requests.push({ url, options });
            const response = await overrides.fetch?.(url, options);
            return response ?? { ok: true, status: 200, json: async () => ({ results: [{ item: 'Fixture' }] }),
                blob: async () => new Blob(['jpeg'], { type: 'image/jpeg' }) };
        }
    };
    vm.createContext(ctx); vm.runInContext(code, ctx);
    const run = expression => vm.runInContext(expression, ctx);
    const tickCountdown = () => { for (let i = 0; i < 3; i++) for (const fn of intervals.values()) fn(); };
    return { ctx, requests, errors, results, events, countdown, run, tickCountdown };
}

test('manual countdown reaches zero before fresh capture and multipart upload', async () => {
    const h = harness(); const pending = h.run('captureAndProcess()');
    assert.equal(h.ctx.captureBtn.disabled, true);
    assert.equal(h.requests.length, 0);
    h.tickCountdown(); await pending;
    assert.deepEqual(h.countdown, [3, 2, 1, 0]);
    assert.deepEqual(h.requests.map(x => x.url), ['/api/capture', '/api/latest-image', '/api/predict']);
    const upload = h.requests.at(-1).options;
    assert.equal(upload.method, 'POST');
    assert.equal(await upload.body.get('file').text(), 'jpeg');
    assert.equal(upload.body.get('file').name, 'capture.jpg');
    assert.equal(h.results.length, 1);
    assert.equal(h.ctx.captureBtn.disabled, false);
    assert.equal(h.ctx.countdownOverlay.style.display, 'none');
});

test('rapid manual Pi double click cannot create two captures', async () => {
    const h = harness(); const first = h.run('captureAndProcess()');
    await h.run('captureAndProcess()'); h.tickCountdown(); await first;
    assert.equal(h.requests.filter(x => x.url === '/api/capture').length, 1);
    assert.equal(h.results.length, 1);
});

test('motion events show countdown and process already captured JPEG without recapture', async () => {
    const h = harness(); h.run('connectToEventStream()');
    for (const number of [3, 2, 1, 0]) h.events.get('countdown')({ data: JSON.stringify({ number }) });
    assert.equal(h.ctx.countdownOverlay.style.display, 'none');
    await h.events.get('image_captured')({ data: '{}' });
    assert.deepEqual(h.requests.map(x => x.url), ['/api/latest-image', '/api/predict']);
    assert.equal(h.results.length, 1);
});

test('manual camera failure never processes a stale image and unlocks capture', async () => {
    const h = harness({ fetch: async url => url === '/api/capture' ? { ok: false, status: 503 } : undefined });
    const pending = h.run('captureAndProcess()'); h.tickCountdown(); await pending;
    assert.deepEqual(h.errors, ['Capture failed: 503']);
    assert.deepEqual(h.requests.map(x => x.url), ['/api/capture']);
    assert.equal(h.ctx.captureBtn.disabled, false);
});

test('motion capture error uses current message envelope and clears overlay', () => {
    const h = harness(); h.run('connectToEventStream()');
    h.events.get('countdown')({ data: '{"number":1}' });
    h.events.get('capture_error')({ data: '{"message":"camera failed"}' });
    assert.deepEqual(h.errors, ['Capture failed: camera failed']);
    assert.equal(h.ctx.countdownOverlay.style.display, 'none');
    assert.equal(h.requests.length, 0);
});

for (const failure of ['image', 'inference']) {
    test(`${failure} failure surfaces an error without displaying a result`, async () => {
        const h = harness({ fetch: async url =>
            url === (failure === 'image' ? '/api/latest-image' : '/api/predict') ? { ok: false, status: 502 } : undefined });
        const pending = h.run('captureAndProcess()'); h.tickCountdown(); await pending;
        assert.deepEqual(h.errors, [failure === 'image' ? 'Failed to process captured image: Failed to get captured image' : 'Server error: 502']);
        assert.equal(h.results.length, 0);
        assert.equal(h.ctx.captureBtn.disabled, false);
        if (failure === 'image') assert.equal(h.requests.some(x => x.url === '/api/predict'), false);
    });
}

test('event stream connection is reused for native reconnection', () => {
    const h = harness(); h.run('connectToEventStream()'); const first = h.run('eventSource');
    h.run('connectToEventStream()'); assert.equal(h.run('eventSource'), first);
    assert.equal(first.url, '/api/events');
});
