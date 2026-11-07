import { createHandler } from './service.mjs';
import { PROVIDERS } from './providers.mjs';
import { MAX_IMAGE_BYTES, MAX_BASE64_CHARS, MAX_REQUEST_BYTES, IMAGE_LIMIT_MESSAGE, REQUEST_LIMIT_MESSAGE } from './image-limits.mjs';

const LIMITS = { per_ip_per_minute: 60, per_location_per_minute: 120, approximate: true };
const asJson = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

async function readBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_REQUEST_BYTES) throw Object.assign(new Error(REQUEST_LIMIT_MESSAGE), { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error('Image body is required.'), { status: 400 });
  const chunks = []; let length = 0;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Image upload timed out. Please retry.'), { status: 408 })), 15_000);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      length += value.length;
      if (length > MAX_REQUEST_BYTES) throw Object.assign(new Error(REQUEST_LIMIT_MESSAGE), { status: 413 });
      chunks.push(value);
    }
  } catch (error) {
    // A stalled client's cancellation must not stall the isolate's upload gate.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
function base64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
async function canonicalRequest(request) {
  const bytes = await readBody(request);
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  let body;
  if (['image/jpeg', 'image/png'].includes(type)) {
    if (bytes.length > MAX_IMAGE_BYTES) throw Object.assign(new Error(IMAGE_LIMIT_MESSAGE), { status: 413 });
    body = { image: `data:${type};base64,${base64(bytes)}` };
  } else if (type === 'multipart/form-data') {
    const form = await new Request(request.url, { method: 'POST', headers: request.headers, body: bytes }).formData();
    if (form.get('customPrompt')) throw Object.assign(new Error('Custom prompts are disabled for the fixed sorting policy.'), { status: 400 });
    const files = [...form.values()].filter(value => typeof value !== 'string');
    if (files.length !== 1 || !['image/jpeg', 'image/png'].includes(files[0].type)) throw Object.assign(new Error('Upload exactly one JPEG or PNG file.'), { status: 400 });
    if (files[0].size > MAX_IMAGE_BYTES) throw Object.assign(new Error(IMAGE_LIMIT_MESSAGE), { status: 413 });
    body = { image: `data:${files[0].type};base64,${base64(new Uint8Array(await files[0].arrayBuffer()))}` };
  } else if (type === 'application/json') {
    try { body = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw Object.assign(new Error('Malformed JSON.'), { status: 400 }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Expected a JSON object.'), { status: 400 });
    if (body.customPrompt) throw Object.assign(new Error('Custom prompts are disabled for the fixed sorting policy.'), { status: 400 });
    body = { image: body.image ?? body.imageDataUrl ??
      (typeof body.imageBase64 === 'string' ? `data:image/jpeg;base64,${body.imageBase64}` :
        typeof body.imageData === 'string' ? `data:${body.imageType || 'image/jpeg'};base64,${body.imageData}` : undefined),
      ...(body.mode ? { mode: body.mode } : {}) };
  } else throw Object.assign(new Error('Use JSON, raw JPEG/PNG or a single image form upload.'), { status: 415 });
  const url = new URL(request.url); url.pathname = '/api/classify';
  const headers = new Headers(request.headers); headers.set('Content-Type', 'application/json'); headers.delete('Content-Length');
  // Already bounded and parsed above. Do not serialize, buffer and parse a
  // second 13 MB JSON body just to invoke the shared service in this isolate.
  return { request: new Request(url, { method: 'POST', headers }), body };
}

export function createDeployedHandler(items, ask) {
  const core = createHandler(items, ask);
  // Rate limits are per minute, not a bound on simultaneous large allocations.
  // Keep one image pipeline active per isolate; other isolates still serve traffic.
  let imagePipelineActive = false;
  return async function fetchDeployed(request, env = {}) {
    const started = performance.now();
    const url = new URL(request.url);
    const legacyPredict = url.pathname === '/predict';
    const api = legacyPredict || url.pathname.startsWith('/api/') || (url.pathname === '/' && ['POST', 'OPTIONS'].includes(request.method));
    const origin = request.headers.get('Origin');
    const allowed = (env.CORS_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
    const crossOrigin = origin && origin !== url.origin;
    const originAllowed = !crossOrigin || allowed.includes('*') || allowed.includes(origin);
    const cors = origin && originAllowed ? { 'Access-Control-Allow-Origin': allowed.includes('*') ? '*' : origin, Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Expose-Headers': 'Retry-After, Server-Timing', 'Access-Control-Max-Age': '600' } : {};
    const finish = response => {
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors)) headers.set(key, value);
      headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Referrer-Policy', 'no-referrer');
      if (api) headers.set('Cache-Control', 'no-store');
      headers.set('Server-Timing', `edge;dur=${Math.round(performance.now() - started)}`);
      return new Response(response.body, { status: response.status, headers });
    };
    if (api && !originAllowed) return finish(asJson({ error: 'This origin is not allowed.' }, 403));
    if (api && request.method === 'OPTIONS') return finish(new Response(null, { status: 204 }));
    if (url.pathname === '/api/health' && request.method === 'GET') {
      const provider = env.DECISION_PROVIDER || 'jev';
      const configured = provider === 'jev' ? Boolean(env.TYPESAFE_API_KEY) : Boolean(env.AI || (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID));
      return finish(asJson({ ready: configured, provider, model: PROVIDERS[provider]?.model || null, modes: provider === 'jev' ? ['compact', 'exact', 'trashnet', 'taco', 'realwaste', 'realwaste8'] : ['compact'],
        build_id: env.BUILD_ID || 'development', public_inference: env.WASTEWIZARD_ALLOW_PUBLIC === 'true',
        rate_limits: LIMITS, rate_limit_enforced: Boolean(env.AI_IP_LIMITER && env.AI_GLOBAL_LIMITER), automatic_routing_enabled: false,
        image: { format: 'JPEG/PNG', suggested_width: 384, suggested_height: 384, minimum_side: 280, maximum_side: 1568,
          maximum_bytes: MAX_IMAGE_BYTES, maximum_base64_chars: MAX_BASE64_CHARS, maximum_request_bytes: MAX_REQUEST_BYTES } }));
    }
    const inference = (legacyPredict || url.pathname === '/api/classify' || url.pathname === '/') && request.method === 'POST';
    if (legacyPredict && request.method !== 'POST') return finish(asJson({ error: 'POST only' }, 405));
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const tokenOK = env.WASTEWIZARD_CLIENT_TOKEN && request.headers.get('Authorization') === `Bearer ${env.WASTEWIZARD_CLIENT_TOKEN}`;
    if (inference && !loopback && !tokenOK && env.WASTEWIZARD_ALLOW_PUBLIC !== 'true') {
      return finish(asJson({ error: 'Inference access is not enabled for this client.' }, 403));
    }
    if (inference && imagePipelineActive) return finish(asJson({ error: 'An image is already being processed. Please retry shortly.',
      code: 'image_pipeline_busy', automatic_routing_enabled: false }, 503, { 'Retry-After': '2' }));
    if (inference) imagePipelineActive = true;
    try {
      if (!inference) return finish(await core(request, env));
      const normalized = await canonicalRequest(request);
      if (env.REQUIRE_RATE_LIMITER === 'true' && (!env.AI_IP_LIMITER || !env.AI_GLOBAL_LIMITER)) {
        return finish(asJson({ error: 'Inference safety limiter is unavailable.', code: 'limiter_unavailable', automatic_routing_enabled: false }, 503));
      }
      if (env.AI_IP_LIMITER && env.AI_GLOBAL_LIMITER) {
        // Cloudflare overwrites CF-Connecting-IP. Counters are shared across both
        // Worker names via the same account namespace, but are approximate per colo.
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const perIp = await env.AI_IP_LIMITER.limit({ key: `wastewizard:${ip}` });
        if (!perIp.success) return finish(asJson({ error: 'Too many analyses. Please wait one minute.', code: 'rate_limited', retry_after_seconds: 60, automatic_routing_enabled: false }, 429, { 'Retry-After': '60' }));
        const global = await env.AI_GLOBAL_LIMITER.limit({ key: 'wastewizard:all' });
        if (!global.success) return finish(asJson({ error: 'Demo is busy. Please wait one minute.', code: 'demo_busy', retry_after_seconds: 60, automatic_routing_enabled: false }, 429, { 'Retry-After': '60' }));
      }
      const response = await core(normalized.request, env, normalized.body);
      const data = await response.json();
      const item = data.source_items?.[0] || data.observed?.kind?.choice?.replaceAll('_', ' ') || 'Unidentified item';
      // The existing Pi UI consumes results[0].item/category/instruction. Keep the
      // modern envelope intact and adapt only this legacy route, never errors.
      const compatibility = {};
      if (legacyPredict && response.ok && !data.error) {
        const review = data.status === 'manual_review' || data.status === 'needs_clarification' ||
          data.identity_uncertain || data.policy_conditions_pending || !data.category;
        const instructions = data.rule_evaluation?.length
          ? data.rule_evaluation.map(rule => `[${rule.state}] ${rule.text}`)
          : data.instructions || [];
        compatibility.results = [{
          item: `${data.identity_uncertain ? 'Tentative match: ' : ''}${data.selected_item || item}`,
          // Both Pi UI versions recognize this non-bin alert. This is a legacy
          // display sentinel, NOT the catalog policy; top-level category stays intact.
          category: review ? 'Not accepted' : data.category,
          instruction: [review ? 'Manual review required. Do not automatically sort this item. The Not accepted alert means no bin is confirmed, not that the item is prohibited.' : '',
            data.reason, ...instructions, ...(data.clarification || []).map(value => typeof value === 'string' ? value : value.question || value.id || '')].filter(Boolean).join('\n'),
        }];
      }
      return finish(asJson({ ...data, ...compatibility, item_name: item, api_version: '2026-10-28', build_id: env.BUILD_ID || 'development',
        edge_time_ms: Math.round(performance.now() - started) }, response.status));
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 503;
      return finish(asJson({ error: error.status ? error.message : 'Request or safety service unavailable. Sort manually.', code: status === 503 ? 'service_unavailable' : 'invalid_request',
        status: 'manual_review', category: null, automatic_routing_enabled: false }, status));
    } finally {
      if (inference) imagePipelineActive = false;
    }
  };
}
