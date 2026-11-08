import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeployedHandler } from '../src/deployment.mjs';

for (const mode of ['exact', 'compact', 'invalid', 'duplicate']) {
  test(`multipart preserves and validates mode: ${mode}`, async () => {
    const images = [];
    const handler = createDeployedHandler([{ item: 'food cans', category: 'Blue Bin', instructions: ['Place in Blue Bin.'] }], async ({ image, questions }) => {
      images.push(image);
      return { answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => {
        const keys = Object.keys(q.criteria);
        const facts = { kind: 'metal_food_drink_can', hazard: 'absent', condition: 'empty_clean', plastic_color: 'not_plastic', compostable_mark: 'not_plastic', paper_finish: 'not_paper', paper_soiling: 'not_paper' };
        const choice = facts[id] || keys.find(k => k.startsWith('item_')) || (keys.includes('unknown') ? 'unknown' : keys.includes('check') ? 'check' : keys[0]);
        return [id, { choice, probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? .98 : .02 / (keys.length - 1)])) }];
      })) };
    });
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array([255, 216, 255, 224])], { type: 'image/jpeg' }), 'can.jpg');
    form.append('mode', mode === 'duplicate' ? 'exact' : mode);
    if (mode === 'duplicate') form.append('mode', 'compact');
    const response = await handler(new Request('https://worker.example/predict', { method: 'POST', body: form }), { WASTEWIZARD_ALLOW_PUBLIC: 'true' });
    const data = await response.json();
    assert.equal(response.status, ['invalid', 'duplicate'].includes(mode) ? 400 : 200);
    assert.equal(images.length, mode === 'exact' ? 2 : mode === 'compact' ? 1 : 0);
    for (const image of images) assert.equal(image, 'data:image/jpeg;base64,/9j/4A==');
    if (mode === 'exact') {
      assert.equal(data.status, 'catalog_match');
      assert.deepEqual(data.instructions, ['Place in Blue Bin.']);
      assert.equal(data.automatic_routing_enabled, false);
    }
  });
}
