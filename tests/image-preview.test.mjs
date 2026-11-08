import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../frontend/static/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../frontend/static/styles.css', import.meta.url), 'utf8');
function harness() {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { hidden: true, style: {}, removeAttribute(name) { delete this[name]; } });
    return elements.get(id);
  };
  const blobs = [], revoked = [];
  const context = { document: { getElementById: get }, flipImage: true, uploadMode: false,
    URL: { createObjectURL(blob) { blobs.push(blob); return `blob:preview-${blobs.length}`; }, revokeObjectURL(url) { revoked.push(url); } } };
  vm.createContext(context);
  const start = html.indexOf('        function setScanImage('), end = html.indexOf('        function startScanTimer(', start);
  assert.ok(start > 0 && end > start);
  vm.runInContext('let scanImageUrl = null;\n' + html.slice(start, end), context);
  return { context, get, blobs, revoked, run: expression => vm.runInContext(expression, context) };
}
test('loading, result and full-photo link share the original submitted Blob without re-encoding', () => {
  const h = harness(); h.context.photo = new Blob(['original JPEG bytes'], { type: 'image/jpeg' });
  h.run('setScanImage(photo)');
  assert.equal(h.blobs[0], h.context.photo);
  assert.equal(h.get('scan-image').src, h.get('result-image').src);
  assert.equal(h.get('image-preview-link').href, h.get('result-image').src);
  assert.equal(h.get('result-image').hidden, false);
  assert.equal(h.get('image-preview-link').hidden, false);
  assert.match(h.get('image-preview-label').textContent, /19 bytes/);
  assert.equal(h.get('result-image').style.transform, undefined, 'exact result preview is never mirrored');
});
test('new photo replaces previous preview and releases its object URL', () => {
  const h = harness(); h.context.photo = new Blob(['first']); h.run('setScanImage(photo)');
  h.context.photo = new Blob(['second']); h.run('setScanImage(photo)');
  assert.deepEqual(h.revoked, ['blob:preview-1']);
  assert.equal(h.get('result-image').src, 'blob:preview-2');
  assert.match(h.get('image-preview-label').textContent, /6 bytes/);
});
test('reset clears previews and link so a capture failure cannot show a previous photo', () => {
  const h = harness(); h.context.photo = new Blob(['first']); h.run('setScanImage(photo); clearImagePreview(); clearImagePreview()');
  assert.deepEqual(h.revoked, ['blob:preview-1']);
  assert.equal(h.get('result-image').src, undefined);
  assert.equal(h.get('image-preview-link').href, undefined);
  assert.equal(h.get('result-image').hidden, true);
  assert.equal(h.get('image-preview-label').textContent, '');
  assert.match(html, /function resetCamera\(\)\s*\{\s*clearImagePreview\(\)/);
});
test('original preview is uncropped, hidden canvas stays hidden and errors retain current submitted photo', () => {
  assert.match(css, /#result-image\s*\{\s*object-fit:\s*contain/);
  assert.match(css, /\.image-wrapper\s*>\s*\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(html, /id="canvas-display" hidden aria-hidden="true"/);
  const error = html.slice(html.indexOf('        function showError('), html.indexOf('        async function savePhotoWithResults('));
  assert.doesNotMatch(error, /clearImagePreview|result-image/);
});
