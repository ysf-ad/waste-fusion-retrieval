import test from 'node:test';
import assert from 'node:assert/strict';
import { TRASHNET_CLASSES, TRASHNET_QUESTIONS } from '../src/trashnet-schema.mjs';
import { createHandler } from '../src/service.mjs';
import { createDeployedHandler } from '../src/deployment.mjs';
import { ProviderError } from '../src/providers.mjs';

const image = `data:image/png;base64,${Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').toString('base64')}`;
const request = (body = { image, mode: 'trashnet' }, url = 'https://localhost/api/classify') => new Request(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const answer = choice => ({ answers: { material: { choice } } });

test('direct schema contains exactly one choice question with original six lowercase classes', () => {
  assert.deepEqual(TRASHNET_CLASSES, ['cardboard', 'glass', 'metal', 'paper', 'plastic', 'trash']);
  assert.deepEqual(Object.keys(TRASHNET_QUESTIONS), ['material']);
  assert.equal(TRASHNET_QUESTIONS.material.type, 'choice');
  assert.deepEqual(Object.keys(TRASHNET_QUESTIONS.material.criteria), TRASHNET_CLASSES);
  assert.ok(!('unknown' in TRASHNET_QUESTIONS.material.criteria));
  assert.ok(Object.isFrozen(TRASHNET_QUESTIONS));
  assert.ok(Object.isFrozen(TRASHNET_QUESTIONS.material.criteria));
});

test('each material uses exactly one call, forwards the actual image/schema and returns bounded direct shape', async () => {
  for (const expected of TRASHNET_CLASSES) {
    let calls = 0;
    const env = { marker: 'offline', DECISION_TIMEOUT_MS: '9999' };
    const usage = { input_tokens: 50, output_tokens: 2 };
    const handler = createHandler([], async options => {
      calls++;
      assert.equal(options.image, image);
      assert.strictEqual(options.questions, TRASHNET_QUESTIONS);
      assert.strictEqual(options.env, env);
      assert.equal(options.provider, 'jev');
      assert.equal(options.timeoutMs, 1800);
      // Extraneous unrelated choice fields must not drive prediction.
      return { ...answer(expected), predicted_class: 'WRONG', choice: 'WRONG', model: 'mock-jev', usage };
    });
    const response = await handler(request(), env);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, 'material_match');
    assert.equal(result.predicted_class, expected);
    assert.equal(result.provider, 'jev');
    assert.equal(result.model, 'mock-jev');
    assert.deepEqual(result.usage, usage);
    assert.equal(result.model_calls, 1);
    assert.equal(result.question_count, 1);
    assert.equal(result.automatic_routing_enabled, false);
    assert.equal(calls, 1);
    assert.ok(result.inference_time_ms >= 0);
    assert.ok(result.server_time_ms >= result.inference_time_ms);
    assert.ok(!('category' in result));
    assert.ok(!('source_items' in result));
  }
});

test('invalid material or answer location fails closed without retry or fallback', async () => {
  for (const result of [null, {}, { choice: 'paper' }, { predicted_class: 'paper' }, { answers: { other: { choice: 'paper' } } }, answer('unknown'), answer('Paper'), answer('item_0'), answer('__proto__'), answer(null), answer(['paper'])]) {
    let calls = 0;
    const response = await createHandler([], async () => { calls++; return result; })(request());
    const data = await response.json();
    assert.equal(response.status, 502);
    assert.equal(data.code, 'invalid_model_output');
    assert.equal(data.status, 'manual_review');
    assert.equal(data.category, null);
    assert.equal(data.automatic_routing_enabled, false);
    assert.ok(!('predicted_class' in data));
    assert.equal(calls, 1);
  }
});

test('mode preserves image/access/provider guards and reports provider failures', async () => {
  let calls = 0;
  const handler = createHandler([], async () => { calls++; return answer('paper'); });
  assert.equal((await handler(request({ image: 'invalid', mode: 'trashnet' }))).status, 400);
  assert.equal((await handler(request({ image, mode: 'bogus' }))).status, 400);
  assert.equal((await handler(request(), { DECISION_PROVIDER: 'clef' })).status, 400);
  assert.equal((await handler(request(undefined, 'https://example.test/api/classify'))).status, 403);
  assert.equal(calls, 0);
  const failed = await createHandler([], async () => { throw new ProviderError('decision_timeout', 'Deadline exceeded', 504); })(request());
  assert.equal(failed.status, 504);
  assert.equal((await failed.json()).code, 'decision_timeout');
});

test('health advertises direct mode only on Jev; deployed JSON ingress preserves mode', async () => {
  const handler = createDeployedHandler([], async options => {
    assert.strictEqual(options.questions, TRASHNET_QUESTIONS);
    return answer('metal');
  });
  for (const provider of ['jev', 'clef', 'clef-flash']) {
    const response = await handler(new Request('https://localhost/api/health'), { DECISION_PROVIDER: provider });
    const health = await response.json();
    assert.equal(health.modes.includes('trashnet'), provider === 'jev');
    assert.equal(health.automatic_routing_enabled, false);
  }
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).predicted_class, 'metal');
});

test('deployed direct mode retains limiter fail-closed and deny checks before inference', async () => {
  let calls = 0;
  const handler = createDeployedHandler([], async () => { calls++; return answer('paper'); });
  const missing = await handler(request(), { REQUIRE_RATE_LIMITER: 'true' });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).code, 'limiter_unavailable');
  const denied = await handler(request(), {
    AI_IP_LIMITER: { limit: async () => ({ success: false }) },
    AI_GLOBAL_LIMITER: { limit: async () => { throw new Error('must not run'); } },
  });
  assert.equal(denied.status, 429);
  assert.equal((await denied.json()).code, 'rate_limited');
  assert.equal(calls, 0);
});
