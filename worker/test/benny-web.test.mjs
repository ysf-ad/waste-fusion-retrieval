import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { buildBennyWeb } from '../scripts/build-benny-web.mjs';

// Run the real generated scripts and renderer. Only DOM/media/timers/network are
// fixtures. These tests never start a server, regenerate assets or call a model.
const page = await buildBennyWeb();
const load = name => readFile(new URL(`../../frontend/static/${name}`, import.meta.url), 'utf8');
const [kiosk, info, orientation, web, shipped] = await Promise.all([
    load('index.html'), load('result-info.js'), load('camera-orientation.js'), load('benny-web.js'),
    readFile(new URL('../public/benny.html', import.meta.url), 'utf8')
]);
const lf = text => text.replaceAll('\r\n', '\n');
const escapedScript = text => text.replace(/<\/script/gi, '<\\/script');

function harness({ protocol = 'file:', health = { ready: true, modes: ['exact'], rate_limit_enforced: true, kiosk_open_set: true },
    healthOK = true, healthWait = null, predictionWait = null, dimensions = [640, 480], encodedSize = 500, mime = 'image/jpeg', predictionStatus = 200,
    prediction = { status: 'catalog_match', selected_item: 'Fixture live can', policy_category: 'Blue Bin', match_probability: .94, instructions: ['Fixture instruction'], automatic_routing_enabled: false },
    storage = new Map(), storageAvailable = true, storageThrows = false } = {}) {
    const requests = [], bitmaps = [], canvases = [], timers = new Map(), blobs = new Map();
    let cameraCalls = 0, eventSources = 0, serial = 0;
    class Element {
        constructor(id = '') {
            this.id = id; this.style = { setProperty(key, value) { this[key] = value; } };
            this.className = ''; this.dataset = {}; this.hidden = false; this.disabled = false;
            this.checked = false; this.files = []; this.children = []; this.handlers = new Map(); this.textContent = '';
            const tokens = () => new Set(this.className.split(/\s+/).filter(Boolean));
            this.classList = {
                add: (...names) => { this.className = [...new Set([...tokens(), ...names])].join(' '); },
                remove: (...names) => { this.className = [...tokens()].filter(n => !names.includes(n)).join(' '); },
                contains: name => tokens().has(name),
                toggle: (name, force) => {
                    const next = force ?? !tokens().has(name);
                    this.classList[next ? 'add' : 'remove'](name); return next;
                }
            };
        }
        addEventListener(name, fn) { this.handlers.set(name, [...(this.handlers.get(name) || []), fn]); }
        async fire(name, event = {}) { for (const fn of this.handlers.get(name) || []) await fn({ target: this, currentTarget: this, ...event }); }
        click() { return this.fire('click'); }
        appendChild(child) { this.children.push(child); return child; }
        insertBefore(child) { return this.appendChild(child); }
        replaceChildren(...children) { this.children = children; }
        setAttribute(name, value) { this[name] = String(value); }
        removeAttribute(name) { delete this[name]; }
        getAttribute(name) { return this[name] ?? null; }
        showModal() { this.open = true; }
        close() { this.open = false; }
        set value(value) { this._value = value; if (value === '') this.files = []; }
        get value() { return this._value || ''; }
    }
    const elements = new Map();
    const get = id => {
        if (!elements.has(id)) elements.set(id, new Element(id));
        return elements.get(id);
    };
    for (const tag of page.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
        const element = get(tag[1]);
        element.hidden = /\bhidden(?:\s|>|=)/.test(tag[0]);
        element.disabled = /\bdisabled(?:\s|>|=)/.test(tag[0]);
        element.className = /\bclass="([^"]*)"/.exec(tag[0])?.[1] || '';
        element.checked = /\bchecked(?:\s|>|=)/.test(tag[0]);
        const pressed = /aria-pressed="([^"]*)"/.exec(tag[0]);
        if (pressed) element.setAttribute('aria-pressed', pressed[1]);
        if (/style="[^"]*display:\s*none/.test(tag[0])) element.style.display = 'none';
    }
    const buttons = ['can', 'hand', 'wood'].map(id => {
        const button = new Element(); button.dataset.example = id;
        const image = new Element(); button.querySelector = () => image; return button;
    });
    get('web-demo').querySelectorAll = () => buttons;
    const document = { getElementById: get, documentElement: get('html-root'), body: new Element('body'),
        querySelector: () => get('native-help'), querySelectorAll: () => [],
        createElement: tag => {
            const element = new Element();
            if (tag === 'canvas') {
                const drawing = { fillRect() {}, drawImage(...args) { element.drawArgs = args; } };
                element.getContext = () => drawing;
                element.toBlob = (fn, type, quality) => { element.encodeType = type; element.quality = quality; fn(new Blob([new Uint8Array(encodedSize)], { type })); };
                canvases.push(element);
            }
            return element;
        } };
    get('canvas-display').getContext = () => ({ drawImage() {} });
    get('canvas-display').toDataURL = () => 'data:image/jpeg;base64,AA==';
    const stored = new Map();
    const context = vm.createContext({ document, location: { protocol }, console,
        Blob, FormData, AbortController, AbortSignal, atob,
        FileReader: class { readAsDataURL() { this.onload({ target: { result: 'data:image/jpeg;base64,AA==' } }); } },
        Image: class { constructor() { this.width = dimensions[0]; this.height = dimensions[1]; } set src(value) { this._src = value; this.onload(); } },
        URL: { createObjectURL(blob) { const url = `blob:fixture-${++serial}`; blobs.set(url, blob); return url; }, revokeObjectURL(url) { blobs.delete(url); } },
        performance: { now: () => 100 }, localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)) },
        setTimeout(fn, delay) { const id = ++serial; timers.set(id, { fn, delay }); return id; },
        clearTimeout: id => timers.delete(id), setInterval: () => ++serial, clearInterval() {},
        navigator: { mediaDevices: { getUserMedia() { cameraCalls++; throw new Error('Camera forbidden in web tests'); } } },
        EventSource: class { constructor() { eventSources++; throw new Error('SSE forbidden in web tests'); } },
        createImageBitmap: async (file, options) => {
            const bitmap = { width: dimensions[0], height: dimensions[1], closed: false, close() { this.closed = true; } };
            bitmaps.push({ file, options, bitmap }); return bitmap;
        },
        fetch: async (url, options = {}) => {
            requests.push({ url, options });
            if (url === '/api/health') { if (healthWait) await healthWait; return { ok: healthOK, json: async () => health }; }
            if (['/predict', '/api/classify'].includes(url)) {
                if (predictionWait) await predictionWait;
                return { ok: predictionStatus === 200, status: predictionStatus,
                    json: async () => predictionStatus === 200 ? prediction : { error: 'Fixture provider failure' } };
            }
            throw new Error(`Unexpected network request: ${url}`);
        }
    });
    if (storageAvailable) context.sessionStorage = {
        getItem(key) { if (storageThrows) throw new Error('Storage unavailable'); return storage.get(key) ?? null; },
        setItem(key, value) { if (storageThrows) throw new Error('Storage unavailable'); storage.set(key, String(value)); },
        removeItem(key) { if (storageThrows) throw new Error('Storage unavailable'); storage.delete(key); }
    };
    context.window = context;
    // Camera behavior has dedicated tests; these web-control tests prohibit media.
    context.BennyCamera = { attach: () => ({ close() {} }) };
    context.addEventListener = () => {};
    for (const script of page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) vm.runInContext(script[1], context);
    const choosePending = id => buttons.find(button => button.dataset.example === id).click();
    async function flushReplay() {
        for (let i = 0; i < 40; i++) await Promise.resolve();
        for (const [id, timer] of timers) if (timer.delay >= 250 && timer.delay <= 3000) { timers.delete(id); timer.fn(); }
    }
    const choose = async id => { const pending = choosePending(id); await flushReplay(); return pending; };
    async function selectPhoto(inputId = 'web-file') {
        const original = new Blob(['original-photo'], { type: mime });
        get(inputId).files = [original];
        await get(inputId).fire('change');
        return original;
    }
    async function simulate() { if (get('web-simulate').getAttribute('aria-pressed') !== 'true') await get('web-simulate').click(); }
    return { context, get, choose, choosePending, flushReplay, selectPhoto, simulate, requests, bitmaps, canvases, blobs, timers, storage,
        cameraCalls: () => cameraCalls, eventSources: () => eventSources };
}

test('checked-in Benny artifact matches deterministic build without writing generation output', async () => {
    assert.ok(lf(shipped) === lf(page), 'Generated Benny artifact is stale: run build-benny-web.mjs after changing the kiosk or adapter');
    assert.equal(await buildBennyWeb(), page);
});

test('web embeds actual kiosk renderer, adapter and orientation helper, not a second renderer', () => {
    for (const script of [info, orientation, web]) assert.ok(page.includes(escapedScript(script)));
    const start = kiosk.indexOf('        async function displayResult(');
    const end = kiosk.indexOf('        function scheduleAutoReturn()', start);
    assert.ok(start > 0 && end > start);
    assert.ok(page.includes(kiosk.slice(start, end)), 'The result renderer must remain byte-for-byte shared');
    assert.equal((page.match(/async function displayResult\(/g) || []).length, 1);
});

test('file demo is self-contained: exactly three selectable examples, no external assets or initial stream', () => {
    const ids = [...page.matchAll(/<button\b[^>]*data-example="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(ids, ['can', 'hand', 'wood']);
    assert.doesNotMatch(page, /<(?:script|link|img)\b[^>]*(?:src|href)="https?:\/\//i);
    assert.doesNotMatch(page, /<img\b[^>]*src="\/api\/stream"/i);
    assert.doesNotMatch(page, /<script\b[^>]*\bsrc=/i);
    assert.match(page, /<button\b[^>]*id="web-simulate"[^>]*aria-pressed="false"/);
    assert.doesNotMatch(page, /type="checkbox"|id="web-consent"/);
    assert.match(page, /simulat/i);
});

test('all real sample clicks render offline; hand and wood never receive a bin; Back and save stay offline', async () => {
    const h = harness();
    assert.equal(h.get('web-live').hidden, true);
    assert.equal(h.get('capture-btn').style.display, 'none');
    assert.equal(h.get('upload-btn').style.display, 'none');
    assert.equal(h.get('camera-wrapper').hidden, true);
    assert.equal(h.get('web-demo').hidden, false);
    for (const [id, expected, bin] of [['can', 'Aluminum can', 'Blue Bin'], ['hand', 'No waste item detected', ''], ['wood', 'Item not confirmed', '']]) {
        await h.choose(id);
        assert.equal(h.get('item-name').textContent, expected);
        assert.equal(h.get('bin-name-large').textContent, bin);
        assert.equal(h.get('result-page').classList.contains('active'), true);
        assert.equal(h.get('web-live-timing').hidden, true);
        assert.match(h.get('web-output-kind').textContent, /Sample.*no live inference/);
        assert.match(h.get('image-preview-label').textContent, /Sample photo/);
        const photo = h.blobs.get(h.get('result-image').src);
        assert.equal(photo.type, 'image/jpeg');
        assert.deepEqual([...new Uint8Array(await photo.slice(0,3).arrayBuffer())], [255,216,255]);
        assert.equal(h.get('result-image').src, h.get('scan-image').src);
        await h.get('back-btn').click();
        assert.equal(h.get('camera-page').classList.contains('active'), true);
    }
    await vm.runInContext("savePhotoWithResults('data:image/jpeg;base64,AA==',{},1)", h.context);
    assert.deepEqual(h.requests, []);
    assert.equal(h.cameraCalls(), 0); assert.equal(h.eventSources(), 0);
    assert.equal([...h.timers.values()].filter(timer => timer.delay === 5000).length, 0);
});

test('own-photo inputs are primary, mobile camera capture is explicit and neither picker autostarts inference', async () => {
    assert.match(page, /<section\b[^>]*id="web-live"/);
    const camera = /<input\b[^>]*id="web-camera-file"[^>]*>/.exec(page)?.[0];
    assert.ok(camera, 'Mobile camera input must exist');
    assert.match(camera, /accept="image\/jpeg,image\/png"/);
    assert.match(camera, /capture="environment"/);
    const regular = /<input\b[^>]*id="web-file"[^>]*>/.exec(page)?.[0];
    assert.ok(regular); assert.doesNotMatch(regular, /\bcapture=/);
    assert.ok(page.indexOf('id="web-live"') < page.indexOf('class="web-example-grid"'), 'Own-photo controls must precede gallery');
    const h = harness({ protocol: 'https:' });
    assert.equal(h.get('web-live').hidden, false);
    assert.equal(h.get('web-simulate').getAttribute('aria-pressed'), 'false');
    for (const id of ['web-file', 'web-camera-file']) {
        h.get(id).files = [new Blob(['selected'], { type: 'image/jpeg' })];
        await h.get(id).fire('change');
        assert.equal(h.get('web-submit').disabled, false);
    }
    assert.deepEqual(h.requests, []); assert.equal(h.cameraCalls(), 0);
});

for (const protocol of ['http:', 'https:']) test(`${protocol} gallery first click makes one live exact request; load itself is idle`, async () => {
    const h = harness({ protocol });
    assert.deepEqual(h.requests, []);
    await h.choose('can');
    assert.deepEqual(h.requests.map(request => request.url), ['/api/health', '/predict']);
    assert.equal(h.requests[0].options.method || 'GET', 'GET');
    assert.equal(h.requests[1].options.method, 'POST');
    assert.equal(h.requests[1].options.body.get('mode'), 'exact');
    assert.equal(h.requests[1].options.body.get('file').type, 'image/jpeg');
    assert.equal(h.get('item-name').textContent, 'Fixture live can');
    assert.match(h.get('why-text').textContent, /Model confidence:\s*94%/);
    assert.match(h.get('web-output-kind').textContent, /Live.*exact/i);
    assert.doesNotMatch(h.get('web-output-kind').textContent, /simulat|no live inference/i);
    assert.equal(h.get('web-live-timing').hidden, false);
    assert.equal(h.cameraCalls(), 0); assert.equal(h.eventSources(), 0);
});

test('HTTP simulation toggle renders all three fixtures offline with decision-specific confidence', async () => {
    const h = harness({ protocol: 'https:' });
    await h.simulate();
    for (const [id, name, bin] of [['can', 'Aluminum can', 'Blue Bin'], ['hand', 'No waste item detected', ''], ['wood', 'Item not confirmed', '']]) {
        await h.choose(id);
        assert.equal(h.get('item-name').textContent, name);
        assert.equal(h.get('bin-name-large').textContent, bin);
        assert.match(h.get('web-output-kind').textContent, /simulat|no live inference/i);
        if (id === 'can') assert.match(h.get('why-text').textContent, /Model confidence:\s*96%/);
        else assert.match(h.get('why-text').textContent, id === 'hand' ? /Model confidence:\s*97%/ : /Model confidence:\s*89%/);
        await h.get('back-btn').click();
    }
    assert.deepEqual(h.requests, []); assert.equal(h.bitmaps.length, 0);
});

test('simulation is a reversible aria toggle and file URLs can never become live', async () => {
    const h=harness({protocol:'https:'});await h.get('web-simulate').click();assert.equal(h.get('web-simulate').getAttribute('aria-pressed'),'true');await h.choose('hand');assert.deepEqual(h.requests,[]);await h.get('back-btn').click();await h.get('web-simulate').click();assert.equal(h.get('web-simulate').getAttribute('aria-pressed'),'false');await h.choose('can');assert.equal(h.requests.filter(r=>r.options.method==='POST').length,1);
    const offline=harness();await offline.get('web-simulate').click();await offline.choose('can');await offline.get('back-btn').click();await offline.get('web-simulate').click();await offline.choose('hand');assert.deepEqual(offline.requests,[]);
});

for(const [duration,expected] of [[1250,1250],[0,250],[-20,250],[99999,3000],[undefined,650],[null,650]])test(`cached replay duration ${duration} uses bounded timer ${expected} with no request`,async()=>{
    const warm=harness({protocol:'https:'});await warm.choose('can');assert.equal(warm.requests.length,2);
    for(const [key,value] of warm.storage){const entry=JSON.parse(value);assert.equal(typeof entry.result.demo_replay_ms,'number');if(duration===undefined)delete entry.result.demo_replay_ms;else entry.result.demo_replay_ms=duration;warm.storage.set(key,JSON.stringify(entry));}
    const h=harness({protocol:'https:',storage:warm.storage});await h.selectPhoto();const pending=h.choosePending('can');
    for(let i=0;i<40;i++)await Promise.resolve();
    assert.equal(h.get('loading-page').classList.contains('active'),true);assert.equal(h.get('web-submit').disabled,true);assert.equal(h.get('result-page').classList.contains('active'),false);
    assert([...h.timers.values()].some(timer=>timer.delay===expected),`Expected replay timer ${expected}`);
    await h.choosePending('hand');await h.get('web-submit').click();assert.deepEqual(h.requests,[]);
    await h.flushReplay();await pending;assert.deepEqual(h.requests,[]);assert.equal(h.get('item-name').textContent,'Fixture live can');assert.match(h.get('web-output-kind').textContent,/Cached.*no new request/);assert.equal(h.get('web-live-timing').hidden,true);assert.match(h.get('why-text').textContent,/Model confidence:\s*94%/);assert.equal(h.get('web-submit').disabled,false);
});

test('gallery and personal upload share one in-flight guard through health and inference', async () => {
    let releaseHealth, releasePrediction;
    const h = harness({ protocol: 'https:', healthWait: new Promise(resolve => { releaseHealth = resolve; }),
        predictionWait: new Promise(resolve => { releasePrediction = resolve; }) });
    await h.selectPhoto();
    const pending = h.choose('can');
    await h.choose('hand'); await h.get('web-submit').click();
    assert.deepEqual(h.requests.map(request => request.url), ['/api/health']);
    releaseHealth();
    // Flush only in-memory preparation microtasks; do not wait on wall-clock/network.
    for (let i = 0; i < 20 && h.requests.length < 2; i++) await Promise.resolve();
    assert.equal(h.requests.length, 2);
    await h.choose('wood'); await h.get('web-submit').click();
    assert.equal(h.requests.length, 2);
    releasePrediction(); await pending;
    assert.equal(h.requests.length, 2);
});

test('successful gallery response is reused in its tab; different photo still needs a live request', async () => {
    const h = harness({ protocol: 'https:' });
    await h.choose('can'); await h.get('back-btn').click(); await h.choose('can');
    assert.equal(h.requests.length, 2);
    assert.match(h.get('web-output-kind').textContent, /live|cached/i);
    await h.get('back-btn').click(); await h.choose('hand');
    assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 2);
    assert.ok(h.storage.size > 0);
    const sameTab = harness({ protocol: 'https:', storage: h.storage });
    await sameTab.choose('can'); assert.deepEqual(sameTab.requests, []);
    const freshTab = harness({ protocol: 'https:' });
    await freshTab.choose('can'); assert.equal(freshTab.requests.length, 2);
});

test('gallery cache is build-scoped, expires, and malformed entries fail open to a new guarded live request', async () => {
    const h = harness({ protocol: 'https:' });
    assert.ok(typeof h.context.BennyExampleCacheVersion === 'string' && h.context.BennyExampleCacheVersion.length > 0);
    await h.choose('can');
    assert.equal(h.requests.length, 2);
    h.context.BennyExampleCacheVersion = 'different-build';
    await h.get('back-btn').click(); await h.choose('can');
    assert.equal(h.requests.length, 4, 'Different build cannot reuse the previous response');
    for (const [key, value] of h.storage) h.storage.set(key, JSON.stringify({ ...JSON.parse(value), until: 0 }));
    await h.get('back-btn').click(); await h.choose('can');
    assert.equal(h.requests.length, 6, 'Expired result must be fetched again');
    for (const key of h.storage.keys()) h.storage.set(key, 'invalid-json');
    await h.get('back-btn').click(); await h.choose('can');
    assert.equal(h.requests.length, 8);
});

test('gallery failures are never cached and simulated fallback stays explicitly offline', async () => {
    const h = harness({ protocol: 'https:', predictionStatus: 503 });
    await h.choose('can'); await h.get('back-btn').click(); await h.choose('can');
    assert.equal(h.requests.length, 4); assert.equal(h.storage.size, 0);
    assert.equal(h.get('item-name').textContent, 'Unable to identify item');
    await h.get('back-btn').click(); await h.simulate(); await h.choose('can');
    assert.equal(h.requests.length, 4);
    assert.equal(h.get('item-name').textContent, 'Aluminum can');
    assert.match(h.get('web-output-kind').textContent, /Sample.*no live inference/);
});

for (const option of [{ storageAvailable: false }, { storageThrows: true }]) test(`gallery works when sessionStorage ${option.storageThrows ? 'throws' : 'is missing'}`, async () => {
    const h = harness({ protocol: 'https:', ...option });
    await h.choose('can');
    assert.equal(h.get('item-name').textContent, 'Fixture live can');
    assert.equal(h.requests.length, 2);
});

test('personal uploads are never cached even when the same photo is chosen twice', async () => {
    const h = harness({ protocol: 'https:' });
    for (let i = 0; i < 2; i++) { await h.selectPhoto(); await h.get('web-submit').click(); await h.get('back-btn').click(); }
    assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 2);
    assert.equal(h.storage.size, 0);
});

for (const [label, prediction, score] of [
    ['human subject', {status:'no_item',no_item_reason:'human_only',observed:{subject:{choice:'human_only',p:.91}},match_probability:.99}, '91%'],
    ['empty subject', {status:'no_item',no_item_reason:'no_item',observed:{subject:{choice:'no_item',p:.92}}}, '92%'],
    ['mismatched subject', {status:'no_item',no_item_reason:'human_only',observed:{subject:{choice:'single_item',p:.99}},match_probability:.99}, 'unavailable'],
    ['missing subject', {status:'no_item',no_item_reason:'human_only',match_probability:.99}, 'unavailable'],
    ['none match', {status:'manual_review',selected_item:null,observed:{match:{choice:'none',p:.89}},match_probability:.99}, '89%'],
    ['unknown subject', {status:'manual_review',selected_item:null,observed:{subject:{choice:'unknown',p:.84}}}, '84%'],
    ['competing subjects', {status:'manual_review',selected_item:null,observed:{subject:{choice:'multiple_items',p:.85}}}, '85%'],
    ['unrelated named score', {status:'manual_review',selected_item:null,observed:{match:{choice:'item_0',p:.99}},match_probability:.99}, 'unavailable'],
    ['old material response', {status:'material_only',selected_material:'wood',material_probability:.99,selected_item:null}, 'unavailable'],
    ['tentative candidate', {status:'catalog_match',selected_item:'Tentative can',identity_uncertain:true,match_probability:.99,policy_category:'Blue Bin'}, 'unavailable'],
    ['out-of-range subject', {status:'no_item',no_item_reason:'human_only',observed:{subject:{choice:'human_only',p:1.1}}}, 'unavailable'],
]) test(`live ${label} confidence uses only relevant evidence and never guesses a bin`, async () => {
    const h = harness({ protocol: 'https:', prediction });
    await h.choose('wood');
    assert.equal(h.get('why-text').textContent, `Model confidence: ${score}`);
    assert.equal(h.get('bin-name-large').textContent, '');
    assert.doesNotMatch(h.get('item-name').textContent, /looks like|tentative can/i);
});
test('recognized response without a confidence score says unavailable, retaining its catalog result', async () => {
    const h=harness({protocol:'https:',prediction:{status:'catalog_match',selected_item:'Known can',policy_category:'Blue Bin',instructions:['Empty first.']}});
    await h.choose('can');assert.equal(h.get('why-text').textContent,'Model confidence: unavailable');assert.equal(h.get('item-name').textContent,'Known can');assert.equal(h.get('bin-name-large').textContent,'Blue Bin');
});

test('switching personal pickers clears the old file and Analyze alone uploads the new selection', async () => {
    const h = harness({ protocol: 'https:' });
    await h.selectPhoto('web-file');
    assert.equal(h.get('web-submit').disabled, false);
    h.get('web-camera-file').files = [new Blob(['camera'], { type: 'image/jpeg' })];
    await h.get('web-camera-file').fire('change');
    assert.deepEqual(h.get('web-file').files, []);
    assert.equal(h.get('web-submit').disabled, false);
    h.get('web-file').files = [new Blob(['other'], { type: 'image/jpeg' })];
    await h.get('web-file').fire('change');
    assert.deepEqual(h.get('web-camera-file').files, []);
    assert.equal(h.get('web-submit').disabled, false);
    assert.deepEqual(h.requests, []);
    await h.get('web-submit').click();
    assert.equal(h.requests.filter(r => r.options.method === 'POST').length, 1);
});

test('mobile camera selection uses the same explicit Analyze and exact preparation path', async () => {
    const h = harness({ protocol: 'https:' });
    const original = await h.selectPhoto('web-camera-file');
    await h.get('web-submit').click();
    assert.deepEqual(h.requests.map(request => request.url), ['/api/health', '/predict']);
    assert.equal(h.blobs.get(h.get('result-image').src), original);
    assert.equal(h.requests[1].options.body.get('mode'), 'exact');
    assert.equal(h.cameraCalls(), 0, 'Native capture picker must not request getUserMedia itself');
});

test('sample payloads are visibly marked fixtures and invalid sample IDs fail locally', () => {
    const h = harness();
    for (const id of ['can', 'hand', 'wood']) {
        const sample = h.context.BennyWeb.chooseSample(id);
        assert.equal(sample.result.fixture, true);
        assert.equal(sample.result.build_id, 'benny-demo-sample');
        assert.equal(sample.result.automatic_routing_enabled, false);
    }
    assert.throws(() => h.context.BennyWeb.chooseSample('unknown'), /Unknown demo example/);
});

test('HTTP startup and explicit simulation are offline; personal photo selection waits for Analyze', async () => {
    const h = harness({ protocol: 'https:' });
    assert.equal(h.get('web-live').hidden, false);assert.equal(h.get('web-submit').disabled, true);
    await h.get('web-submit').click();
    await h.selectPhoto();assert.equal(h.get('web-submit').disabled, false);
    assert.deepEqual(h.requests, []);
    await h.simulate();await h.choose('can');assert.deepEqual(h.requests, []);assert.equal(h.bitmaps.length,0);
    await h.get('back-btn').click();await h.get('web-submit').click();
    assert.deepEqual(h.requests.map(r=>r.url),['/api/health','/predict']);
});

const healthFailures = [
    ['unavailable health', {}, false], ['unconfigured provider', { ready: false, modes: ['exact'], rate_limit_enforced: true, kiosk_open_set: true }, true],
    ['missing exact mode', { ready: true, modes: ['compact'], rate_limit_enforced: true, kiosk_open_set: true }, true],
    ['unconfirmed limiter', { ready: true, modes: ['exact'], rate_limit_enforced: false, kiosk_open_set: true }, true],
    ['old backend without open-set contract', { ready: true, modes: ['exact'], rate_limit_enforced: true }, true]
];
for (const [label, health, healthOK] of healthFailures) test(`live gate sends no photo when ${label}`, async () => {
    const h = harness({ protocol: 'http:', health, healthOK });
    await h.selectPhoto(); await h.get('web-submit').click();
    assert.deepEqual(h.requests.map(request => request.url), ['/api/health']);
    assert.equal(h.bitmaps.length, 0);
    assert.equal(h.get('web-submit').disabled, false, 'A health failure may be explicitly retried; it never uploads automatically');
    assert.notEqual(h.get('web-status').textContent, '');
});

for (const [label, health, healthOK] of healthFailures) test(`gallery gate sends no photo when ${label}`, async () => {
    const h = harness({ protocol: 'https:', health, healthOK });
    await h.choose('can');
    assert.deepEqual(h.requests.map(request => request.url), ['/api/health']);
    assert.equal(h.storage.size, 0); assert.equal(h.bitmaps.length, 0);
    assert.notEqual(h.get('web-example-status').textContent, '');
});

test('opted-in live sends one prepared exact multipart to real Worker route and previews original only', async () => {
    const h = harness({ protocol: 'https:', dimensions: [4000, 100] });
    const original = await h.selectPhoto();
    assert.equal(h.get('web-submit').disabled, false);
    await h.get('web-submit').click();
    assert.equal(h.requests.length, 2, h.requests.map(request => request.url).join(','));
    assert.equal(h.requests[0].url, '/api/health');
    assert.equal(h.requests[0].options.cache, 'no-store');
    const inference = h.requests[1];
    assert.ok(['/predict', '/api/classify'].includes(inference.url), `Unsupported real Worker inference route: ${inference.url}`);
    assert.equal(inference.options.method, 'POST');
    assert.equal(inference.options.body.get('mode'), 'exact');
    const payload = inference.options.body.get('file');
    assert.equal(payload.type, 'image/jpeg'); assert.equal(payload.size, 500);
    assert.notEqual(await payload.text(), await original.text());
    assert.equal(h.blobs.get(h.get('result-image').src), original);
    assert.equal(h.get('item-name').textContent, 'Fixture live can');
    assert.match(h.get('web-output-kind').textContent, /^Live exact-mode result$/);
    assert.equal(h.get('web-live-timing').hidden, false);
    assert.equal(h.bitmaps[0].options.imageOrientation, 'from-image');
    assert.equal(h.bitmaps[0].bitmap.closed, true);
    assert.equal(h.canvases[0].width, 1568); assert.equal(h.canvases[0].height, 280);
    assert.equal(h.get('web-submit').disabled, true);
    await h.get('web-submit').click(); assert.equal(h.requests.length, 2);
    assert.equal(h.cameraCalls(), 0); assert.equal(h.eventSources(), 0);
});

test('in-flight health cannot be bypassed by double clicking or changing simulation', async () => {
    let release;
    const healthWait = new Promise(resolve => { release = resolve; });
    const h = harness({ protocol: 'https:', healthWait });
    await h.selectPhoto();
    const pending = h.get('web-submit').click();
    await h.choose('can');
    assert.equal(h.get('web-submit').disabled, true);
    await h.get('web-simulate').click();
    assert.equal(h.get('web-simulate').getAttribute('aria-pressed'), 'false');
    assert.equal(h.get('web-submit').disabled, true);
    await h.get('web-submit').click();
    assert.deepEqual(h.requests.map(request => request.url), ['/api/health']);
    release(); await pending;
    assert.equal(h.requests.length, 2);
    assert.equal(h.get('web-submit').disabled, true);
});

test('provider error retains current original photo, clears prior bin, saves nothing and samples remain usable', async () => {
    const h = harness({ protocol: 'https:', predictionStatus: 503 });
    await h.simulate(); await h.choose('can');
    const original = await h.selectPhoto(); await h.get('web-submit').click();
    assert.equal(h.get('bin-name-large').textContent, 'NOT CONFIRMED');
    assert.equal(h.get('item-name').textContent, 'Unable to identify item');
    assert.equal(h.blobs.get(h.get('result-image').src), original);
    assert.equal(h.requests.length, 2);
    assert.equal(h.get('web-submit').disabled, true);
    await h.get('back-btn').click(); await h.choose('wood');
    assert.equal(h.get('item-name').textContent, 'Item not confirmed');
    assert.equal(h.get('bin-name-large').textContent, '');
    assert.equal(h.get('error-container').style.display, 'none');
    assert.equal(h.requests.length, 2);
});

for (const size of [0, 10_000_001]) test(`live rejects input byte bound ${size} without decode/inference`, async () => {
    const h = harness({ protocol: 'https:' });
    await h.selectPhoto(); h.get('web-file').files = [{ type: 'image/jpeg', size }];
    await h.get('web-submit').click();
    assert.deepEqual(h.requests.map(request => request.url), ['/api/health']);
    assert.equal(h.bitmaps.length, 0);
});

for (const [label, options] of [['unsupported MIME', { mime: 'image/gif' }], ['decoded pixel bound', { dimensions: [6000, 5000] }], ['JPEG encode cap', { encodedSize: 2_500_001 }]]) {
    test(`live preparation rejects ${label} before any inference`, async () => {
        const h = harness({ protocol: 'https:', ...options });
        await h.selectPhoto(); await h.get('web-submit').click();
        assert.deepEqual(h.requests.map(request => request.url), ['/api/health']);
            for (const { bitmap } of h.bitmaps) assert.equal(bitmap.closed, true);
    });
}
