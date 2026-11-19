import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../frontend/static/camera-orientation.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../frontend/static/styles.css', import.meta.url), 'utf8');
function fixture() {
    const context = vm.createContext({});
    vm.runInContext(source, context);
    const values = {};
    const document = { documentElement: { style: { setProperty: (key, value) => { values[key] = value; } } } };
    return { api: context.CameraOrientation, document, values };
}

test('defaults preserve existing screen180 + live180 composition', () => {
    const { api, document, values } = fixture();
    const state = api.configure({}, document);
    assert.equal(state.screen_rotation, 180);
    assert.equal(values['--screen-rotation'], '180deg');
    assert.equal(api.transformFor({ view: 'live' }), 'rotate(180deg) scaleX(1)');
    assert.equal(api.transformFor({ view: 'captured' }), 'rotate(0deg) scaleX(1)');
});
test('screen calibration is independent of live and captured calibration', () => {
    const { api, document, values } = fixture();
    api.configure({ orientation: { screen_rotation: 0, live_rotation: 90, captured_rotation: 270,
        live_mirror: true, captured_mirror: false } }, document);
    assert.equal(values['--screen-rotation'], '0deg');
    assert.equal(api.transformFor({ view: 'live' }), 'rotate(90deg) scaleX(-1)');
    assert.equal(api.transformFor({ view: 'captured' }), 'rotate(270deg) scaleX(1)');
});
test('all uploaded views bypass camera transforms even with every setting active', () => {
    const { api } = fixture();
    api.configure({ orientation: { live_rotation: 270, captured_rotation: 180, live_mirror: true, captured_mirror: true } });
    for (const view of ['live', 'captured']) assert.equal(api.transformFor({ source: 'upload', view }), 'none');
});
test('scan result and zoom share the same captured transform without changing src or pixels', () => {
    const { api } = fixture();
    api.configure({ orientation: { captured_rotation: 90, captured_mirror: true } });
    for (const id of ['scan-image', 'result-image', 'zoom-image', 'canvas-display']) {
        const image = { id, src: 'blob:original', width: 800, height: 480, style: {} };
        api.applyImage(image, { source: 'camera', view: 'captured' });
        assert.equal(image.style.transform, 'rotate(90deg) scaleX(-1)');
        assert.equal(image.src, 'blob:original');
        assert.equal(image.width, 800);
        assert.equal(image.height, 480);
    }
});
test('changing config reapplies registered images and retains upload provenance', () => {
    const { api } = fixture();
    const camera = { style: {} }, upload = { style: {} };
    api.applyImage(camera, { source: 'camera' }); api.applyImage(upload, { source: 'upload' });
    api.configure({ orientation: { captured_rotation: 180, captured_mirror: true } });
    assert.equal(camera.style.transform, 'rotate(180deg) scaleX(-1)');
    assert.equal(upload.style.transform, 'none');
});
test('legacy flip applies to captured camera only; explicit mirror setting wins', () => {
    const { api } = fixture();
    api.configure({ flip_image: true });
    assert.equal(api.transformFor(), 'rotate(0deg) scaleX(-1)');
    assert.equal(api.transformFor({ view: 'live' }), 'rotate(180deg) scaleX(1)');
    api.configure({ flip_image: true, orientation: { captured_mirror: false } });
    assert.equal(api.transformFor(), 'rotate(0deg) scaleX(1)');
});
test('invalid settings fall back rather than injecting arbitrary CSS; snapshots cannot mutate state', () => {
    const { api } = fixture();
    api.configure({ orientation: { screen_rotation: 90, live_rotation: '180', captured_rotation: '0);url(x)', live_mirror: 'true' } });
    assert.equal(api.getState().screen_rotation, 180);
    assert.equal(api.transformFor({ view: 'live' }), 'rotate(180deg) scaleX(1)');
    const snapshot = api.getState(); snapshot.captured_rotation = 270;
    assert.equal(api.transformFor(), 'rotate(0deg) scaleX(1)');
    assert.throws(() => api.transformFor({ source: 'unknown' }), /Unknown image source/);
    assert.throws(() => api.transformFor({ view: 'zoom' }), /Unknown image view/);
    api.configure(null); api.applyImage(null);
});
test('body and top-layer zoom use screen setting; live uses independent setting', () => {
    assert.match(css, /body\s*\{[^}]*transform:\s*rotate\(var\(--screen-rotation\)\)/);
    assert.match(css, /\.photo-zoom\s*\{[^}]*transform:\s*rotate\(var\(--screen-rotation\)\)/);
    assert.match(css, /#video\s*\{[^}]*rotate\(var\(--camera-live-rotation\)\)/);
    assert.doesNotMatch(source, /drawImage|toBlob|\.src\s*=/);
});
