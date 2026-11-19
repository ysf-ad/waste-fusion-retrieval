import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { File } from 'node:buffer';

// Real browser-camera helper; fake DOM/media/encoding only. No server, hardware,
// permission prompt, network, storage, paid inference or generation writes.
const code = await readFile(new URL('../../frontend/static/benny-camera.js', import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function media(name = 'camera') {
    const tracks = [{ stopped: 0, stop() { this.stopped++; } }, { stopped: 0, stop() { this.stopped++; } }];
    return { name, tracks, getTracks: () => tracks };
}
function fixture({ secure = true, available = true, getMedia, play, enabled = () => true,
    width = 640, height = 480, readyState = 4, nativeFallback = true,
    blob = new Blob(['camera-jpeg'], { type: 'image/jpeg' }), deferEncoding = false } = {}) {
    const elements = new Map(), events = new Map(), calls = [], photos = [], canvases = [], encodingCallbacks = [];
    const defaultStream = media();
    let networkCalls = 0, snapshotAtPhoto;
    class Element {
        constructor(id) { this.id = id; this.hidden = false; this.disabled = false; this.textContent = ''; this.handlers = new Map(); }
        addEventListener(name, fn) { this.handlers.set(name, [...(this.handlers.get(name) || []), fn]); }
        async fire(name) { for (const fn of this.handlers.get(name) || []) await fn({ target: this, currentTarget: this }); }
        click() { return this.fire('click'); }
    }
    for (const id of ['open', 'panel', 'video', 'snap', 'close', 'status']) elements.set(`web-camera-${id}`, new Element(id));
    if (nativeFallback) elements.set('web-native-camera', new Element('fallback'));
    const get = suffix => elements.get(suffix.startsWith('web-') ? suffix : `web-camera-${suffix}`);
    get('panel').hidden = true; get('snap').disabled = true;
    if (nativeFallback) get('web-native-camera').hidden = true;
    const video = get('video');
    Object.assign(video, { videoWidth: width, videoHeight: height, readyState, srcObject: null, playCalls: 0,
        async play() { this.playCalls++; if (play) await play(); } });
    const document = { getElementById: id => elements.get(id) || null, createElement(tag) {
        assert.equal(tag, 'canvas');
        const canvas = { width: 0, height: 0, getContext(type, options) {
            assert.equal(type, '2d'); this.contextOptions = options;
            return { drawImage: (...args) => { canvas.drawArgs = args; } };
        }, toBlob(fn, type, quality) {
            canvas.mime = type; canvas.quality = quality;
            if (deferEncoding) encodingCallbacks.push(() => fn(blob)); else fn(blob);
        } };
        canvases.push(canvas); return canvas;
    } };
    const context = vm.createContext({ document, Blob, File,
        navigator: { ...(available ? { mediaDevices: { async getUserMedia(constraints) {
            calls.push(constraints); return getMedia ? await getMedia() : defaultStream;
        } } } : {}) },
        fetch() { networkCalls++; throw new Error('Camera helper must never send HTTP'); }
    });
    context.window = context;
    context.isSecureContext = secure;
    context.addEventListener = (name, fn) => events.set(name, [...(events.get(name) || []), fn]);
    vm.runInContext(code, context);
    const api = context.BennyCamera.attach({ enabled, onPhoto(photo) {
        snapshotAtPhoto = { srcObject: video.srcObject, panelHidden: get('panel').hidden,
            stopped: defaultStream.tracks.every(track => track.stopped > 0) };
        photos.push(photo);
    } });
    async function pagehide() { for (const fn of events.get('pagehide') || []) await fn(); }
    return { api, context, get, video, calls, photos, canvases, encodingCallbacks, defaultStream, pagehide,
        networkCalls: () => networkCalls, snapshotAtPhoto: () => snapshotAtPhoto };
}
function stopped(stream) { assert.ok(stream.tracks.every(track => track.stopped > 0), 'Every acquired track must stop'); }
function fallbackGuidance(h) {
    assert.equal(h.get('panel').hidden, true);
    assert.equal(h.video.srcObject, null);
    assert.match(h.get('status').textContent, /choose a photo|upload|device camera/i);
    if (h.get('web-native-camera')) assert.equal(h.get('web-native-camera').hidden, false);
    assert.equal(h.photos.length, 0); assert.equal(h.networkCalls(), 0);
}

test('attach is idle: no permission/media/encoding/inference until explicit open click', () => {
    const h = fixture();
    assert.equal(typeof h.api.close, 'function');
    assert.equal(h.calls.length, 0); assert.equal(h.photos.length, 0); assert.equal(h.canvases.length, 0);
    assert.equal(h.video.srcObject, null); assert.equal(h.get('panel').hidden, true);
    assert.equal(h.networkCalls(), 0);
});

test('explicit open prefers rear-facing video without audio and waits for frame readiness', async () => {
    const h = fixture({ readyState: 1 });
    await h.get('open').click();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].audio, false);
    assert.equal(h.calls[0].video.facingMode.ideal, 'environment');
    assert.equal(h.calls[0].video.facingMode.exact, undefined, 'Desktop front-only webcams must not be excluded');
    assert.equal(h.video.srcObject, h.defaultStream); assert.equal(h.video.playCalls, 1);
    assert.equal(h.get('panel').hidden, false); assert.equal(h.get('snap').disabled, true);
    await h.get('snap').click(); assert.equal(h.photos.length, 0);
    h.video.readyState = 2; await h.video.fire('loadeddata');
    assert.equal(h.get('snap').disabled, false);
    h.api.close(); stopped(h.defaultStream);
});

test('capture returns one JPEG File, stops tracks before onPhoto, and makes no inference/storage request', async () => {
    const h = fixture(); await h.get('open').click(); await h.get('snap').click();
    assert.equal(h.photos.length, 1);
    const photo = h.photos[0];
    assert.ok(photo instanceof File); assert.equal(photo.type, 'image/jpeg'); assert.match(photo.name, /\.jpg$/i);
    assert.equal(await photo.text(), 'camera-jpeg');
    assert.equal(h.canvases[0].width, 640); assert.equal(h.canvases[0].height, 480);
    assert.equal(h.canvases[0].drawArgs[0], h.video); assert.equal(h.canvases[0].mime, 'image/jpeg');
    assert.equal(h.snapshotAtPhoto().stopped, true);
    assert.equal(h.snapshotAtPhoto().srcObject, null); assert.equal(h.snapshotAtPhoto().panelHidden, true);
    stopped(h.defaultStream); assert.equal(h.get('snap').disabled, true);
    assert.equal(h.networkCalls(), 0);
    assert.match(h.get('status').textContent, /preview|analyz/i);
});

test('camera copy bounds its longest axis without stretching the frame', async () => {
    const h = fixture({ width: 4000, height: 3000 });
    await h.get('open').click(); await h.get('snap').click();
    assert.equal(h.canvases[0].width, 1568); assert.equal(h.canvases[0].height, 1176);
    assert.equal(h.photos.length, 1); stopped(h.defaultStream);
});

for (const action of ['close button', 'returned close', 'pagehide']) test(`${action} stops all tracks and detaches preview`, async () => {
    const h = fixture(); await h.get('open').click();
    if (action === 'close button') await h.get('close').click();
    else if (action === 'returned close') h.api.close();
    else await h.pagehide();
    stopped(h.defaultStream); assert.equal(h.video.srcObject, null);
    assert.equal(h.get('panel').hidden, true); assert.equal(h.get('snap').disabled, true);
    h.api.close(); await h.pagehide();
    assert.equal(h.photos.length, 0); assert.equal(h.networkCalls(), 0);
});

for (const action of ['close', 'pagehide']) test(`late permission success after ${action} stops stale stream rather than showing it`, async () => {
    const pending = deferred(), late = media('late');
    const h = fixture({ getMedia: () => pending.promise });
    const opening = h.get('open').click();
    assert.equal(h.calls.length, 1);
    if (action === 'close') h.api.close(); else await h.pagehide();
    pending.resolve(late); await opening;
    stopped(late); assert.equal(h.video.srcObject, null); assert.equal(h.video.playCalls, 0);
    assert.equal(h.get('panel').hidden, true); assert.equal(h.photos.length, 0);
});

test('old permission completion cannot replace a newly opened camera', async () => {
    const first = deferred(), second = deferred(), old = media('old'), current = media('current');
    let count = 0;
    const h = fixture({ getMedia: () => (++count === 1 ? first.promise : second.promise) });
    const openingOld = h.get('open').click(); h.api.close();
    const openingNew = h.get('open').click(); second.resolve(current); await openingNew;
    first.resolve(old); await openingOld;
    stopped(old); assert.equal(h.video.srcObject, current);
    assert.ok(current.tracks.every(track => track.stopped === 0));
    h.api.close(); stopped(current);
});

test('close while video.play is pending stops media and never reopens the panel', async () => {
    const playing = deferred(); const h = fixture({ play: () => playing.promise });
    const opening = h.get('open').click();
    for (let i = 0; i < 10 && !h.video.playCalls; i++) await Promise.resolve();
    assert.equal(h.video.playCalls, 1);
    h.api.close(); playing.resolve(); await opening;
    stopped(h.defaultStream); assert.equal(h.get('panel').hidden, true); assert.equal(h.video.srcObject, null);
});

test('open/snap double clicks do not request duplicate streams or emit duplicate photos', async () => {
    const h = fixture({ deferEncoding: true });
    await h.get('open').click(); await h.get('open').click(); assert.equal(h.calls.length, 1);
    const capturing = h.get('snap').click();
    await h.get('snap').click(); assert.equal(h.encodingCallbacks.length, 1);
    h.encodingCallbacks[0](); await capturing;
    assert.equal(h.photos.length, 1); stopped(h.defaultStream);
});

for (const action of ['close', 'pagehide']) test(`${action} during JPEG encoding prevents stale onPhoto`, async () => {
    const h = fixture({ deferEncoding: true }); await h.get('open').click();
    const capturing = h.get('snap').click();
    if (action === 'close') h.api.close(); else await h.pagehide();
    h.encodingCallbacks[0](); await capturing;
    assert.equal(h.photos.length, 0); stopped(h.defaultStream);
    assert.equal(h.video.srcObject, null); assert.equal(h.get('panel').hidden, true);
});

for (const name of ['NotAllowedError', 'SecurityError', 'NotFoundError', 'NotReadableError', 'OtherError']) {
    test(`${name} shows actionable non-uploading fallback guidance`, async () => {
        const h = fixture({ getMedia: async () => { throw { name }; } });
        await h.get('open').click(); fallbackGuidance(h);
        assert.equal(h.calls.length, 1);
    });
}

for (const options of [{ secure: false }, { available: false }, { secure: false, nativeFallback: false }]) {
    test(`unsupported/insecure browser provides file guidance without requesting permission (${JSON.stringify(options)})`, async () => {
        const h = fixture(options); await h.get('open').click();
        assert.equal(h.calls.length, 0); fallbackGuidance(h);
    });
}

test('playback failure stops acquired media and offers fallback', async () => {
    const h = fixture({ play: async () => { throw new Error('Playback failed'); } });
    await h.get('open').click(); stopped(h.defaultStream); fallbackGuidance(h);
});

for (const blob of [null, new Blob([], { type: 'image/jpeg' }), new Blob(['not-jpeg'], { type: 'image/png' })]) {
    test(`empty or invalid JPEG encoding is not passed to onPhoto (${blob?.type || 'null'})`, async () => {
        const h = fixture({ blob }); await h.get('open').click(); await h.get('snap').click();
        stopped(h.defaultStream); fallbackGuidance(h);
    });
}

test('enabled guard blocks open/capture while another operation is busy', async () => {
    let enabled = false;
    const h = fixture({ enabled: () => enabled });
    await h.get('open').click(); assert.equal(h.calls.length, 0);
    enabled = true; await h.get('open').click(); enabled = false;
    await h.get('snap').click(); assert.equal(h.photos.length, 0); assert.equal(h.canvases.length, 0);
    h.api.close(); stopped(h.defaultStream);
});

test('zero-dimension frame stays uncapturable until a real frame arrives', async () => {
    const h = fixture({ width: 0, height: 0 }); await h.get('open').click();
    assert.equal(h.get('snap').disabled, true); await h.get('snap').click(); assert.equal(h.photos.length, 0);
    h.video.videoWidth = 640; h.video.videoHeight = 480; await h.video.fire('resize');
    assert.equal(h.get('snap').disabled, false); h.api.close(); stopped(h.defaultStream);
});
