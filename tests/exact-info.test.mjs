import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../frontend/static/index.html', import.meta.url), 'utf8');
const info = readFileSync(new URL('../frontend/static/result-info.js', import.meta.url), 'utf8');
const themes = html.slice(html.indexOf('        const arm ='), html.indexOf('        const cameraFallback ='));
const display = html.slice(html.indexOf('        async function displayResult('), html.indexOf('        async function savePhotoWithResults('));
function harness() {
    const nodes = {};
    const element = () => ({ style: {}, textContent: '', className: '', children: [], open: false,
        replaceChildren() { this.children = []; }, appendChild(value) { this.children.push(value); }, addEventListener(name, fn) { this[name] = fn; } });
    const ctx = { document: { getElementById: id => nodes[id] ||= element(), createElement: element },
        localStorage: { getItem: () => 'en' }, usingPiCamera: false, debugMode: false,
        autoReturnTimer: null, inferenceTimeDisplay: element(), errorContainer: element(), resultPage: element(),
        itemName: element(), whyText: element(), actionText: element(), binNameLarge: element(), largeIconContainer: element(),
        applyLayout() {}, showPage() {}, clearTimeout() {}, setTimeout: () => 1, resetCamera() {} };
    vm.createContext(ctx); vm.runInContext(info + themes + display, ctx);
    return { ctx, nodes, run: source => vm.runInContext(source, ctx) };
}
const exact = { status: 'catalog_match', selected_item: 'beverage can', category: null,
    policy_category: 'Blue Bin', source_category: 'Blue Bin', match_probability: .99,
    policy_conditions_pending: true, automatic_routing_enabled: false,
    observed: { condition: { choice: 'unknown' } },
    rule_evaluation: [{ text: 'Empty and rinse item, then carefully place lid inside', state: 'check', model_state: 'applies' }],
    results: [{ item: 'beverage can', category: 'Not accepted', instruction: 'Legacy warning' }] };
test('exact null-category sentinel does not hide identity or policy; checks stay explicit', async () => {
    const h = harness(); h.ctx.data = exact;
    await h.run('displayResult(data, null, 350)');
    assert.equal(h.ctx.itemName.textContent, 'beverage can');
    assert.equal(h.ctx.whyText.textContent, 'Match score: 99%');
    assert.equal(h.ctx.binNameLarge.textContent, 'Blue Bin');
    assert.equal(h.ctx.actionText.textContent, 'PREDICTED POLICY BIN');
    assert.match(h.nodes['result-checks'].textContent, /unresolved/);
    assert.match(h.nodes['instruction-list'].children[0].textContent, /^\[Check first\]/);
    assert.match(h.nodes['api-summary'].textContent, /Observed condition: unknown/);
    assert.deepEqual(JSON.parse(h.nodes['api-response'].textContent), exact);
});
test('tentative identity remains tentative while all source instruction states remain visible', async () => {
    const h = harness(); h.ctx.data = { ...exact, identity_uncertain: true, rule_evaluation: ['applies', 'check', 'does_not_apply', 'reference'].map(state => ({ state, text: state })) };
    await h.run('displayResult(data, null, 1)');
    assert.equal(h.ctx.itemName.textContent, 'beverage can');
    assert.equal(h.ctx.whyText.textContent, 'Match score: 99%');
    assert.match(h.nodes['result-checks'].textContent, /verify the item/);
    assert.equal(h.nodes['instruction-list'].children.length, 2);
    assert.equal(h.nodes['other-instruction-list'].children.length, 2);
    assert.equal(h.nodes['other-instructions'].hidden, false);
});
test('legacy responses retain item/instructions; unknown categories never imply litter', async () => {
    for (const category of ['Not accepted', 'nonsense', undefined]) {
        const h = harness(); h.ctx.data = { results: [{ item: 'mystery object', category, instruction: 'Ask staff' }] };
        await h.run('displayResult(data, null, 1)');
        assert.equal(h.ctx.binNameLarge.textContent, 'NOT CONFIRMED');
        assert.match(h.nodes['instruction-list'].children[0].textContent, /Ask staff/);
    }
});
for (const bin of ['Blue Bin', 'Green Bin', 'Garbage Bin', 'HHW', 'Electronic Waste']) {
    test(`policy source instructions are preserved for ${bin}`, async () => {
        const h = harness(); h.ctx.data = { selected_item: 'API item', policy_category: bin, instructions: ['First', 'Second'] };
        await h.run('displayResult(data, null, 1)');
        assert.equal(h.ctx.binNameLarge.textContent, bin);
        assert.equal(h.nodes['instructions-title'].textContent, `Source instructions — ${bin}`);
        assert.equal(h.nodes['instruction-list'].children.length, 2);
    });
}
test('special policy labels and exception destinations are shown verbatim, not guessed', async () => {
    const h = harness(); h.ctx.data = { selected_item: 'Policy item', policy_category: 'Drop-off depot',
        source_category: 'Blue Bin', special_handling: true,
        rule_evaluation: [{ text: 'If contaminated, put in Garbage Bin instead.', state: 'check' }] };
    await h.run('displayResult(data, null, 1)');
    assert.equal(h.ctx.binNameLarge.textContent, 'Drop-off depot');
    assert.equal(h.nodes['instructions-title'].textContent, 'Source instructions — Blue Bin');
    assert.match(h.nodes['instruction-list'].children[0].textContent, /Garbage Bin/);
    assert.match(h.nodes['result-checks'].textContent, /Special handling/);
});
test('remote text remains literal, and an error clears all previous result details', async () => {
    const h = harness(); h.ctx.data = { ...exact, selected_item: '<img onerror=alert(1)>' };
    await h.run('displayResult(data, null, 1)');
    assert.match(h.ctx.itemName.textContent, /<img/);
    h.run('showError("Server error: 502")');
    assert.equal(h.ctx.binNameLarge.textContent, 'NOT CONFIRMED');
    assert.equal(h.nodes['api-response'].textContent, '');
    assert.equal(h.nodes['instruction-list'].children.length, 0);
    assert.equal(h.ctx.autoReturnTimer, null);
});
test('invalid envelopes are rejected rather than displayed as previous success', () => {
    const h = harness();
    for (const value of [null, {}, [], { results: [] }, { error: 'failed', selected_item: 'stale' }]) {
        h.ctx.data = value;
        assert.throws(() => h.run('predictionInfo(data)'), /Invalid prediction/);
    }
});
test('match scores handle legacy responses and missing or invalid values without inventing confidence', async () => {
    for (const [value, expected] of [[.784, '78.4%'], [0, '0%'], [1, '100%'], [null, 'not returned'], [-1, 'not returned'], [99, 'not returned'], ['0.9', 'not returned']]) {
        const h = harness(); h.ctx.data = { selected_item: 'test item', match_probability: value };
        await h.run('displayResult(data, null, 1)');
        assert.equal(h.ctx.whyText.textContent, `Match score: ${expected}`);
    }
    const h = harness(); h.ctx.data = { results: [{ item: 'legacy can', category: 'Blue Bin', confidence: .87 }] };
    await h.run('displayResult(data, null, 1)');
    assert.equal(h.ctx.whyText.textContent, 'Match score: 87%');
});
test('opening API details pauses auto-return; closing resumes it', () => {
    const h = harness();
    h.ctx.event = { target: { open: true } }; h.ctx.autoReturnTimer = 12;
    h.run('document.getElementById("api-details").toggle(event)');
    assert.equal(h.ctx.autoReturnTimer, null);
    h.ctx.errorContainer.style.display = 'none'; h.ctx.event.target.open = false;
    h.run('document.getElementById("api-details").toggle(event)');
    assert.equal(h.ctx.autoReturnTimer, 1);
});
