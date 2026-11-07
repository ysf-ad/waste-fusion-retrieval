import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDeployedHandler } from '../src/deployment.mjs';
import { QUESTIONS } from '../src/questions.mjs';
import { compactQuestions } from '../src/policy.mjs';
import { PROVIDERS } from '../src/providers.mjs';
import { MAX_IMAGE_BYTES, MAX_REQUEST_BYTES } from '../src/image-limits.mjs';

// Only the real catalog and policy run here. Model, limiter and asset calls are
// in-memory stubs: no credentials, live inference, deployment or network access.
const items = JSON.parse(await readFile(new URL('../src/items.json', import.meta.url), 'utf8'));
const origin = 'https://sorting.example';
const jpegBytes = new Uint8Array([255, 216, 255, 224]);
const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const jpegBase64 = Buffer.from(jpegBytes).toString('base64');
const jpeg = `data:image/jpeg;base64,${jpegBase64}`;
const png = `data:image/png;base64,${Buffer.from(pngBytes).toString('base64')}`;
const defaults = {
  kind: 'plastic_drink_bottle',
  hazard: 'absent',
  condition: 'empty_clean',
  plastic_color: 'non_black',
  compostable_mark: 'not_marked',
  paper_finish: 'uncoated',
  paper_soiling: 'clean',
};

function answers() {
  return Object.fromEntries(Object.entries(QUESTIONS).map(([id, question]) => {
    const choices = Object.keys(question.criteria);
    return [id, {
      choice: defaults[id],
      probabilities: Object.fromEntries(choices.map(choice => [
        choice, choice === defaults[id] ? 0.98 : 0.02 / (choices.length - 1),
      ])),
    }];
  }));
}

function fixture(overrides = {}) {
  const calls = { ask: [], ip: [], global: [], assets: [] };
  const handler = createDeployedHandler(items, async options => {
    calls.ask.push(options);
    return { answers: answers() };
  });
  const env = {
    WASTEWIZARD_ALLOW_PUBLIC: 'true',
    REQUIRE_RATE_LIMITER: 'true',
    CORS_ALLOWED_ORIGINS: origin,
    BUILD_ID: 'offline-test-build',
    AI_IP_LIMITER: {
      async limit(options) {
        calls.ip.push(options);
        return { success: true };
      },
    },
    AI_GLOBAL_LIMITER: {
      async limit(options) {
        calls.global.push(options);
        return { success: true };
      },
    },
    ASSETS: {
      async fetch(request) {
        calls.assets.push(request);
        return new Response('offline asset', { headers: { 'Content-Type': 'text/plain' } });
      },
    },
    ...overrides,
  };
  return { calls, env, fetch: request => handler(request, env) };
}

function request(body = { image: jpeg }, options = {}) {
  const { path = '/', method = 'POST', headers = {}, ...rest } = options;
  return new Request(`https://worker.example${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
    ...(method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? {} : {
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    ...rest,
  });
}

function assertHeaders(response, allowedOrigin = origin) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('server-timing'), /^edge;dur=\d+$/);
  assert.equal(response.headers.get('access-control-allow-origin'), allowedOrigin);
  if (allowedOrigin) {
    assert.match(response.headers.get('vary'), /Origin/i);
    assert.match(response.headers.get('access-control-expose-headers'), /Retry-After/i);
  }
}

function assertNoInference(f) {
  assert.equal(f.calls.ask.length, 0);
  assert.equal(f.calls.assets.length, 0);
}

async function assertSuccess(f, response, expectedImage = jpeg) {
  assert.equal(response.status, 200);
  assertHeaders(response);
  const data = await response.json();
  assert.equal(data.status, 'suggestion');
  assert.equal(data.category, 'Blue Bin');
  assert.equal(data.automatic_routing_enabled, false);
  assert.equal(data.model_calls, 1);
  assert.equal(data.api_version, '2026-10-28');
  assert.equal(data.build_id, 'offline-test-build');
  assert.equal(typeof data.item_name, 'string');
  assert.ok(data.item_name.length > 0);
  assert.ok(Number.isInteger(data.edge_time_ms) && data.edge_time_ms >= 0);
  assert.equal(f.calls.ask.length, 1);
  assert.equal(f.calls.ask[0].image, expectedImage);
  assert.deepEqual(f.calls.ask[0].questions, compactQuestions(items));
  assert.equal(f.calls.ask[0].provider, 'jev');
  assert.equal(f.calls.assets.length, 0);
  assert.deepEqual(f.calls.ip, [{ key: 'wastewizard:203.0.113.9' }]);
  assert.deepEqual(f.calls.global, [{ key: 'wastewizard:all' }]);
  return data;
}

const ipHeader = { 'CF-Connecting-IP': '203.0.113.9' };
for (const [name, body, expectedImage] of [
  ['imageDataUrl', { imageDataUrl: jpeg }, jpeg],
  ['imageBase64', { imageBase64: jpegBase64 }, jpeg],
  ['imageData with default JPEG type', { imageData: jpegBase64 }, jpeg],
  ['imageData with explicit PNG type', { imageData: png.split(',')[1], imageType: 'image/png' }, png],
]) {
  test(`root POST accepts legacy JSON ${name}`, async () => {
    const f = fixture();
    await assertSuccess(f, await f.fetch(request(body, { headers: ipHeader })), expectedImage);
  });
}

test('/predict compact JSON exposes legacy item and instruction without changing modern fields', async () => {
  const f = fixture();
  const data = await assertSuccess(f, await f.fetch(request({ imageDataUrl: jpeg, mode: 'compact' }, { path: '/predict', headers: ipHeader })));
  assert.equal(data.results[0].item, data.selected_item);
  assert.equal(data.results[0].category, data.category);
  for (const text of data.instructions) assert.ok(data.results[0].instruction.includes(text));
  assert.doesNotMatch(data.results[0].instruction, /\[object Object\]/);
});

test('/predict clarification becomes a non-bin alert with readable questions', async () => {
  const raw = answers();
  const choices = Object.keys(QUESTIONS.condition.criteria);
  raw.condition = { choice: 'unknown', probabilities: Object.fromEntries(choices.map(choice => [choice, choice === 'unknown' ? 0.98 : 0.02 / (choices.length - 1)])) };
  const handler = createDeployedHandler(items, async () => ({ answers: raw }));
  const response = await handler(request({ image: jpeg }, { path: '/predict', headers: ipHeader }), fixture().env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.status, 'needs_clarification');
  assert.equal(data.category, null);
  assert.equal(data.results[0].category, 'Not accepted');
  assert.equal(data.automatic_routing_enabled, false);
  assert.ok(data.clarification.length > 0);
  for (const value of data.clarification) assert.ok(data.results[0].instruction.includes(value.question));
  assert.doesNotMatch(data.results[0].instruction, /\[object Object\]/);
});

test('modern /api/classify accepts canonical image JSON and fixes model policy', async () => {
  const f = fixture();
  await assertSuccess(f, await f.fetch(request({
    image: jpeg,
    mode: 'compact',
    provider: 'clef',
    model: 'client-model',
    retries: 999,
    prompt: 'client-selected instructions',
  }, { path: '/api/classify', headers: ipHeader })));
  assert.equal(f.calls.ask[0].prompt, undefined);
  assert.equal(f.calls.ask[0].retries, undefined);
});

for (const path of ['/', '/api/classify', '/predict']) {
  test(`${path} POST accepts raw JPEG`, async () => {
    const f = fixture();
    await assertSuccess(f, await f.fetch(new Request(`https://worker.example${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', Origin: origin, ...ipHeader },
      body: jpegBytes,
    })));
  });

  test(`${path} POST accepts a single multipart image`, async () => {
    const f = fixture();
    const form = new FormData();
    form.set('photo', new Blob([jpegBytes], { type: 'image/jpeg' }), 'photo.jpg');
    await assertSuccess(f, await f.fetch(new Request(`https://worker.example${path}`, {
      method: 'POST', headers: { Origin: origin, ...ipHeader }, body: form,
    })));
  });

  test(`${path} OPTIONS preflight has safe CORS headers and no work`, async () => {
    const f = fixture();
    const response = await f.fetch(request(undefined, { path, method: 'OPTIONS', headers: {
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type, authorization',
    } }));
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    assertHeaders(response);
    assert.match(response.headers.get('access-control-allow-methods'), /POST/);
    assert.match(response.headers.get('access-control-allow-headers'), /Authorization/i);
    assert.equal(response.headers.get('access-control-max-age'), '600');
    assertNoInference(f);
    assert.equal(f.calls.ip.length + f.calls.global.length, 0);
  });
}

test('disallowed origins cannot classify or preflight and are not reflected', async () => {
  for (const method of ['POST', 'OPTIONS']) {
    const f = fixture();
    const response = await f.fetch(request(undefined, { method, headers: { Origin: 'https://untrusted.example' } }));
    assert.equal(response.status, 403);
    assertHeaders(response, null);
    assert.match((await response.json()).error, /origin/i);
    assertNoInference(f);
    assert.equal(f.calls.ip.length + f.calls.global.length, 0);
  }
});

test('wildcard, same-origin and absent Origin requests remain supported', async () => {
  for (const [allowed, incoming, reflected] of [
    ['*', 'https://other.example', '*'],
    ['', 'https://worker.example', 'https://worker.example'],
    ['', null, null],
  ]) {
    const f = fixture({ CORS_ALLOWED_ORIGINS: allowed });
    const req = request();
    if (incoming) req.headers.set('Origin', incoming);
    else req.headers.delete('Origin');
    const response = await f.fetch(req);
    assert.equal(response.status, 200);
    assertHeaders(response, reflected);
    assert.equal(f.calls.ask.length, 1);
    assert.deepEqual(f.calls.ip, [{ key: 'wastewizard:unknown' }]);
  }
});

test('production limiter configuration matches advertised device throughput', async () => {
  const config = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
  for (const [binding, limit] of [['AI_IP_LIMITER', 60], ['AI_GLOBAL_LIMITER', 120]]) {
    const stanza = config.split('[[ratelimits]]').find(part => part.includes(`name = "${binding}"`));
    assert.ok(stanza, `${binding} is required`);
    assert.match(stanza, new RegExp(`simple = \\{ limit = ${limit}, period = 60 \\}`));
  }
  assert.match(config, /REQUIRE_RATE_LIMITER = "true"/);
  assert.match(config, /name = "waste-wizard-clef"/);
});

test('health reports safe configuration, never secrets or inference', async () => {
  for (const [provider, configured, configuration] of [
    ['jev', false, {}],
    ['jev', true, { TYPESAFE_API_KEY: 'offline-key-marker' }],
    ['clef', true, { AI: { run() { assert.fail('Health must not call AI'); } } }],
    ['clef-flash', true, { CLOUDFLARE_API_TOKEN: 'offline-token-marker', CLOUDFLARE_ACCOUNT_ID: 'offline-account-marker' }],
  ]) {
    const f = fixture({ DECISION_PROVIDER: provider, WASTEWIZARD_CLIENT_TOKEN: 'offline-client-marker', ...configuration });
    const response = await f.fetch(request(undefined, { path: '/api/health', method: 'GET' }));
    assert.equal(response.status, 200);
    assertHeaders(response);
    const text = await response.text();
    assert.doesNotMatch(text, /offline-(key|token|account|client)-marker/);
    const data = JSON.parse(text);
    assert.equal(data.ready, configured);
    assert.equal(data.provider, provider);
    assert.equal(data.model, PROVIDERS[provider].model);
    assert.equal(data.build_id, 'offline-test-build');
    assert.equal(data.public_inference, true);
    assert.equal(data.rate_limit_enforced, true);
    assert.deepEqual(data.rate_limits, { per_ip_per_minute: 60, per_location_per_minute: 120, approximate: true });
    assert.equal(data.automatic_routing_enabled, false);
    assert.deepEqual(data.modes, provider === 'jev' ? ['compact', 'exact', 'trashnet', 'taco', 'realwaste', 'realwaste8'] : ['compact']);
    assertNoInference(f);
    assert.equal(f.calls.ip.length + f.calls.global.length, 0);
  }
});

for (const missing of ['AI_IP_LIMITER', 'AI_GLOBAL_LIMITER', 'both']) {
  test(`required limiter fails closed when ${missing} is missing`, async () => {
    const f = fixture(missing === 'both'
      ? { AI_IP_LIMITER: undefined, AI_GLOBAL_LIMITER: undefined }
      : { [missing]: undefined });
    const response = await f.fetch(request());
    assert.equal(response.status, 503);
    assertHeaders(response);
    const data = await response.json();
    assert.equal(data.code, 'limiter_unavailable');
    assert.equal(data.automatic_routing_enabled, false);
    assertNoInference(f);
    assert.equal(f.calls.ip.length + f.calls.global.length, 0);
    const health = await f.fetch(request(undefined, { path: '/api/health', method: 'GET' }));
    assert.equal((await health.json()).rate_limit_enforced, false);
  });
}

for (const denied of ['ip', 'global']) {
  test(`${denied} limiter denial returns 429 with Retry-After and zero inference`, async () => {
    const f = fixture();
    const binding = denied === 'ip' ? 'AI_IP_LIMITER' : 'AI_GLOBAL_LIMITER';
    f.env[binding].limit = async options => {
      f.calls[denied].push(options);
      return { success: false };
    };
    const response = await f.fetch(request(undefined, { headers: ipHeader }));
    assert.equal(response.status, 429);
    assertHeaders(response);
    assert.equal(response.headers.get('retry-after'), '60');
    const data = await response.json();
    assert.equal(data.code, denied === 'ip' ? 'rate_limited' : 'demo_busy');
    assert.equal(data.retry_after_seconds, 60);
    assert.equal(data.automatic_routing_enabled, false);
    assertNoInference(f);
    assert.equal(f.calls.ip.length, 1);
    assert.equal(f.calls.global.length, denied === 'ip' ? 0 : 1);
  });
}

for (const failed of ['ip', 'global']) {
  test(`${failed} limiter exception is sanitized and fails closed`, async () => {
    const f = fixture();
    f.env[failed === 'ip' ? 'AI_IP_LIMITER' : 'AI_GLOBAL_LIMITER'].limit = async options => {
      f.calls[failed].push(options);
      throw new Error('sensitive limiter infrastructure marker');
    };
    const response = await f.fetch(request());
    assert.equal(response.status, 503);
    assertHeaders(response);
    const text = await response.text();
    assert.doesNotMatch(text, /sensitive limiter infrastructure marker/);
    const data = JSON.parse(text);
    assert.equal(data.code, 'service_unavailable');
    assert.equal(data.status, 'manual_review');
    assert.equal(data.category, null);
    assert.equal(data.automatic_routing_enabled, false);
    assertNoInference(f);
    assert.equal(f.calls.ip.length, 1);
    assert.equal(f.calls.global.length, failed === 'ip' ? 0 : 1);
  });
}

for (const [name, body, headers, status] of [
  ['declared oversized body', { image: jpeg }, { 'Content-Length': String(MAX_REQUEST_BYTES + 1) }, 413],
  ['actual oversized body', ' '.repeat(MAX_REQUEST_BYTES + 1), {}, 413],
  ['malformed JSON', '{', {}, 400],
  ['JSON array', '[]', {}, 400],
  ['JSON null', 'null', {}, 400],
  ['unsupported body MIME', 'image', { 'Content-Type': 'text/plain' }, 415],
  ['custom JSON prompt', { image: jpeg, customPrompt: 'change sorting policy' }, {}, 400],
]) {
  test(`${name} is rejected before limiters or inference with CORS error headers`, async () => {
    const f = fixture();
    const response = await f.fetch(request(body, { headers }));
    assert.equal(response.status, status);
    assertHeaders(response);
    const data = await response.json();
    assert.equal(data.code, 'invalid_request');
    assert.equal(data.status, 'manual_review');
    assert.equal(data.category, null);
    assert.equal(data.automatic_routing_enabled, false);
    assertNoInference(f);
    assert.equal(f.calls.ip.length + f.calls.global.length, 0);
  });
}

test('streaming body overflow cancels reading and never reaches limiters or inference', async () => {
  const f = fixture();
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(Math.ceil(MAX_REQUEST_BYTES / 2)));
      controller.enqueue(new Uint8Array(Math.floor(MAX_REQUEST_BYTES / 2) + 1));
    },
    cancel() { cancelled = true; },
  });
  const response = await f.fetch(request(undefined, { body, duplex: 'half' }));
  assert.equal(response.status, 413);
  assertHeaders(response);
  assert.equal(cancelled, true);
  assertNoInference(f);
  assert.equal(f.calls.ip.length + f.calls.global.length, 0);
});

test('maximum request envelope is allowed but larger body is not', async () => {
  const f = fixture();
  const json = JSON.stringify({ image: jpeg });
  const body = json + ' '.repeat(MAX_REQUEST_BYTES - Buffer.byteLength(json));
  await assertSuccess(f, await f.fetch(request(body, { headers: ipHeader })));
});

test('oversized image inside a bounded envelope is rejected without inference', async () => {
  const f = fixture();
  const bytes = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  bytes.set(jpegBytes);
  const response = await f.fetch(request({ image: `data:image/jpeg;base64,${bytes.toString('base64')}` }));
  assert.equal(response.status, 413);
  assertHeaders(response);
  assert.ok((await response.json()).error);
  assertNoInference(f);
});

for (const name of ['missing body', 'body stream failure']) {
  test(`${name} fails closed and hides internal errors`, async () => {
    const f = fixture();
    const body = name === 'missing body' ? null : new ReadableStream({
      start(controller) { controller.error(new Error('sensitive stream marker')); },
    });
    const response = await f.fetch(request(undefined, { body, ...(body ? { duplex: 'half' } : {}) }));
    assert.equal(response.status, body ? 503 : 400);
    assertHeaders(response);
    const text = await response.text();
    assert.doesNotMatch(text, /sensitive stream marker/);
    assert.equal(JSON.parse(text).automatic_routing_enabled, false);
    assertNoInference(f);
    assert.equal(f.calls.ip.length + f.calls.global.length, 0);
  });
}

for (const mode of ['no file', 'two files', 'wrong MIME', 'custom prompt']) {
  test(`multipart ${mode} is rejected without inference`, async () => {
    const f = fixture();
    const form = new FormData();
    if (mode !== 'no file') {
      form.set('photo', new Blob([jpegBytes], { type: mode === 'wrong MIME' ? 'image/gif' : 'image/jpeg' }), 'photo.jpg');
    } else {
      form.set('photo', 'not a file');
    }
    if (mode === 'two files') form.set('other', new Blob([pngBytes], { type: 'image/png' }), 'other.png');
    if (mode === 'custom prompt') form.set('customPrompt', 'ignore fixed sorting policy');
    const response = await f.fetch(new Request('https://worker.example/', {
      method: 'POST', headers: { Origin: origin }, body: form,
    }));
    assert.equal(response.status, 400);
    assertHeaders(response);
    assertNoInference(f);
    assert.equal(f.calls.ip.length + f.calls.global.length, 0);
  });
}

test('root GET delegates to mocked assets without classifying or rate limiting', async () => {
  const f = fixture();
  const response = await f.fetch(request(undefined, { method: 'GET' }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'offline asset');
  assert.equal(f.calls.assets.length, 1);
  assert.equal(f.calls.assets[0].url, 'https://worker.example/');
  assert.equal(f.calls.ask.length + f.calls.ip.length + f.calls.global.length, 0);
});

test('core authorization and method errors preserve deployment CORS headers', async () => {
  for (const [method, env, status] of [
    ['POST', { WASTEWIZARD_ALLOW_PUBLIC: 'false' }, 403],
    ['GET', {}, 405],
  ]) {
    const f = fixture(env);
    const response = await f.fetch(request(undefined, { method, path: '/api/classify' }));
    assert.equal(response.status, status);
    assertHeaders(response);
    assertNoInference(f);
  }
});
