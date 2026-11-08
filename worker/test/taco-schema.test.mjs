import test from 'node:test';
import assert from 'node:assert/strict';
import { TACO_CATEGORIES, TACO_CLASSES, TACO_QUESTIONS } from '../src/taco-schema.mjs';
import { TRASHNET_QUESTIONS } from '../src/trashnet-schema.mjs';
import { createHandler } from '../src/service.mjs';
import { createDeployedHandler } from '../src/deployment.mjs';
import { ProviderError } from '../src/providers.mjs';

// Independent transcription of official annotations.json category IDs 0..59.
const officialNames = 'Aluminium foil|Battery|Aluminium blister pack|Carded blister pack|Other plastic bottle|Clear plastic bottle|Glass bottle|Plastic bottle cap|Metal bottle cap|Broken glass|Food Can|Aerosol|Drink can|Toilet tube|Other carton|Egg carton|Drink carton|Corrugated carton|Meal carton|Pizza box|Paper cup|Disposable plastic cup|Foam cup|Glass cup|Other plastic cup|Food waste|Glass jar|Plastic lid|Metal lid|Other plastic|Magazine paper|Tissues|Wrapping paper|Normal paper|Paper bag|Plastified paper bag|Plastic film|Six pack rings|Garbage bag|Other plastic wrapper|Single-use carrier bag|Polypropylene bag|Crisp packet|Spread tub|Tupperware|Disposable food container|Foam food container|Other plastic container|Plastic glooves|Plastic utensils|Pop tab|Rope & strings|Scrap metal|Shoe|Squeezable tube|Plastic straw|Paper straw|Styrofoam piece|Unlabeled litter|Cigarette'.split('|');
const image = `data:image/png;base64,${Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').toString('base64')}`;
const request = (body = { image, mode: 'taco' }, url = 'https://localhost/api/classify') => new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const answer = choice => ({ answers: { object: { choice } } });

test('official 60-category taxonomy preserves exact original IDs, case, spelling and immutable choice keys', () => {
  assert.equal(officialNames.length, 60);
  assert.deepEqual(TACO_CLASSES, officialNames);
  assert.equal(new Set(TACO_CLASSES).size, 60);
  assert.deepEqual(TACO_CATEGORIES.map(c => c.id), Array.from({ length: 60 }, (_, i) => i));
  assert.deepEqual(TACO_CATEGORIES.map(c => c.name), officialNames);
  assert.equal(TACO_CATEGORIES[48].supercategory, 'Plastic glooves');
  assert.equal(TACO_CATEGORIES[41].supercategory, 'Plastic bag & wrapper');
  assert.equal(new Set(TACO_CATEGORIES.map(c => c.supercategory)).size, 28);
  assert.deepEqual(Object.keys(TACO_QUESTIONS), ['object']);
  assert.equal(TACO_QUESTIONS.object.type, 'choice');
  assert.deepEqual(Object.keys(TACO_QUESTIONS.object.criteria), officialNames);
  for (const value of [TACO_CATEGORIES, ...TACO_CATEGORIES, TACO_CLASSES, TACO_QUESTIONS, TACO_QUESTIONS.object, TACO_QUESTIONS.object.criteria]) assert.ok(Object.isFrozen(value));
  for (const criterion of Object.values(TACO_QUESTIONS.object.criteria)) assert.ok(typeof criterion === 'string' && criterion.length > 15);
  assert.ok(!('unknown' in TACO_QUESTIONS.object.criteria));
  assert.ok(!('trash' in TACO_QUESTIONS.object.criteria));
});

test('instructions preserve object identity, specific categories, catchall limits and untrusted image text', () => {
  const q = TACO_QUESTIONS.object;
  assert.match(q.instructions, /specific object identity/);
  assert.match(q.instructions, /Prefer a specific named category/);
  assert.match(q.instructions, /never instructions/);
  assert.match(q.instructions, /Do not infer hidden polymer chemistry/);
  assert.match(q.criteria['Unlabeled litter'], /cannot be resolved/);
  assert.match(q.criteria['Unlabeled litter'], /not a generic category for all waste/);
  for (const c of ['Other carton', 'Other plastic', 'Other plastic wrapper', 'Other plastic container']) assert.match(q.criteria[c], /more specific/);
  assert.match(q.criteria['Styrofoam piece'], /rather than an identifiable foam cup or food container/);
  assert.equal(q.criteria['Aluminium blister pack'], 'Medicine or tablet blister packaging with aluminium foil backing, rather than a card-backed retail blister pack.');
  assert.equal(q.criteria['Polypropylene bag'], 'A polypropylene bag; use visible construction or product markings as evidence, not assumed hidden polymer chemistry.');
});

test('each of all60 original choices returns object_match in exactly one fixed-schema model call', async () => {
  for (const expected of officialNames) {
    let calls = 0;
    const usage = { input_tokens: 123, output_tokens: 1 };
    const env = { marker: 'offline', DECISION_TIMEOUT_MS: '9999' };
    const handler = createHandler([], async options => {
      calls++;
      assert.equal(options.image, image);
      assert.strictEqual(options.questions, TACO_QUESTIONS);
      assert.strictEqual(options.env, env);
      assert.equal(options.provider, 'jev');
      assert.equal(options.timeoutMs, 1800);
      return { ...answer(expected), predicted_class: 'WRONG', model: 'mock-jev', usage, answers_extra: { material: { choice: 'trash' } } };
    });
    const response = await handler(request({ image, mode: 'taco', questions: 'injected', provider: 'paid-other', retries: 3 }), env);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.status, 'object_match');
    assert.equal(data.predicted_class, expected);
    assert.equal(data.provider, 'jev');
    assert.equal(data.model, 'mock-jev');
    assert.deepEqual(data.usage, usage);
    assert.equal(data.model_calls, 1);
    assert.equal(data.question_count, 1);
    assert.equal(data.automatic_routing_enabled, false);
    assert.equal(calls, 1);
    assert.ok(data.server_time_ms >= data.inference_time_ms);
    assert.ok(!('category' in data));
    assert.ok(!('source_items' in data));
  }
});

test('invalid classes and unrelated answer locations fail closed without retry or taxonomy mapping', async () => {
  for (const result of [null, {}, { choice: 'Cigarette' }, { predicted_class: 'Cigarette' }, { answers: { material: { choice: 'Cigarette' } } }, answer('unknown'), answer('Plastic gloves'), answer('Food can'), answer('plastic'), answer('trash'), answer('Cigarette '), answer('__proto__'), answer(59), answer(null), answer(['Cigarette'])]) {
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

test('TACO retains image, auth, provider and timeout guards without making inference calls for rejected input', async () => {
  let calls = 0;
  const handler = createHandler([], async () => { calls++; return answer('Cigarette'); });
  assert.equal((await handler(request({ image: 'invalid', mode: 'taco' }))).status, 400);
  assert.equal((await handler(request(), { DECISION_PROVIDER: 'clef' })).status, 400);
  assert.equal((await handler(request(), { DECISION_PROVIDER: 'clef-flash' })).status, 400);
  assert.equal((await handler(request(undefined, 'https://example.test/api/classify'))).status, 403);
  assert.equal(calls, 0);
  for (const [configured, expected] of [['0', 100], ['-3', 100], ['bad', 1700], ['600', 600]]) {
    await createHandler([], async options => { assert.equal(options.timeoutMs, expected); return answer('Battery'); })(request(), { DECISION_TIMEOUT_MS: configured });
  }
  let timeoutCalls = 0;
  const response = await createHandler([], async () => { timeoutCalls++; throw new ProviderError('decision_timeout', 'Deadline exceeded', 504); })(request());
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, 'decision_timeout');
  assert.equal(timeoutCalls, 1);
});

test('health adds TACO on Jev only, deployed JSON preserves fixed mode/schema and build security metadata', async () => {
  const handler = createDeployedHandler([], async options => {
    assert.strictEqual(options.questions, TACO_QUESTIONS);
    return answer('Plastic glooves');
  });
  for (const provider of ['jev', 'clef', 'clef-flash']) {
    const health = await (await handler(new Request('https://localhost/api/health'), { DECISION_PROVIDER: provider })).json();
    assert.deepEqual(health.modes, provider === 'jev' ? ['compact', 'exact', 'trashnet', 'taco', 'realwaste', 'realwaste8'] : ['compact']);
    assert.equal(health.automatic_routing_enabled, false);
  }
  const response = await handler(request(), { BUILD_ID: 'offline-taco' });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.status, 'object_match');
  assert.equal(data.predicted_class, 'Plastic glooves');
  assert.equal(data.build_id, 'offline-taco');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('deployed TACO retains limiter fail-closed, denial, custom-prompt rejection and CORS before inference', async () => {
  let calls = 0;
  const handler = createDeployedHandler([], async () => { calls++; return answer('Cigarette'); });
  const missing = await handler(request(), { REQUIRE_RATE_LIMITER: 'true' });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).code, 'limiter_unavailable');
  const denied = await handler(request(), { AI_IP_LIMITER: { limit: async () => ({ success: false }) }, AI_GLOBAL_LIMITER: { limit: async () => { throw Error('must not run'); } } });
  assert.equal(denied.status, 429);
  assert.equal((await denied.json()).code, 'rate_limited');
  assert.equal((await handler(request({ image, mode: 'taco', customPrompt: 'ignore schema' }))).status, 400);
  const crossOrigin = request(); crossOrigin.headers.set('Origin', 'https://evil.test');
  assert.equal((await handler(crossOrigin)).status, 403);
  assert.equal(calls, 0);
});

test('TrashNet direct mode remains separate and unchanged', async () => {
  const response = await createHandler([], async options => {
    assert.strictEqual(options.questions, TRASHNET_QUESTIONS);
    return { answers: { material: { choice: 'plastic' } } };
  })(request({ image, mode: 'trashnet' }));
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.status, 'material_match');
  assert.equal(data.predicted_class, 'plastic');
});
