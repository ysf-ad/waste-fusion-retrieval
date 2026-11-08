// SOFTWARE-ONLY LOCAL PREVIEW. Real Worker/catalog/policy; deterministic model stub.
// Run: node tests/preview-worker.mjs (loopback 18776). No credentials or paid inference.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createDeployedHandler } from '../worker/src/deployment.mjs';
import { ProviderError } from '../worker/src/providers.mjs';
import { MAX_REQUEST_BYTES } from '../worker/src/image-limits.mjs';

const items = JSON.parse(readFileSync(new URL('../worker/src/items.json', import.meta.url), 'utf8'));
const index = items.findIndex(row => row.item === 'aluminum can');
if (index < 0) throw new Error('Real aluminum can catalog entry is missing');
const target = { id: `item_${index}`, index, ...items[index] };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// No provider/network fallback is permitted in this fixture, even accidentally.
globalThis.fetch = async () => { throw new Error('Outbound fetch is disabled in the software preview'); };

export function createPreview() {
  const state = { softwareOnly: true, scenario: 'normal', requests: 0, modelCalls: 0,
    limiterCalls: 0, lastRequest: null, lastImageHash: null, lastImageSize: null,
    lastMode: null, lastResponse: null, lastStatus: null, modelImagesUnchanged: true, target };
  let ingressImage = null;
  const handler = createDeployedHandler(items, async ({ image, questions }) => {
    state.modelCalls++;
    const encoded = /^data:image\/(?:jpeg|png);base64,(.+)$/.exec(image);
    const bytes = encoded ? Buffer.from(encoded[1], 'base64') : null;
    const unchanged = Boolean(bytes && ingressImage && bytes.equals(ingressImage));
    state.modelImagesUnchanged &&= unchanged;
    if (!unchanged) throw new Error('Model input differs from original multipart bytes');
    if (state.scenario === 'provider-error') {
      throw new ProviderError('fixture_provider_error', 'Software preview provider failure. Sort manually.', 503);
    }
    const facts = { kind: 'metal_food_drink_can', hazard: 'absent', condition: 'unknown',
      plastic_color: 'not_plastic', compostable_mark: 'not_plastic', paper_finish: 'not_paper', paper_soiling: 'not_paper' };
    return { model: 'SOFTWARE-ONLY deterministic stub', answers: Object.fromEntries(
      Object.entries(questions).map(([id, question]) => {
        const keys = Object.keys(question.criteria);
        // Catalog candidate stages use real item_N IDs; second pass must select the can.
        const selected = keys.includes(target.id) ? target.id
          : id === 'match' ? null
          : id.startsWith('items_') ? keys.find(key => key !== 'none')
          : id.startsWith('rule_') ? 'check' : facts[id];
        if (!keys.includes(selected)) throw new Error(`Unhandled real decision question: ${id}`);
        return [id, { choice: selected, probabilities: Object.fromEntries(keys.map(key =>
          [key, key === selected ? 0.98 : 0.02 / (keys.length - 1)])) }];
      })) };
  });
  const limiter = { async limit() { state.limiterCalls++; return { success: true }; } };
  const env = { WASTEWIZARD_ALLOW_PUBLIC: 'true', REQUIRE_RATE_LIMITER: 'true',
    AI_IP_LIMITER: limiter, AI_GLOBAL_LIMITER: limiter, DECISION_PROVIDER: 'jev',
    BUILD_ID: 'software-only-local-preview' };

  async function handleRequest(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__test__/state') return Response.json(state);
    if (url.pathname.startsWith('/__test__/scenario/')) {
      const scenario = url.pathname.split('/').at(-1);
      if (!['normal', 'provider-error'].includes(scenario)) return Response.json({ error: 'Unknown scenario' }, { status: 400 });
      state.scenario = scenario;
      return Response.json({ softwareOnly: true, scenario });
    }
    if (request.method === 'POST') {
      state.requests++;
      ingressImage = null;
      state.lastImageHash = state.lastImageSize = state.lastMode = null;
      state.lastRequest = { method: request.method, path: url.pathname, contentType: request.headers.get('content-type') };
      try {
        // Clone leaves the actual deployed adapter's multipart ingress untouched.
        const form = await request.clone().formData();
        const file = form.get('file');
        state.lastMode = form.get('mode');
        if (file && typeof file !== 'string') {
          ingressImage = Buffer.from(await file.arrayBuffer());
          state.lastImageHash = sha256(ingressImage);
          state.lastImageSize = ingressImage.length;
          Object.assign(state.lastRequest, { filename: file.name, imageType: file.type,
            image_sha256: state.lastImageHash, bytes: state.lastImageSize, mode: state.lastMode });
        }
      } catch (error) { state.lastRequest.parseError = error.message; }
    }
    const response = await handler(request, env);
    state.lastStatus = response.status;
    state.lastResponse = await response.clone().json();
    return response;
  }
  return { state, handleRequest };
}

export function createPreviewServer() {
  const preview = createPreview();
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) { res.writeHead(413); res.end('Preview request limit exceeded'); return; }
        chunks.push(chunk);
      }
      const request = new Request(`http://127.0.0.1:18776${req.url}`, { method: req.method,
        headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) });
      const response = await preview.handleRequest(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message, softwareOnly: true }));
    }
  });
  return { ...preview, server };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = createPreviewServer();
  server.listen(18776, '127.0.0.1', () => console.log('SOFTWARE ONLY: real Worker + stub model at http://127.0.0.1:18776; no paid inference'));
}
