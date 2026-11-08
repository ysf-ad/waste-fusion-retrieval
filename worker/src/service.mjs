import { askModel, ProviderError, PROVIDERS } from './providers.mjs';
import { MAX_IMAGE_BYTES, MAX_BASE64_CHARS, MAX_REQUEST_BYTES, IMAGE_LIMIT_MESSAGE, REQUEST_LIMIT_MESSAGE } from './image-limits.mjs';
import { resolvePolicy, searchCatalog, compactQuestions } from './policy.mjs';
import { identifyCatalog } from './catalog-decision.mjs';
import { TRASHNET_CLASSES, TRASHNET_QUESTIONS } from './trashnet-schema.mjs';
import { TACO_CLASSES, TACO_QUESTIONS } from './taco-schema.mjs';
import { REALWASTE_CLASSES, REALWASTE_QUESTIONS } from './realwaste-schema.mjs';
import { REALWASTE8_CLASSES, REALWASTE8_QUESTIONS } from './realwaste8-schema.mjs';

const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
async function boundedJson(request) {
  if (Number(request.headers.get('content-length')) > MAX_REQUEST_BYTES) throw new ProviderError('image_too_large', REQUEST_LIMIT_MESSAGE, 413);
  const reader = request.body?.getReader();
  if (!reader) throw new ProviderError('missing_image', 'Image is required.', 400);
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) { await reader.cancel(); throw new ProviderError('image_too_large', REQUEST_LIMIT_MESSAGE, 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ProviderError('invalid_json', 'Malformed JSON.', 400); }
}
function validateImage(image) {
  if (typeof image !== 'string') throw new ProviderError('invalid_image', 'Image is required.', 400);
  if (image.length > MAX_BASE64_CHARS + 'data:image/jpeg;base64,'.length) throw new ProviderError('image_too_large', IMAGE_LIMIT_MESSAGE, 413);
  const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
  if (!match || match[2].length % 4) throw new ProviderError('invalid_image', 'Use a prepared JPEG or PNG image.', 400);
  const encoded = match[2];
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  if (encoded.length / 4 * 3 - padding > MAX_IMAGE_BYTES) throw new ProviderError('image_too_large', IMAGE_LIMIT_MESSAGE, 413);
  // Only decode the signature: avoid a second full 10 MB allocation for validation.
  let bytes;
  try { bytes = atob(encoded.slice(0, 12)); } catch { throw new ProviderError('invalid_image', 'Invalid base64 image.', 400); }
  const jpeg = bytes.charCodeAt(0) === 255 && bytes.charCodeAt(1) === 216 && bytes.charCodeAt(2) === 255;
  const png = bytes.startsWith('\x89PNG\r\n\x1a\n');
  if ((match[1] === 'jpeg' && !jpeg) || (match[1] === 'png' && !png)) throw new ProviderError('invalid_image', 'Image signature does not match its type.', 400);
}

export function createHandler(items, ask = askModel) {
  const compactSchema = compactQuestions(items);
  return async function handle(request, env = {}, canonicalBody = undefined) {
    const started = performance.now();
    const url = new URL(request.url);
    if (url.pathname === '/api/search') {
      if (request.method !== 'GET') return json({ error: 'GET only' }, 405);
      return json({ matches: searchCatalog(items, url.searchParams.get('q')) });
    }
    if (url.pathname !== '/api/classify') return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: 'Not found' }, 404);
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    // Do not deploy an unrestricted paid inference proxy accidentally. Configure a
    // client token, Cloudflare Access/rate limiting, or explicitly permit public use.
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const tokenOK = env.WASTEWIZARD_CLIENT_TOKEN && request.headers.get('Authorization') === `Bearer ${env.WASTEWIZARD_CLIENT_TOKEN}`;
    if (!loopback && !tokenOK && env.WASTEWIZARD_ALLOW_PUBLIC !== 'true') return json({ error: 'Inference access is not enabled for this client.' }, 403);
    try {
      // canonicalBody is an internal-only optimization for the bounded Worker
      // ingress. Direct HTTP users still pass through the streamed JSON bound.
      const body = canonicalBody === undefined ? await boundedJson(request) : canonicalBody;
      validateImage(body?.image);
      // Clients cannot choose a more expensive model, inject prompts, or request retries.
      const provider = env.DECISION_PROVIDER || 'jev';
      const configured = Number(env.DECISION_TIMEOUT_MS || 1700);
      const timeoutMs = Number.isFinite(configured) ? Math.min(1800, Math.max(100, configured)) : 1700;
      if (body.mode && !['compact', 'exact', 'trashnet', 'taco', 'realwaste', 'realwaste8'].includes(body.mode)) throw new ProviderError('invalid_mode', 'Use compact, exact, trashnet, taco, realwaste or realwaste8 decision mode.', 400);
      if (body.mode === 'realwaste8' && provider !== 'jev') throw new ProviderError('unsupported_mode', 'RealWaste8 benchmark mode requires the Jev provider.', 400);
      if (body.mode === 'realwaste' && provider !== 'jev') throw new ProviderError('unsupported_mode', 'RealWaste benchmark mode requires the Jev provider.', 400);
      if (body.mode === 'taco' && provider !== 'jev') throw new ProviderError('unsupported_mode', 'TACO benchmark mode requires the Jev provider.', 400);
      if (body.mode === 'trashnet' && provider !== 'jev') throw new ProviderError('unsupported_mode', 'TrashNet benchmark mode requires the Jev provider.', 400);
      const inferenceStart = performance.now();
      if (body.mode === 'realwaste8') {
        const result = await ask({ image: body.image, questions: REALWASTE8_QUESTIONS, provider, env, timeoutMs });
        const predictedClass = result?.answers?.material?.choice;
        if (!REALWASTE8_CLASSES.includes(predictedClass)) throw new ProviderError('invalid_model_output', 'Invalid RealWaste8 model output. Sort manually.');
        return json({ status: 'material_match', predicted_class: predictedClass, model: result.model || PROVIDERS[provider]?.model,
          provider, usage: result.usage, model_calls: 1, question_count: 1,
          inference_time_ms: Math.round(performance.now() - inferenceStart), server_time_ms: Math.round(performance.now() - started),
          automatic_routing_enabled: false });
      }
      if (body.mode === 'realwaste') {
        const result = await ask({ image: body.image, questions: REALWASTE_QUESTIONS, provider, env, timeoutMs });
        const predictedClass = result?.answers?.material?.choice;
        if (!REALWASTE_CLASSES.includes(predictedClass)) throw new ProviderError('invalid_model_output', 'Invalid RealWaste model output. Sort manually.');
        return json({ status: 'material_match', predicted_class: predictedClass, model: result.model || PROVIDERS[provider]?.model,
          provider, usage: result.usage, model_calls: 1, question_count: 1,
          inference_time_ms: Math.round(performance.now() - inferenceStart), server_time_ms: Math.round(performance.now() - started),
          automatic_routing_enabled: false });
      }
      if (body.mode === 'taco') {
        const result = await ask({ image: body.image, questions: TACO_QUESTIONS, provider, env, timeoutMs });
        const predictedClass = result?.answers?.object?.choice;
        if (!TACO_CLASSES.includes(predictedClass)) throw new ProviderError('invalid_model_output', 'Invalid object-model output. Sort manually.');
        return json({ status: 'object_match', predicted_class: predictedClass, model: result.model || PROVIDERS[provider]?.model,
          provider, usage: result.usage, model_calls: 1, question_count: 1,
          inference_time_ms: Math.round(performance.now() - inferenceStart), server_time_ms: Math.round(performance.now() - started),
          automatic_routing_enabled: false });
      }
      if (body.mode === 'trashnet') {
        const result = await ask({ image: body.image, questions: TRASHNET_QUESTIONS, provider, env, timeoutMs });
        const predictedClass = result?.answers?.material?.choice;
        if (!TRASHNET_CLASSES.includes(predictedClass)) throw new ProviderError('invalid_model_output', 'Invalid material-model output. Sort manually.');
        return json({ status: 'material_match', predicted_class: predictedClass, model: result.model || PROVIDERS[provider]?.model,
          provider, usage: result.usage, model_calls: 1, question_count: 1,
          inference_time_ms: Math.round(performance.now() - inferenceStart), server_time_ms: Math.round(performance.now() - started),
          automatic_routing_enabled: false });
      }
      if (body.mode === 'exact') {
        const decision = await identifyCatalog({ image: body.image, items, ask, env, provider, timeoutMs });
        return json({ ...decision, provider, model: PROVIDERS[provider]?.model,
          inference_time_ms: Math.round(performance.now() - inferenceStart), server_time_ms: Math.round(performance.now() - started) });
      }
      const result = await ask({ image: body.image, questions: compactSchema, provider, env, timeoutMs });
      let decision;
      try { decision = resolvePolicy(result.answers, items); }
      catch { throw new ProviderError('invalid_model_output', 'Invalid decision-model output. Sort manually.'); }
      return json({ ...decision, model: result.model || PROVIDERS[provider]?.model, provider,
        inference_time_ms: Math.round(performance.now() - inferenceStart), server_time_ms: Math.round(performance.now() - started),
        usage: result.usage, model_calls: 1, question_count: Object.keys(compactSchema).length });
    } catch (error) {
      const known = error instanceof ProviderError ? error : new ProviderError('internal_error', 'Classification failed. Sort manually.', 500);
      return json({ error: known.message, code: known.code, status: 'manual_review', category: null, automatic_routing_enabled: false,
        server_time_ms: Math.round(performance.now() - started) }, known.status);
    }
  };
}
