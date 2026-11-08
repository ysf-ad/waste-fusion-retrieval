import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { identifyCatalog } from '../src/catalog-decision.mjs';
import { QUESTIONS, baselineQuestions } from '../src/questions.mjs';
import { ProviderError } from '../src/providers.mjs';
import { createHandler } from '../src/service.mjs';

// Exact matching is tested entirely with in-memory model responses: no paid/network calls.
const items = JSON.parse(await readFile(new URL('../src/items.json', import.meta.url), 'utf8'));
const image = `data:image/png;base64,${Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').toString('base64')}`;
const env = { marker: 'mock-only' };
const base = { image, items, env, provider: 'jev', timeoutMs: 1700 };
const chunkSchema = baselineQuestions(items);
const finalistKeys = Object.values(chunkSchema).map(question => Object.keys(question.criteria).find(key => key !== 'none'));
function answer(question, selected, p = 0.98) {
  const keys = Object.keys(question.criteria);
  return { choice: selected, probabilities: Object.fromEntries(keys.map(key => [key, key === selected ? p : (1 - p) / (keys.length - 1)])) };
}
function candidateAnswers(questions, preferNone = false) {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const chosen = Object.keys(question.criteria).find(key => key !== 'none');
    if (!preferNone) return [id, answer(question, chosen)];
    // Even when local none wins, retain the best actual item as a finalist; do
    // not treat unrelated chunk-local scores as one global probability table.
    return [id, { choice: 'none', probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === 'none' ? 0.99 : key === chosen ? 0.01 : 0])) }];
  }));
}
function finalAnswers(questions, match, p = 0.98) {
  const choices = { kind: 'unknown', hazard: 'unknown', condition: 'unknown', plastic_color: 'unknown',
    compostable_mark: 'unknown', paper_finish: 'unknown', paper_soiling: 'unknown' };
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => [
    id, answer(question, id === 'match' ? match : choices[id] ?? 'check', id === 'match' ? p : 0.98),
  ]));
}
function exactRequest(mode = 'exact') {
  return new Request('https://localhost/api/classify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image, mode }) });
}
function assertNoRouting(result) {
  assert.equal(result.category, null);
  assert.equal(result.automatic_routing_enabled, false);
}

test('exact mode makes exactly two calls with one shared deadline, schema and image', async t => {
  let clock = 1000;
  t.mock.method(performance, 'now', () => clock);
  const calls = [];
  const result = await identifyCatalog({ ...base, timeoutMs: 500, ask: async options => {
    calls.push(options);
    assert.equal(options.provider, 'jev'); assert.equal(options.image, image); assert.strictEqual(options.env, env);
    if (calls.length === 1) {
      assert.deepEqual(options.questions, chunkSchema); assert.equal(options.timeoutMs, 500);
      clock += 125;
      return { answers: candidateAnswers(options.questions), usage: { input_tokens: 100, output_tokens: 20 } };
    }
    assert.equal(calls.length, 2); assert.equal(options.timeoutMs, 375);
    assert.deepEqual(Object.keys(options.questions).slice(0, 8), ['match', ...Object.keys(QUESTIONS)]);
    assert.ok(Object.keys(options.questions).length <= 64);
    for (const [id, question] of Object.entries(options.questions).slice(8)) {
      assert.match(id, /^rule_/);
      assert.deepEqual(Object.keys(question.criteria), ['applies', 'does_not_apply', 'check', 'reference']);
    }
    assert.deepEqual(Object.keys(options.questions.match.criteria), ['none', ...finalistKeys]);
    return { answers: finalAnswers(options.questions, finalistKeys.at(-1)), usage: { input_tokens: 50, output_tokens: 10 } };
  } });
  assert.equal(calls.length, 2); assert.equal(result.model_calls, 2);
  assert.equal(result.question_count, Object.keys(chunkSchema).length + Object.keys(calls[1].questions).length);
  assert.deepEqual(result.usage, { input_tokens: 150, output_tokens: 30 });
  assert.equal(result.status, 'catalog_match'); assertNoRouting(result);
  const selected = items[Number(finalistKeys.at(-1).slice(5))];
  assert.deepEqual(result.source_items, [selected.item]);
  assert.equal(result.proposed_category, selected.category);
  assert.deepEqual(result.instructions, selected.instructions);
  assert.notStrictEqual(result.instructions, selected.instructions);
  assert.match(result.reason, /conditional|conditions/);
});

test('every chunk contributes a finalist even when its local none score is high', async () => {
  let calls = 0;
  const result = await identifyCatalog({ ...base, ask: async options => {
    if (++calls === 1) return { answers: candidateAnswers(options.questions, true) };
    const criteria = options.questions.match.criteria;
    assert.deepEqual(Object.keys(criteria), ['none', ...finalistKeys]);
    for (const key of finalistKeys) assert.equal(criteria[key], items[Number(key.slice(5))].item);
    return { answers: finalAnswers(options.questions, finalistKeys[0]) };
  } });
  assert.equal(calls, 2); assert.equal(result.status, 'catalog_match'); assertNoRouting(result);
});

function assertSelectedRow(result, key, probability) {
  const selected = items[Number(key.slice(5))];
  assert.equal(result.selected_item, selected.item);
  assert.deepEqual(result.source_items, [selected.item]);
  assert.deepEqual(result.instructions, selected.instructions);
  assert.notStrictEqual(result.instructions, selected.instructions);
  assert.equal(result.source_category, selected.category);
  assert.equal(result.proposed_category, result.policy_category);
  assert.equal(result.match_probability, probability);
  assert.equal(result.automatic_routing_enabled, false);
  assert.equal(result.rule_evaluation.length, selected.instructions.length);
  for (const [index, rule] of result.rule_evaluation.entries()) {
    assert.equal(rule.index, index);
    assert.equal(rule.text, selected.instructions[index]);
    assert.ok(['applies', 'does_not_apply', 'check', 'reference'].includes(rule.state));
    assert.ok(Array.isArray(rule.facts));
  }
  assert.deepEqual(result.matched_rule_indexes,
    result.rule_evaluation.filter(rule => rule.state === 'applies').map(rule => rule.index));
}

for (const probability of [0.79, 0.3, 0.12]) {
  test(`second-stage top item at ${probability} retains its actual row without a minimum probability gate`, async () => {
    let calls = 0;
    const result = await identifyCatalog({ ...base, ask: async options => ++calls === 1
      ? { answers: candidateAnswers(options.questions) }
      : { answers: finalAnswers(options.questions, finalistKeys[0], probability) } });
    assert.equal(calls, 2);
    assertSelectedRow(result, finalistKeys[0], probability);
    assert.equal(result.observed.match.choice, finalistKeys[0]);
    assert.equal(result.observed.match.p, probability);
  });
}

for (const [label, none, best, runner] of [
  ['none winner', 0.7, 0.2, 0.1],
  ['small winning margin', 0.35, 0.36, 0.29],
]) {
  test(`second-stage ${label} displays highest non-none candidate with original probability`, async () => {
    let calls = 0;
    const selectedKey = finalistKeys.at(-1);
    const runnerKey = finalistKeys[0];
    const result = await identifyCatalog({ ...base, ask: async options => {
      if (++calls === 1) return { answers: candidateAnswers(options.questions) };
      const raw = finalAnswers(options.questions, none > best ? 'none' : selectedKey);
      raw.match.probabilities = Object.fromEntries(Object.keys(options.questions.match.criteria).map(key => [
        key, key === 'none' ? none : key === selectedKey ? best : key === runnerKey ? runner : 0,
      ]));
      return { answers: raw };
    } });
    assert.equal(calls, 2);
    assertSelectedRow(result, selectedKey, best);
    assert.equal(result.none_probability, none);
    assert.equal(result.observed.match.choice, none > best ? 'none' : selectedKey);
    assert.equal(result.observed.match.p, Math.max(none, best));
    if (none > best) assert.equal(result.identity_uncertain, true);
    assert.notEqual(result.match_probability, best / (1 - none), 'Do not renormalize away none');
  });
}

test('exact selected row keeps instructions while unknown container conditions remain unconfirmed', async () => {
  const source = items.find(item => item.item === 'plastic bottles');
  let calls = 0;
  const result = await identifyCatalog({ ...base, items: [source], ask: async options => ++calls === 1
    ? { answers: candidateAnswers(options.questions) }
    : { answers: finalAnswers(options.questions, 'item_0') } });
  assert.equal(calls, 2);
  assert.equal(result.selected_item, source.item);
  assert.deepEqual(result.instructions, source.instructions);
  assert.equal(result.policy_category, source.category);
  assert.equal(result.category, null);
  const conditions = result.rule_evaluation.filter(rule => /empty|rins|clean/i.test(rule.text));
  assert.ok(conditions.length > 0);
  assert.ok(conditions.some(rule => rule.state === 'check'));
  for (const rule of conditions) {
    assert.notEqual(rule.state, 'applies');
    assert.ok(!result.matched_rule_indexes.includes(rule.index));
  }
});

test('exact hazard warning does not erase the selected catalog instructions', async () => {
  let calls = 0;
  const result = await identifyCatalog({ ...base, ask: async options => {
    if (++calls === 1) return { answers: candidateAnswers(options.questions) };
    const raw = finalAnswers(options.questions, finalistKeys[0]);
    raw.hazard = answer(options.questions.hazard, 'evident', 0.4);
    return { answers: raw };
  } });
  assertSelectedRow(result, finalistKeys[0], 0.98);
  assert.equal(result.special_handling, true);
  assert.equal(result.category, null);
});

test('candidate stage exhausting the common budget prevents a second inference', async t => {
  let clock = 0, calls = 0;
  t.mock.method(performance, 'now', () => clock);
  await assert.rejects(identifyCatalog({ ...base, timeoutMs: 500, ask: async options => {
    calls++; clock += 401;
    return { answers: candidateAnswers(options.questions) };
  } }), { code: 'decision_timeout', status: 504 });
  assert.equal(calls, 1);
});

for (const provider of ['clef', 'clef-flash', 'unrecognized', '__proto__']) {
  test(`unsupported exact provider ${provider} is rejected before any inference`, async () => {
    let calls = 0;
    await assert.rejects(identifyCatalog({ ...base, provider, ask: async () => { calls++; } }), { code: 'exact_provider_unsupported', status: 400 });
    assert.equal(calls, 0);
  });
}

for (const stage of [1, 2]) {
  for (const malformed of ['missing result', 'missing answers', 'missing head', 'invalid probability', 'invalid choice', 'inconsistent winner']) {
    test(`stage ${stage} rejects ${malformed} without retry/fallback`, async () => {
      let calls = 0;
      await assert.rejects(identifyCatalog({ ...base, ask: async options => {
        calls++;
        if (calls === stage && malformed === 'missing result') return undefined;
        if (calls === stage && malformed === 'missing answers') return {};
        const raw = calls === 1 ? candidateAnswers(options.questions) : finalAnswers(options.questions, finalistKeys[0]);
        if (calls === stage) {
          const key = Object.keys(raw)[0];
          if (malformed === 'missing head') delete raw[key];
          if (malformed === 'invalid probability') raw[key].probabilities[raw[key].choice] = '0.99';
          if (malformed === 'invalid choice') raw[key].choice = 'invented';
          if (malformed === 'inconsistent winner') raw[key].choice = 'none';
        }
        return { answers: raw };
      } }), { code: 'invalid_model_output', status: 502 });
      assert.equal(calls, stage);
    });
  }
  test(`stage ${stage} provider timeout propagates without extra paid calls`, async () => {
    let calls = 0;
    await assert.rejects(identifyCatalog({ ...base, ask: async options => {
      if (++calls === stage) throw new ProviderError('decision_timeout', 'Mock deadline', 504);
      return { answers: candidateAnswers(options.questions) };
    } }), { code: 'decision_timeout', status: 504 });
    assert.equal(calls, stage);
  });
}

test('service exact mode returns the full selected row as conditional catalog guidance only', async () => {
  let calls = 0;
  const handler = createHandler(items, async options => ++calls === 1
    ? { answers: candidateAnswers(options.questions) }
    : { answers: finalAnswers(options.questions, finalistKeys[0]) });
  const response = await handler(exactRequest());
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(calls, 2); assert.equal(result.model_calls, 2); assert.equal(result.status, 'catalog_match');
  assertNoRouting(result); assert.deepEqual(result.instructions, items[0].instructions);
  assert.deepEqual(result.source_items, [items[0].item]); assert.equal(result.proposed_category, items[0].category);
});
test('service rejects invalid modes and unsupported exact providers before inference', async () => {
  let calls = 0;
  const handler = createHandler(items, async () => { calls++; });
  for (const [mode, provider, code] of [['unknown', 'jev', 'invalid_mode'], ['exact', 'clef', 'exact_provider_unsupported'], ['exact', 'unknown', 'exact_provider_unsupported']]) {
    const response = await handler(exactRequest(mode), { DECISION_PROVIDER: provider });
    assert.equal(response.status, 400);
    const result = await response.json(); assert.equal(result.code, code); assertNoRouting(result);
  }
  assert.equal(calls, 0);
});
test('service exact mode sanitizes malformed model output and raw errors without routing', async () => {
  for (const mode of ['malformed', 'raw error']) {
    let calls = 0;
    const handler = createHandler(items, async () => {
      calls++;
      if (mode === 'raw error') throw new Error('sensitive upstream payload');
      return { answers: {} };
    });
    const response = await handler(exactRequest());
    assert.equal(response.status, mode === 'malformed' ? 502 : 500);
    const result = await response.json(); assertNoRouting(result); assert.equal(result.status, 'manual_review');
    assert.doesNotMatch(JSON.stringify(result), /sensitive upstream payload/); assert.equal(calls, 1);
  }
});
