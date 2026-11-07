import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Exercise the actual page renderer plus its current predictionInfo adapter.
const html = readFileSync(new URL('../frontend/static/index.html', import.meta.url), 'utf8');
const info = readFileSync(new URL('../frontend/static/result-info.js', import.meta.url), 'utf8');
function section(start, end) {
  const from = html.indexOf(start), to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `shipped function boundaries: ${start}`);
  return html.slice(from, to);
}
const themes = section('        const arm =', '        const cameraFallback =');
const display = section('        async function displayResult(', '        async function savePhotoWithResults(');
function harness() {
  const element = () => ({ style: {}, textContent: '', className: '', children: [], listeners: {},
    replaceChildren(...children) { this.children = children; }, appendChild(child) { this.children.push(child); },
    addEventListener(name, fn) { this.listeners[name] = fn; } });
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const requests = [], cleared = [], timers = [];
  const ctx = {
    document: { getElementById: get, createElement: element },
    localStorage: { getItem: () => 'en' }, usingPiCamera: true, debugMode: false, autoReturnTimer: 44,
    inferenceTimeDisplay: element(), errorContainer: element(), resultPage: element(), itemName: element(),
    whyText: element(), actionText: element(), binNameLarge: element(), largeIconContainer: element(),
    applyLayout(value) { ctx.layout = value; }, showPage(value) { ctx.page = value; },
    clearTimeout(id) { cleared.push(id); }, setTimeout(fn, ms) { timers.push({ fn, ms }); return 55; }, resetCamera() {},
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true }; }
  };
  vm.createContext(ctx); vm.runInContext(info + themes + display, ctx);
  return { ctx, get, requests, cleared, timers, run: expression => vm.runInContext(expression, ctx) };
}
for (const [category, theme] of [
  ['Blue Bin', 'theme-blue'], ['Green Bin', 'theme-green'], ['Garbage', 'theme-grey'],
  ['HHW', 'theme-orange'], ['Electronic Waste', 'theme-orange'],
]) {
  test(`actual display separates identity, policy bin and instructions: ${category}`, async () => {
    const h = harness();
    h.ctx.data = { results: [{ item: 'API item', category, instruction: 'API instructions', confidence: 0.875 }] };
    await h.run('displayResult(data, null, 1234)');
    assert.equal(h.ctx.itemName.textContent, 'API item');
    assert.equal(h.ctx.whyText.textContent, 'Match score: 87.5%');
    assert.equal(h.ctx.binNameLarge.textContent, category);
    assert.equal(h.ctx.actionText.textContent, 'PREDICTED POLICY BIN');
    assert.match(h.ctx.resultPage.className, new RegExp(theme));
    assert.deepEqual(h.get('instruction-list').children.map(x => x.textContent), ['API instructions']);
    assert.equal(h.ctx.inferenceTimeDisplay.textContent, '1.23s');
    assert.equal(h.ctx.page, h.ctx.resultPage);
    assert.equal(h.requests[0].url, '/api/motion/disable');
    assert.equal(h.timers[0].ms, 60000);
  });
}
for (const category of ['Not accepted', 'unrecognized category', null, undefined]) {
  test(`legacy missing or sentinel category never guesses litter: ${category}`, async () => {
    const h = harness(); h.ctx.data = { results: [{ item: 'API item', category }] };
    await h.run('displayResult(data, null, 1)');
    assert.equal(h.ctx.binNameLarge.textContent, 'NOT CONFIRMED');
    assert.match(h.ctx.resultPage.className, /theme-red/);
    assert.match(h.get('result-checks').textContent, /do not guess a bin/);
    assert.equal(h.get('instruction-list').children[0].textContent, 'No source instructions returned by the API.');
  });
}
test('exact policy bin stays visible with unresolved checks and source instructions', async () => {
  const h = harness(); h.ctx.data = {
    selected_item: 'Tentative bottle', category: 'Not accepted', policy_category: 'Blue Bin', source_category: 'Containers',
    identity_uncertain: true, policy_conditions_pending: true, status: 'manual_review',
    rule_evaluation: [{ state: 'check', text: 'Empty first' }, { state: 'does_not_apply', text: 'Broken glass only' }],
    observed: { condition: { choice: 'Unknown' } }, build_id: 'fixture-build'
  };
  await h.run('displayResult(data, null, 1)');
  assert.equal(h.ctx.binNameLarge.textContent, 'Blue Bin');
  assert.match(h.get('result-checks').textContent, /Identity is tentative/);
  assert.doesNotMatch(h.get('result-checks').textContent, /unresolved instructions|\bbelow\b/);
  assert.match(h.get('result-checks').textContent, /manual review/);
  assert.equal(h.get('instructions-title').textContent, 'Source instructions — Containers');
  assert.deepEqual(h.get('instruction-list').children.map(x => x.textContent), ['Empty first']);
  assert.match(h.get('api-summary').textContent, /fixture-build/);
  assert.deepEqual(JSON.parse(h.get('api-response').textContent), h.ctx.data);
});
test('malformed prediction envelopes are rejected before display', async () => {
  const h = harness();
  for (const data of [null, {}, [], { results: [] }, { error: 'failure', results: [{ item: 'stale' }] }, { results: [{ category: 'Blue Bin' }] }]) {
    h.ctx.data = data;
    await assert.rejects(h.run('displayResult(data, null, 1)'), /Invalid prediction/);
  }
  assert.equal(h.requests.length, 0);
});
test('error clears stale identity, bin, instructions, diagnostics and auto-return', async () => {
  const h = harness(); h.ctx.data = { results: [{ item: 'OLD bottle', category: 'Blue Bin', instruction: 'OLD advice' }] };
  await h.run('displayResult(data, null, 1)');
  h.run('showError("Server error: 502")');
  assert.equal(h.ctx.itemName.textContent, 'Unable to identify item');
  assert.equal(h.ctx.binNameLarge.textContent, 'NOT CONFIRMED');
  assert.equal(h.ctx.actionText.textContent, 'TRY AGAIN');
  assert.match(h.ctx.resultPage.className, /theme-red/);
  assert.match(h.ctx.whyText.textContent, /do not guess a bin/);
  assert.equal(h.ctx.autoReturnTimer, null);
  assert.equal(h.get('instruction-list').children.length, 0);
  assert.equal(h.get('result-checks').textContent, '');
  assert.equal(h.get('api-response').textContent, '');
  assert.equal(h.ctx.errorContainer.textContent, 'Error: Server error: 502');
});
test('opening API details cancels auto-return until details close', async () => {
  const h = harness(); h.ctx.data = { selected_item: 'Bottle', policy_category: 'Blue Bin' };
  await h.run('displayResult(data, null, 1)');
  const toggle = h.get('api-details').listeners.toggle;
  toggle({ target: { open: true } }); assert.equal(h.ctx.autoReturnTimer, null);
  toggle({ target: { open: false } }); assert.equal(h.ctx.autoReturnTimer, 55);
});

test('applicable instructions lead, checks remain, excluded rules stay in API details, and branding is hidden', async () => {
  const h = harness();
  h.ctx.data = {selected_item:'Can',policy_category:'Blue Bin',provider:'jev',model:'jev-1.14.0',build_id:'jev-exact-release',rule_evaluation:[
    {state:'check',text:'Verify contents'}, {state:'does_not_apply',text:'Hazardous contents only'},
    {state:'applies',text:'Remove lid'}, {state:'applies',text:'Recycle lid separately'}, {state:'reference',text:'Consider reuse'}]};
  await h.run('displayResult(data, null, 1)');
  assert.deepEqual(h.get('instruction-list').children.map(x=>x.textContent), ['Remove lid','Recycle lid separately','Verify contents','Consider reuse']);
  assert.match(h.get('api-response').textContent,/Hazardous contents only/);
  assert.doesNotMatch(h.get('api-response').textContent+h.get('api-summary').textContent,/jev/i);
  assert.equal(h.ctx.data.provider,'jev');
});
