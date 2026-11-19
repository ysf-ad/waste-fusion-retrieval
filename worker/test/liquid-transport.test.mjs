import test from 'node:test';
import assert from 'node:assert/strict';
import { askModel } from '../src/providers.mjs';
import { createDeployedHandler } from '../src/deployment.mjs';

const image = 'data:image/jpeg;base64,/9j/AA==';
const questions = { subject: { type: 'choice', instructions: 'Which subject is shown?', criteria: { item: 'Item', none: 'None' } } };
for (const provider of ['d1.2', 'd1.2-ultra']) test(`${provider} sends one typed image request to Liquid`, async () => {
  const expected = { model: provider, answers: { subject: { choice: 'none', probabilities: { none: 0.99, item: 0.01 } } }, usage: { input_tokens: 200, output_tokens: 0 } };
  let calls = 0;
  const result = await askModel({ image, questions, provider, env: { LIQUID_API_KEY: 'test-only', TYPESAFE_API_KEY: 'wrong-provider' }, fetcher: async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.liquid.ai/decisions/v1/systemone');
    assert.equal(init.headers.Authorization, 'Bearer test-only');
    assert.equal(init.headers['TypeSafe-Danger-Zone-Images'], undefined);
    const body = JSON.parse(init.body);
    assert.equal(body.model, provider);
    assert.deepEqual(body.images, [image]);
    assert.deepEqual(body.questions, questions);
    assert.equal(body.assets, undefined);
    return Response.json(expected);
  } });
  assert.deepEqual(result, expected);
  assert.equal(calls, 1);
});

test('missing key and oversized serialized Liquid envelope do not call a provider', async () => {
  let calls = 0;
  const args = { image, questions, provider: 'd1.2-ultra', fetcher: async () => { calls++; } };
  await assert.rejects(askModel(args), { code: 'missing_key' });
  await assert.rejects(askModel({ ...args, env: { LIQUID_API_KEY: 'test-only' }, image: 'data:image/jpeg;base64,' + 'A'.repeat(4_499_800),
    questions: { big: { ...questions.subject, instructions: 'é'.repeat(200) } } }), { code: 'provider_image_too_large', status: 413 });
  assert.equal(calls, 0);
});

test('Liquid health requires its own key and advertises only supported modes', async () => {
  const handler = createDeployedHandler([]);
  const env = { DECISION_PROVIDER: 'd1.2-ultra', TYPESAFE_API_KEY: 'wrong-provider' };
  const get = async values => (await handler(new Request('https://example.com/api/health'), values)).json();
  assert.equal((await get(env)).ready, false);
  const ready = await get({ ...env, LIQUID_API_KEY: 'test-only' });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.modes, ['compact', 'exact']);
  assert.ok(!JSON.stringify(ready).includes('test-only'));
});
