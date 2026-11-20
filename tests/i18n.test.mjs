import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const i18n = read('../frontend/static/i18n.js');
const kiosk = read('../frontend/static/index.html');
const web = read('../worker/public/benny.html');

function load(lang) {
    const ctx = { localStorage: { getItem: () => lang, setItem() {} }, document: { documentElement: {}, querySelectorAll: () => [] } };
    vm.createContext(ctx); vm.runInContext(i18n, ctx);
    return ctx.BennyI18n;
}
const decode = text => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const marked = html => [...html.matchAll(/<(\w+)[^>]*\sdata-i18n(?:="[^"]*")?[^>]*>([^<]+)</g)].map(match => decode(match[2].trim()));

test('every marked kiosk and web label has a French translation', () => {
    const fr = load('fr');
    const labels = [...new Set([...marked(kiosk), ...marked(web)])];
    assert.ok(labels.length >= 25, `found ${labels.length} labels`);
    for (const label of labels) assert.notEqual(fr.t(label), label, `missing French for: ${label}`);
});

test('French result wording, bins and confidence; catalog text passes through', () => {
    const fr = load('fr');
    assert.equal(fr.t('Model confidence: {value}', { value: '96%' }), 'Confiance du modèle : 96%');
    assert.equal(fr.t('Blue Bin'), 'Bac bleu');
    assert.equal(fr.t('Green Bin'), 'Bac vert');
    assert.equal(fr.t('PREDICTED POLICY BIN'), 'BAC PRÉVU');
    assert.equal(fr.t('No waste item detected'), 'Aucun déchet détecté');
    assert.equal(fr.t('Server error: 429'), 'Erreur du serveur : 429');
    assert.equal(fr.t('plastic reusable water bottles'), 'plastic reusable water bottles');
    assert.equal(fr.t('Place this empty item, with lid on, in the Blue Bin (recycling).'), 'Place this empty item, with lid on, in the Blue Bin (recycling).');
});

test('English is unchanged and fills placeholders', () => {
    const en = load('en');
    assert.equal(en.t('Blue Bin'), 'Blue Bin');
    assert.equal(en.t('Model confidence: {value}', { value: '96%' }), 'Model confidence: 96%');
});

test('kiosk result renders in French when French is selected', async () => {
    const info = i18n + read('../frontend/static/result-info.js');
    const themes = kiosk.slice(kiosk.indexOf('        const arm ='), kiosk.indexOf('        const cameraFallback ='));
    const display = kiosk.slice(kiosk.indexOf('        async function displayResult('), kiosk.indexOf('        async function savePhotoWithResults('));
    const nodes = {};
    const element = () => ({ style: {}, textContent: '', className: '', children: [], open: false,
        replaceChildren() { this.children = []; }, appendChild(value) { this.children.push(value); }, addEventListener() {} });
    const ctx = { document: { getElementById: id => nodes[id] ||= element(), createElement: element, documentElement: {}, querySelectorAll: () => [] },
        localStorage: { getItem: key => key === 'language' ? 'fr' : null, setItem() {} }, usingPiCamera: false, debugMode: false,
        autoReturnTimer: null, inferenceTimeDisplay: element(), errorContainer: element(), resultPage: element(), countdownOverlay: element(),
        itemName: element(), whyText: element(), actionText: element(), binNameLarge: element(), largeIconContainer: element(),
        applyLayout() {}, showPage() {}, clearTimeout() {}, setTimeout: () => 1, resetCamera() {} };
    vm.createContext(ctx); vm.runInContext(info + themes + display, ctx);
    ctx.data = { status: 'catalog_match', selected_item: 'soda can', policy_category: 'Blue Bin', source_category: 'Blue Bin',
        match_probability: .96, instructions: ['Place this item in the Blue Bin.'],
        alternatives: [], automatic_routing_enabled: false };
    await vm.runInContext('displayResult(data, null, 1)', ctx);
    assert.equal(ctx.itemName.textContent, 'soda can');
    assert.equal(ctx.whyText.textContent, 'Confiance du modèle : 96%');
    assert.equal(ctx.actionText.textContent, 'BAC PRÉVU');
    assert.equal(ctx.binNameLarge.textContent, 'Bac bleu');
    assert.equal(nodes['instructions-title'].textContent, 'Consignes officielles — Bac bleu');
    ctx.data = { status: 'no_item', no_item_reason: 'human_only', observed: { subject: { choice: 'human_only', p: .97 } } };
    await vm.runInContext('displayResult(data, null, 1)', ctx);
    assert.equal(ctx.itemName.textContent, 'Aucun déchet détecté');
    assert.equal(ctx.actionText.textContent, 'AUCUN DÉCHET');
    assert.match(nodes['result-checks'].textContent, /Les personnes et les parties du corps/);
});
