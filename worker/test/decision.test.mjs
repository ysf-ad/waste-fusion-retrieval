import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { QUESTIONS, baselineQuestions } from '../src/questions.mjs';
import { validateAnswers, resolvePolicy, compactQuestions, POLICY_VERSION } from '../src/policy.mjs';
import { askModel, jevPayload, ProviderError, PROVIDERS } from '../src/providers.mjs';
import { createHandler } from '../src/service.mjs';
import { MAX_BASE64_CHARS, MAX_REQUEST_BYTES } from '../src/image-limits.mjs';

// All inference is injected/mocked. No real credentials or network calls are used.
const items = JSON.parse(await readFile(new URL('../src/items.json', import.meta.url), 'utf8'));
const image = `data:image/png;base64,${Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').toString('base64')}`;
const jpeg = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 224]).toString('base64')}`;
const expectedIds = ['kind', 'hazard', 'condition', 'plastic_color', 'compostable_mark', 'paper_finish', 'paper_soiling'];
const defaults = {
  kind: 'plastic_drink_bottle', hazard: 'absent', condition: 'empty_clean',
  plastic_color: 'non_black', compostable_mark: 'not_marked', paper_finish: 'uncoated', paper_soiling: 'clean',
};
function distribution(id, choice, p = 0.98) {
  const keys = Object.keys(QUESTIONS[id].criteria);
  return { choice, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? p : (1 - p) / (keys.length - 1)])) };
}
function answers(overrides = {}) {
  return Object.fromEntries(expectedIds.map(id => [id, typeof overrides[id] === 'object'
    ? overrides[id] : distribution(id, overrides[id] ?? defaults[id])]));
}
const decide = overrides => resolvePolicy(answers(overrides), items);
function assertClosed(value) {
  assert.equal(value.category, null);
  assert.equal(value.automatic_routing_enabled, false);
  assert.ok(['manual_review', 'needs_clarification'].includes(value.status));
}
function request(body = { image }, { method = 'POST', host = 'localhost', headers = {}, path = '/api/classify' } = {}) {
  return new Request(`https://${host}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}
async function responseData(response) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
}
const noFetch = async () => { assert.fail('Unexpected network access'); };

// Schema and distribution validation must cover every head, including irrelevant heads.
test('atomic question schema is complete, bounded, and has explicit uncertainty choices', () => {
  assert.deepEqual(Object.keys(QUESTIONS), expectedIds);
  for (const [id, question] of Object.entries(QUESTIONS)) {
    assert.equal(question.type, 'choice', id);
    assert.ok(question.instructions.length > 20, id);
    assert.ok(Object.keys(question.criteria).length >= 3, id);
    assert.ok(Object.keys(question.criteria).length <= 241, id);
    assert.ok(Object.hasOwn(question.criteria, 'unknown'), id);
    for (const label of Object.values(question.criteria)) assert.equal(typeof label, 'string');
  }
  assert.equal(Object.keys(validateAnswers(answers())).length, expectedIds.length);
});

test('catalog baseline chunks preserve every item and stay below per-head choice limits', () => {
  const schema = baselineQuestions(items);
  assert.equal(Object.keys(schema).length, Math.ceil(items.length / 240));
  assert.ok(Object.keys(schema).length <= 64);
  const seen = [];
  for (const question of Object.values(schema)) {
    assert.equal(question.type, 'choice');
    assert.ok(question.criteria.none);
    assert.ok(Object.keys(question.criteria).length <= 241);
    seen.push(...Object.entries(question.criteria).filter(([key]) => key !== 'none'));
  }
  assert.deepEqual(seen, items.map((item, i) => [`item_${i}`, item.item]));
});

for (const id of expectedIds) {
  test(`missing answer or probabilities fails closed: ${id}`, () => {
    const missing = answers(); delete missing[id];
    assert.throws(() => validateAnswers(missing), /Missing answer/);
    const noProbabilities = answers(); delete noProbabilities[id].probabilities;
    assert.throws(() => resolvePolicy(noProbabilities, items), /Invalid probabilities/);
    const missingProbability = answers(); delete missingProbability[id].probabilities[missingProbability[id].choice];
    assert.throws(() => validateAnswers(missingProbability), /Invalid probabilities/);
  });
}

for (const [label, mutate] of [
  ['invalid choice', a => { a.kind.choice = 'invented'; }],
  ['extra probability', a => { a.kind.probabilities.invented = 0; }],
  ['negative probability', a => { a.kind.probabilities.unknown = -0.1; }],
  ['probability above one', a => { a.kind.probabilities.unknown = 1.1; }],
  ['string probability', a => { a.kind.probabilities.unknown = '0'; }],
  ['null probability', a => { a.kind.probabilities.unknown = null; }],
  ['NaN probability', a => { a.kind.probabilities.unknown = NaN; }],
  ['infinite probability', a => { a.kind.probabilities.unknown = Infinity; }],
  ['unnormalized distribution', a => { a.kind.probabilities[a.kind.choice] = 0.5; }],
  ['winner disagrees with probabilities', a => { a.kind.choice = 'unknown'; }],
]) {
  test(`reject malformed output: ${label}`, () => {
    const raw = answers(); mutate(raw);
    assert.throws(() => validateAnswers(raw));
    assert.throws(() => resolvePolicy(raw, items));
  });
}
test('reject absent, scalar, and array model answers', () => {
  for (const value of [undefined, null, 1, 'answers', []]) assert.throws(() => validateAnswers(value));
});

function assertSelectedGuidance(decision) {
  const source = items.find(item => item.item === decision.source_items[0]);
  assert.ok(source, 'Representative policy source must name an actual catalog row');
  assert.equal(typeof decision.selected_item, 'string');
  assert.ok(decision.selected_item.length > 0);
  assert.deepEqual(decision.source_items, [source.item]);
  assert.deepEqual(decision.instructions, source.instructions);
  assert.notStrictEqual(decision.instructions, source.instructions);
  assert.equal(decision.source_category, source.category);
  assert.equal(decision.proposed_category, decision.policy_category);
  assert.ok(['Blue Bin', 'Green Bin', 'Garbage Bin', source.category].includes(decision.policy_category));
  assert.equal(decision.automatic_routing_enabled, false);
  assert.equal(typeof decision.match_probability, 'number');
  assert.ok(decision.match_probability >= 0 && decision.match_probability <= 1);
  assert.equal(decision.rule_evaluation.length, source.instructions.length);
  for (const [index, rule] of decision.rule_evaluation.entries()) {
    assert.equal(rule.index, index);
    assert.equal(rule.text, source.instructions[index]);
    assert.ok(['applies', 'does_not_apply', 'check', 'reference'].includes(rule.state));
    assert.ok(Array.isArray(rule.facts));
  }
  assert.deepEqual(decision.matched_rule_indexes,
    decision.rule_evaluation.filter(rule => rule.state === 'applies').map(rule => rule.index));
  return source;
}

test('every named compact kind retains actual catalog guidance instead of a blank abstention', () => {
  for (const kind of ['foam_food_container', 'rigid_plastic_food_container', 'plastic_film_bag', 'textile', 'ceramic']) {
    const decision = decide({ kind });
    assertSelectedGuidance(decision);
    assert.equal(decision.match_probability, 0.98);
    assert.equal(decision.selected_kind, kind);
  }
});

for (const [kind, probability] of [['paper_cup', 0.79], ['foam_food_container', 0.78], ['plastic_drink_bottle', 0.3]]) {
  test(`top-ranked ${kind} at ${probability} retains its selected row and source guidance`, () => {
    const decision = decide({ kind: distribution('kind', kind, probability) });
    assertSelectedGuidance(decision);
    assert.equal(decision.selected_kind, kind);
    assert.equal(decision.match_probability, probability);
    assert.equal(decision.observed.kind.p, probability);
    assert.ok(decision.instructions.length > 0);
  });
}

test('unknown winner shows the best named kind without rewriting the raw observation or confidence', () => {
  const raw = answers();
  raw.kind = {
    choice: 'unknown',
    probabilities: Object.fromEntries(Object.keys(QUESTIONS.kind.criteria).map(key => [
      key, key === 'unknown' ? 0.7 : key === 'foam_food_container' ? 0.2 : key === 'paper_cup' ? 0.1 : 0,
    ])),
  };
  const decision = resolvePolicy(raw, items);
  assertSelectedGuidance(decision);
  assert.equal(decision.observed.kind.choice, 'unknown');
  assert.equal(decision.observed.kind.p, 0.7);
  assert.equal(decision.selected_kind, 'foam_food_container');
  assert.equal(decision.match_probability, 0.2);
  assert.equal(decision.identity_uncertain, true);
});

test('uncertain hazard retains selected item and all instructions', () => {
  for (const hazard of ['unknown', distribution('hazard', 'absent', 0.84)]) {
    assertSelectedGuidance(decide({ hazard }));
  }
});

test('special-handling identities override even low confidence', () => {
  for (const kind of ['battery', 'electronics', 'hazardous_product', 'sharp']) {
    const decision = decide({ kind: distribution('kind', kind, 0.3) });
    assertSelectedGuidance(decision);
    assert.equal(decision.special_handling, true);
  }
});
test('evident hazard overrides a plausible recyclable, even at low confidence', () => {
  const decision = decide({ hazard: distribution('hazard', 'evident', 0.4) });
  assertSelectedGuidance(decision);
  assert.equal(decision.special_handling, true);
});

test('unknown ancillary facts do not hide the paper-cup catalog guidance', () => {
  const decision = decide({ kind: 'paper_cup', condition: 'unknown', plastic_color: 'unknown',
    compostable_mark: 'unknown', paper_finish: 'unknown', paper_soiling: 'unknown' });
  const source = items.find(item => item.item === 'paper coffee cups');
  assertSelectedGuidance(decision);
  assert.equal(decision.policy_category, source.category);
  assert.ok(decision.category === null || decision.category === source.category);
  assert.deepEqual(decision.clarification, []);
  assert.deepEqual(decision.instructions, source.instructions);
  assert.equal(decision.automatic_routing_enabled, false);
  assert.equal(decision.policy_version, POLICY_VERSION);
  assert.match(decision.identification, /not exact catalog identification/);
});

test('supported plain paper/cardboard require both uncoated and clean facts only', () => {
  for (const kind of ['paper_sheet', 'cardboard_box']) {
    const good = decide({ kind, condition: 'unknown', plastic_color: 'unknown', compostable_mark: 'unknown' });
    assertSelectedGuidance(good);
    assert.equal(good.policy_category, 'Blue Bin');
    assert.ok(good.category === null || good.category === 'Blue Bin');
    for (const override of [{ paper_finish: 'coated' }, { paper_finish: 'unknown' }, { paper_soiling: 'soiled' },
      { paper_soiling: 'unknown' }, { paper_soiling: distribution('paper_soiling', 'clean', 0.84) }]) {
      const conditional = decide({ kind, ...override });
      assertSelectedGuidance(conditional);
      if (Object.values(override).includes('unknown')) assert.equal(conditional.category, null);
    }
  }
});
test('supported bottles need verified empty interior, nonblack material and no compostable marking', () => {
  const good = decide({ paper_finish: 'unknown', paper_soiling: 'unknown' });
  assert.equal(good.status, 'suggestion'); assert.equal(good.category, 'Blue Bin');
  for (const override of [{ condition: 'contents' }, { condition: 'unknown' }, { plastic_color: 'unknown' },
    { compostable_mark: 'unknown' }, { plastic_color: distribution('plastic_color', 'non_black', 0.84) }]) {
    const conditional = decide(override);
    assertSelectedGuidance(conditional);
    if (Object.values(override).includes('unknown')) assert.equal(conditional.category, null);
  }
});
test('black and compostable bottle exclusions override nominal recycling and other unknown facts', () => {
  for (const override of [{ plastic_color: 'black' }, { compostable_mark: 'marked' }]) {
    const decision = decide({ condition: 'unknown', plastic_color: 'unknown', compostable_mark: 'unknown', ...override });
    assert.equal(decision.status, 'suggestion'); assert.equal(decision.category, 'Garbage Bin');
    assert.equal(decision.source_category, 'Blue Bin');
    assert.equal(decision.policy_category, 'Garbage Bin');
    assert.equal(decision.proposed_category, 'Garbage Bin');
    assert.equal(decision.automatic_routing_enabled, false);
  }
  const uncertainBlack = decide({ plastic_color: distribution('plastic_color', 'black', 0.84) });
  assertSelectedGuidance(uncertainBlack);
});
test('opaque or closed containers request interior clarification rather than infer emptiness', () => {
  for (const kind of ['plastic_drink_bottle', 'metal_food_drink_can', 'glass_food_drink_container']) {
    const decision = decide({ kind, condition: 'unknown' });
    assertSelectedGuidance(decision);
    assert.equal(decision.category, null);
    const conditionRules = decision.rule_evaluation.filter(rule => /empty|rins|clean/i.test(rule.text));
    assert.ok(conditionRules.length > 0, 'Catalog must expose the container-condition instruction');
    assert.ok(conditionRules.some(rule => rule.state === 'check'));
    for (const rule of conditionRules) {
      assert.notEqual(rule.state, 'applies', 'Unknown interior cannot confirm a condition rule');
      assert.ok(!decision.matched_rule_indexes.includes(rule.index));
    }
  }
});
test('a model applicability vote cannot confirm a hidden unknown container interior', () => {
  const raw = answers({ condition: 'unknown' });
  const schema = compactQuestions(items);
  for (const [id, question] of Object.entries(schema)) {
    if (!id.startsWith('rule_plastic_drink_bottle_')) continue;
    raw[id] = {
      choice: 'applies',
      probabilities: Object.fromEntries(Object.keys(question.criteria).map(state => [state, state === 'applies' ? 0.97 : 0.01])),
    };
  }
  const decision = resolvePolicy(raw, items);
  assertSelectedGuidance(decision);
  const conditions = decision.rule_evaluation.filter(rule => /empty|rins|clean/i.test(rule.text));
  assert.ok(conditions.length > 0);
  for (const rule of conditions) {
    assert.equal(rule.state, 'check');
    assert.ok(!decision.matched_rule_indexes.includes(rule.index));
  }
});

test('known black bottle highlights its garbage exception while retaining nominal source category', () => {
  const decision = decide({ plastic_color: 'black' });
  assertSelectedGuidance(decision);
  assert.equal(decision.source_category, 'Blue Bin');
  assert.equal(decision.policy_category, 'Garbage Bin');
  assert.equal(decision.category, 'Garbage Bin');
  const exception = decision.rule_evaluation.find(rule => /black/i.test(rule.text));
  assert.ok(exception);
  assert.equal(exception.state, 'applies');
  assert.ok(decision.matched_rule_indexes.includes(exception.index));
  assert.ok(exception.facts.some(fact => fact.id === 'plastic_color' && fact.choice === 'black'));
});

test('foam physical-size instruction remains a check without a scale even if model votes applies', () => {
  const raw = answers({ kind: distribution('kind', 'foam_food_container', 0.78) });
  for (const [id, question] of Object.entries(compactQuestions(items))) {
    if (!id.startsWith('rule_foam_food_container_')) continue;
    raw[id] = {
      choice: 'applies',
      probabilities: Object.fromEntries(Object.keys(question.criteria).map(state => [state, state === 'applies' ? 0.97 : 0.01])),
    };
  }
  const decision = resolvePolicy(raw, items);
  assertSelectedGuidance(decision);
  assert.equal(decision.match_probability, 0.78);
  const sizes = decision.rule_evaluation.filter(rule => /shorter than|4 inches|4\s*"/i.test(rule.text));
  assert.ok(sizes.length > 0, 'Actual foam catalog row must expose its size condition');
  for (const rule of sizes) {
    assert.equal(rule.state, 'check');
    assert.ok(!decision.matched_rule_indexes.includes(rule.index));
  }
  assert.equal(decision.category, null);
});

test('unconditional snack-wrapper disposal applies even when a valid model rule vote requests a check', () => {
  const raw = answers({ kind: 'snack_wrapper' });
  raw.rule_snack_wrapper_0 = {
    choice: 'check',
    probabilities: { applies: 0.1, does_not_apply: 0.09, check: 0.71, reference: 0.1 },
  };
  const decision = resolvePolicy(raw, items);
  assertSelectedGuidance(decision);
  assert.equal(decision.selected_kind, 'snack_wrapper');
  assert.equal(decision.policy_category, 'Garbage Bin');
  assert.equal(decision.rule_evaluation[0].text, 'Place this item in the Garbage Bin.');
  assert.equal(decision.rule_evaluation[0].state, 'applies');
  assert.ok(decision.matched_rule_indexes.includes(0));
});

test('malformed provided applicability head is rejected rather than silently highlighted', () => {
  const raw = answers();
  raw.rule_plastic_drink_bottle_0 = { choice: 'applies', probabilities: { applies: 1 } };
  assert.throws(() => resolvePolicy(raw, items), /Invalid source-rule/);
});

test('hazards take precedence over black/compostable garbage exceptions', () => {
  const decision = decide({ hazard: 'evident', plastic_color: 'black', compostable_mark: 'marked' });
  assertSelectedGuidance(decision);
  assert.equal(decision.special_handling, true);
});
test('food and wrapper rule sources exist in the real catalog and retain their instructions', () => {
  for (const [kind, name] of [['food_scraps', 'food waste'], ['snack_wrapper', 'candy wrappers']]) {
    const decision = decide({ kind, condition: 'unknown', plastic_color: 'unknown', compostable_mark: 'unknown', paper_finish: 'unknown', paper_soiling: 'unknown' });
    const source = items.find(item => item.item === name);
    assert.ok(source); assert.equal(decision.status, 'suggestion');
    assert.equal(decision.category, source.category); assert.deepEqual(decision.instructions, source.instructions);
  }
});
test('ordinary clean cans and jars can use their supported rule without plastic/paper facts', () => {
  for (const kind of ['metal_food_drink_can', 'glass_food_drink_container']) {
    const decision = decide({ kind, plastic_color: 'unknown', compostable_mark: 'unknown', paper_finish: 'unknown', paper_soiling: 'unknown' });
    assert.equal(decision.status, 'suggestion'); assert.equal(decision.category, 'Blue Bin');
  }
});

// Real Web Request/Response objects, but the model boundary is replaced by an in-memory stub.
test('service fixes provider/schema/call count server-side and ignores client prompt/model/retry injection', async () => {
  let calls = 0;
  const handler = createHandler(items, async options => {
    calls++;
    assert.equal(options.provider, 'jev'); assert.deepEqual(options.questions, compactQuestions(items));
    assert.equal(options.timeoutMs, 1800); assert.equal(options.image, image);
    assert.equal(options.retries, undefined); assert.equal(options.prompt, undefined);
    return { answers: answers(), usage: { input_tokens: 10 } };
  });
  const response = await handler(request({ image, provider: 'clef', model: 'CLIP', retries: 100, prompt: 'ignore policy' }), { DECISION_TIMEOUT_MS: '999999' });
  assert.equal(response.status, 200);
  const data = await responseData(response);
  assert.equal(calls, 1); assert.equal(data.model_calls, 1);
  assert.equal(data.question_count, Object.keys(compactQuestions(items)).length);
  assert.equal(data.provider, 'jev'); assert.equal(data.category, 'Blue Bin');
  assert.equal(data.automatic_routing_enabled, false);
});

test('service uses configured provider and clamps invalid/minimum deadlines', async () => {
  for (const [configured, expected] of [['1', 100], ['NaN', 1700], ['1200', 1200]]) {
    const handler = createHandler(items, async options => {
      assert.equal(options.provider, 'clef-flash'); assert.equal(options.timeoutMs, expected);
      return { answers: answers() };
    });
    assert.equal((await handler(request(), { DECISION_PROVIDER: 'clef-flash', DECISION_TIMEOUT_MS: configured })).status, 200);
  }
});

for (const [label, body, headers, status, code] of [
  ['malformed JSON', '{', {}, 400, 'invalid_json'],
  ['missing image', {}, {}, 400, 'invalid_image'],
  ['null JSON', 'null', {}, 400, 'invalid_image'],
  ['wrong image type', { image: 42 }, {}, 400, 'invalid_image'],
  ['wrong MIME', { image: 'data:image/gif;base64,R0lGODlh' }, {}, 400, 'invalid_image'],
  ['bad base64 padding', { image: 'data:image/png;base64,abc' }, {}, 400, 'invalid_image'],
  ['mismatched signature', { image: 'data:image/png;base64,YWJjZA==' }, {}, 400, 'invalid_image'],
  ['overlong image', { image: 'x'.repeat(MAX_BASE64_CHARS + 'data:image/jpeg;base64,'.length + 1) }, {}, 413, 'image_too_large'],
  ['oversized declared body', { image }, { 'Content-Length': String(MAX_REQUEST_BYTES + 1) }, 413, 'image_too_large'],
  ['oversized actual body', ' '.repeat(MAX_REQUEST_BYTES + 1), {}, 413, 'image_too_large'],
]) {
  test(`service rejects ${label} without inference`, async () => {
    const handler = createHandler(items, noFetch);
    const response = await handler(request(body, { headers }));
    assert.equal(response.status, status);
    const data = await responseData(response); assert.equal(data.code, code); assertClosed(data);
  });
}
test('streamed body limits cancel before inference even without a Content-Length header', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(Math.ceil(MAX_REQUEST_BYTES / 2)));
      controller.enqueue(new Uint8Array(Math.floor(MAX_REQUEST_BYTES / 2) + 1));
    },
    cancel() { cancelled = true; },
  });
  const handler = createHandler(items, noFetch);
  const response = await handler(new Request('https://localhost/api/classify', { method: 'POST', body, duplex: 'half' }));
  assert.equal(response.status, 413); assert.equal(cancelled, true);
  const data = await responseData(response); assertClosed(data); assert.equal(data.code, 'image_too_large');
});
test('missing bodies and raw body-read failures do not reach inference or leak exceptions', async () => {
  let calls = 0;
  const handler = createHandler(items, async () => { calls++; assert.fail('Unexpected inference'); });
  const missing = await handler(new Request('https://localhost/api/classify', { method: 'POST' }));
  assert.equal(missing.status, 400); assertClosed(await responseData(missing));
  const body = new ReadableStream({ start(controller) { controller.error(new Error('sensitive stream failure')); } });
  const response = await handler(new Request('https://localhost/api/classify', { method: 'POST', body, duplex: 'half' }));
  assert.equal(response.status, 500);
  const data = await responseData(response); assertClosed(data);
  assert.doesNotMatch(JSON.stringify(data), /sensitive stream failure/);
  assert.equal(calls, 0);
});
test('service accepts JPEG and PNG signatures with one injected model call', async () => {
  let calls = 0;
  const handler = createHandler(items, async () => { calls++; return { answers: answers() }; });
  for (const value of [image, jpeg]) assert.equal((await handler(request({ image: value }))).status, 200);
  assert.equal(calls, 2);
});
test('method and authentication failures never invoke paid inference', async () => {
  const handler = createHandler(items, noFetch);
  assert.equal((await handler(request(undefined, { method: 'GET' }))).status, 405);
  assert.equal((await handler(request(undefined, { method: 'PUT' }))).status, 405);
  assert.equal((await handler(request(undefined, { host: 'example.test' }))).status, 403);
  assert.equal((await handler(request(undefined, { host: 'example.test', headers: { Authorization: 'Bearer wrong' } }), { WASTEWIZARD_CLIENT_TOKEN: 'test-only-token' })).status, 403);
  assert.equal((await handler(request(undefined, { host: 'example.test' }), { WASTEWIZARD_ALLOW_PUBLIC: true })).status, 403);
});
test('explicit token/public configuration permits only the intended external request', async () => {
  let calls = 0;
  const handler = createHandler(items, async () => { calls++; return { answers: answers() }; });
  assert.equal((await handler(request(undefined, { host: 'example.test', headers: { Authorization: 'Bearer test-only-token' } }), { WASTEWIZARD_CLIENT_TOKEN: 'test-only-token' })).status, 200);
  assert.equal((await handler(request(undefined, { host: 'example.test' }), { WASTEWIZARD_ALLOW_PUBLIC: 'true' })).status, 200);
  assert.equal(calls, 2);
});
test('malformed and incomplete model output is sanitized and fails closed', async () => {
  const missing = answers(); delete missing.condition;
  for (const result of [undefined, {}, { answers: {} }, { answers: missing }, { answers: [] }]) {
    let calls = 0;
    const handler = createHandler(items, async () => { calls++; return result; });
    const response = await handler(request()); const data = await responseData(response);
    assert.equal(response.status, 502); assert.equal(data.code, 'invalid_model_output'); assertClosed(data);
    assert.equal(calls, 1);
  }
});
test('raw exceptions and provider errors fail closed without leaking messages or retrying', async () => {
  for (const error of [new Error('sensitive upstream detail'), new ProviderError('decision_timeout', 'Decision deadline exceeded.', 504)]) {
    let calls = 0;
    const handler = createHandler(items, async () => { calls++; throw error; });
    const response = await handler(request()); const data = await responseData(response);
    assert.equal(response.status, error instanceof ProviderError ? 504 : 500);
    assertClosed(data); assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(data), /sensitive upstream detail/);
  }
});

// Provider contracts: exactly one image and one multi-head decision request; no CLIP or retries.
test('Jev uses state asset references and base64 assets, not Clef images', () => {
  for (const [value, format] of [[image, 'png'], [jpeg, 'jpg']]) {
    const payload = jevPayload(value, QUESTIONS);
    assert.equal(payload.model, 'jev-1.14.0'); assert.strictEqual(payload.questions, QUESTIONS);
    assert.equal(payload.images, undefined);
    assert.equal(Object.keys(payload.assets).length, 1);
    const asset = payload.assets[payload.state.photo];
    assert.equal(asset.type, 'image'); assert.equal(asset.format, format);
    assert.equal(asset.data_base64, value.split(',')[1]);
    assert.doesNotMatch(JSON.stringify(payload), /CLIP|clip-vit/);
  }
  assert.throws(() => jevPayload('https://example.test/image.png', QUESTIONS), { code: 'invalid_image' });
});
test('Jev HTTP request uses its endpoint, explicit danger-zone header and one call', async () => {
  let calls = 0;
  const result = await askModel({ image, questions: QUESTIONS, env: { TYPESAFE_API_KEY: 'not-a-real-key' },
    fetcher: async (url, options) => {
      calls++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(options.method, 'POST');
      assert.equal(options.headers['TypeSafe-Danger-Zone-Images'], 'true');
      assert.equal(options.headers.Authorization, 'Bearer not-a-real-key');
      assert.ok(options.signal instanceof AbortSignal);
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, 'jev-1.14.0'); assert.deepEqual(payload.questions, QUESTIONS);
      assert.equal(payload.images, undefined); assert.equal(Object.keys(payload.assets).length, 1);
      return Response.json({ answers: answers() });
    } });
  assert.ok(result.answers); assert.equal(calls, 1);
});
for (const provider of ['clef-flash', 'clef']) {
  test(`${provider} binding uses the exact Cloudflare model and images, not Jev assets or CLIP`, async () => {
    let calls = 0;
    const result = await askModel({ image, questions: QUESTIONS, provider, fetcher: noFetch,
      env: { AI: { run: async (model, payload) => {
        calls++; assert.equal(model, PROVIDERS[provider].model);
        assert.deepEqual(payload.images, [image]); assert.strictEqual(payload.questions, QUESTIONS);
        assert.equal(payload.assets, undefined); assert.equal(payload.state.photo, undefined);
        assert.doesNotMatch(JSON.stringify({ model, payload }), /CLIP|clip-vit/);
        return { answers: answers() };
      } } } });
    assert.ok(result.answers); assert.equal(calls, 1);
  });
  test(`${provider} REST uses account endpoint and unwraps Cloudflare result with one call`, async () => {
    let calls = 0;
    const result = await askModel({ image, questions: QUESTIONS, provider,
      env: { CLOUDFLARE_API_TOKEN: 'not-a-real-token', CLOUDFLARE_ACCOUNT_ID: 'test/account' },
      fetcher: async (url, options) => {
        calls++; assert.ok(url.endsWith(`/test%2Faccount/ai/run/${PROVIDERS[provider].model}`));
        assert.equal(options.headers.Authorization, 'Bearer not-a-real-token');
        assert.equal(options.headers['TypeSafe-Danger-Zone-Images'], undefined);
        const payload = JSON.parse(options.body);
        assert.deepEqual(payload.images, [image]); assert.equal(payload.assets, undefined);
        assert.deepEqual(payload.questions, QUESTIONS);
        assert.doesNotMatch(options.body, /CLIP|clip-vit/);
        return Response.json({ success: true, result: { answers: answers() } });
      } });
    assert.ok(result.answers); assert.equal(calls, 1);
  });
}
test('missing configuration, unknown provider, and excessive schema do not make HTTP calls', async () => {
  for (const [options, code] of [[{}, 'missing_key'], [{ provider: 'clef' }, 'missing_key'],
    [{ provider: 'not-supported' }, 'unknown_provider'],
    [{ questions: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q${i}`, QUESTIONS.kind])) }, 'invalid_schema']]) {
    await assert.rejects(askModel({ image, questions: QUESTIONS, fetcher: noFetch, ...options }), { code });
  }
});
for (const status of [400, 401, 429, 500, 503]) {
  test(`provider HTTP ${status} cancels body and never retries`, async () => {
    let calls = 0, cancelled = 0;
    await assert.rejects(askModel({ image, questions: QUESTIONS, env: { TYPESAFE_API_KEY: 'test' },
      fetcher: async () => { calls++; return { ok: false, status, body: { cancel: async () => { cancelled++; } } }; } }),
    { code: `provider_http_${status}`, status: status === 429 ? 429 : 502 });
    assert.equal(calls, 1); assert.equal(cancelled, 1);
  });
}
test('provider raw network, JSON, and declared failures are sanitized without retries', async () => {
  for (const mode of ['network', 'json', 'declared']) {
    let calls = 0;
    await assert.rejects(askModel({ image, questions: QUESTIONS, env: { TYPESAFE_API_KEY: 'test' }, fetcher: async () => {
      calls++;
      if (mode === 'network') throw new Error('sensitive upstream failure');
      if (mode === 'json') return { ok: true, json: async () => { throw new SyntaxError('sensitive invalid JSON'); } };
      return Response.json({ success: false, errors: ['sensitive provider error'] });
    } }), error => {
      assert.equal(error.code, 'provider_failure'); assert.equal(error.status, 502);
      assert.doesNotMatch(error.message, /sensitive/); return true;
    });
    assert.equal(calls, 1);
  }
});
test('HTTP deadline aborts a pending fetch and performs no retry', { timeout: 2000 }, async () => {
  let calls = 0, signal;
  const started = performance.now();
  await assert.rejects(askModel({ image, questions: QUESTIONS, env: { TYPESAFE_API_KEY: 'test' }, timeoutMs: 25,
    fetcher: async (_url, options) => { calls++; signal = options.signal; return new Promise(() => {}); } }),
  { code: 'decision_timeout', status: 504 });
  assert.equal(signal.aborted, true); assert.equal(calls, 1);
  assert.ok(performance.now() - started < 1500);
});
test('HTTP deadline includes response-body JSON consumption, not just response headers', { timeout: 2000 }, async () => {
  let calls = 0, bodyReads = 0, signal;
  await assert.rejects(askModel({ image, questions: QUESTIONS, env: { TYPESAFE_API_KEY: 'test' }, timeoutMs: 25,
    fetcher: async (_url, options) => {
      calls++; signal = options.signal;
      return { ok: true, json: async () => { bodyReads++; return new Promise(() => {}); } };
    } }), { code: 'decision_timeout', status: 504 });
  assert.equal(calls, 1); assert.equal(bodyReads, 1); assert.equal(signal.aborted, true);
});
test('Workers binding deadline stops routing without making a second inference call', { timeout: 2000 }, async () => {
  let calls = 0;
  await assert.rejects(askModel({ image, questions: QUESTIONS, provider: 'clef-flash', timeoutMs: 25, fetcher: noFetch,
    env: { AI: { run: async () => { calls++; return new Promise(() => {}); } } } }),
  { code: 'decision_timeout', status: 504 });
  assert.equal(calls, 1);
});
