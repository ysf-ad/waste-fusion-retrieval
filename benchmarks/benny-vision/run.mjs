import { createHash } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { createHandler } from '../../worker/src/service.mjs';
import { askModel, PROVIDERS } from '../../worker/src/providers.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const PROVIDER_IDS = ['jev', 'd1.2-ultra', 'd1.2'];
const STATUSES = new Set(['no_item', 'material_only', 'manual_review', 'catalog_match']);
const MAX_SAMPLES = 20;
const MAX_JPEG = 2_500_000;
const RESERVE = { jev: 64_000, 'd1.2-ultra': 64 * 65_536, 'd1.2': 64 * 65_536 };
const [manifestPath, frozenSha, ...options] = process.argv.slice(2);
if (!manifestPath || !/^[0-9a-f]{64}$/.test(frozenSha ?? '') || ![0, 3].includes(options.length) || (options.length && options[0] !== '--live')) {
  throw Error('Usage: node run.mjs MANIFEST FROZEN_SHA256 [--live NEW_LEDGER.jsonl APPROVED_RESERVE_USD]');
}
const raw = await readFile(manifestPath);
if (hash(raw) !== frozenSha) throw Error('Manifest differs from frozen digest.');
const manifest = JSON.parse(raw);
if (!Array.isArray(manifest.cases) || manifest.cases.length < 1 || manifest.cases.length > MAX_SAMPLES) throw Error('Use 1–20 pre-labeled samples.');
const root = dirname(resolve(manifestPath));
const seen = new Set(), seenImages = new Set();
const cases = [];
for (const row of manifest.cases) {
  const { id, file, sha256, expected } = row;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id ?? '') || seen.has(id) || seenImages.has(sha256) ||
      typeof file !== 'string' || !STATUSES.has(expected?.status) || !Object.hasOwn(expected, 'bin') ||
      (expected.bin !== null && (expected.status !== 'catalog_match' || typeof expected.bin !== 'string' || !expected.bin.trim())) ||
      (expected.status === 'material_only' && typeof expected.material !== 'string') ||
      (expected.status === 'no_item' && !['human_only','no_item'].includes(expected.reason))) throw Error('Invalid or duplicate case in manifest.');
  const path = resolve(root, file), rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || isAbsolute(file)) throw Error('JPEG paths must be relative to the manifest directory.');
  const info = await lstat(path);
  if (!info.isFile() || info.size < 4 || info.size > MAX_JPEG) throw Error(`Not a bounded JPEG: ${id}`);
  const jpeg = await readFile(path);
  if (jpeg[0] !== 255 || jpeg[1] !== 216 || jpeg[2] !== 255 || hash(jpeg) !== sha256) throw Error(`Unverified JPEG: ${id}`);
  seen.add(id); seenImages.add(sha256);
  cases.push({ id, sha256, expected, image: 'data:image/jpeg;base64,' + jpeg.toString('base64') });
}
const maxCalls = cases.length * PROVIDER_IDS.length * 2;
const reserveUsd = cases.length * 2 * PROVIDER_IDS.reduce((sum, id) => sum + RESERVE[id] * PROVIDERS[id].input_per_million / 1e6, 0);
const plan = { schema: 1, manifest_sha256: frozenSha, providers: PROVIDER_IDS, samples: cases.length, maxCalls, reserveUsd,
  scope: 'Local exact Worker handler; not Raspberry Pi front-end latency. Same prepared JPEG for every provider. No fallback or retries.' };
console.log(JSON.stringify(plan));
if (!options.length) process.exit(0);
const [, ledgerPath, budget] = options;
if (!ledgerPath || !Number.isFinite(Number(budget)) || Number(budget) < reserveUsd) throw Error('Explicit reserve approval too small; no requests sent.');
if (!process.env.LIQUID_API_KEY?.trim() || !process.env.TYPESAFE_API_KEY?.trim()) throw Error('Both provider credentials must be configured before the first request.');
const items = JSON.parse(await readFile(new URL('../../worker/src/items.json', import.meta.url), 'utf8'));
const ledger = await open(ledgerPath, 'wx', 0o600);
const append = async record => { await ledger.appendFile(`${JSON.stringify(record)}\n`); await ledger.sync(); };
const env = { LIQUID_API_KEY: process.env.LIQUID_API_KEY, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, DECISION_TIMEOUT_MS: '1700' };
const outcomes = [];
let calls = 0, current = null;
const handler = createHandler(items, async args => {
  if (calls >= maxCalls || current.calls >= 2) throw Error('Call ceiling reached.');
  calls++; current.calls++;
  await append({ event: 'call_started', id: current.id, provider: current.provider, stage: current.calls });
  const result = await askModel(args);
  const tokens = result.usage?.input_tokens;
  if (Number.isSafeInteger(tokens) && tokens >= 0 && tokens <= RESERVE[current.provider]) current.tokens += tokens;
  else current.unknownUsage++;
  current.accountedCalls++;
  if (Number.isSafeInteger(tokens) && tokens > RESERVE[current.provider]) current.overReserve = true;
  return result;
});
try {
  await append({ event: 'plan', ...plan, time: new Date().toISOString() });
  for (let i = 0; i < cases.length; i++) for (let j = 0; j < PROVIDER_IDS.length; j++) {
    const row = cases[i], provider = PROVIDER_IDS[(i+j) % PROVIDER_IDS.length];
    current = { id: row.id, provider, calls: 0, tokens: 0, unknownUsage: 0, accountedCalls: 0 };
    const started = performance.now();
    const response = await handler(new Request('http://localhost/api/classify', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ image: row.image, mode:'exact' }) }),
      { ...env, DECISION_PROVIDER: provider });
    const elapsed = Math.round(performance.now() - started), data = await response.json();
    const bin = data.category ?? data.policy_category ?? data.proposed_category ?? null;
    const correct = response.ok && data.status === row.expected.status && bin === row.expected.bin &&
      (row.expected.item === undefined || data.selected_item === row.expected.item) &&
      (row.expected.material === undefined || data.selected_material === row.expected.material) &&
      (row.expected.reason === undefined || data.no_item_reason === row.expected.reason);
    const result = { event:'result', id:row.id, provider, elapsed_ms:elapsed, http:response.status, code:data.code ?? null,
      status:data.status, category:bin, item:data.selected_item ?? null, material:data.selected_material ?? null, reason:data.no_item_reason ?? null,
      expected:row.expected, correct, false_bin:bin !== null && bin !== row.expected.bin, calls:current.calls, billed_input_tokens:current.tokens,
      unknown_usage_calls: current.unknownUsage + current.calls - current.accountedCalls };
    outcomes.push(result); await append(result);
    if (current.overReserve || [401, 402, 403, 429].includes(response.status) || /^provider_http_(401|402|403|429)$/.test(data.code || '')) throw Error('Provider access/budget/rate guard stopped run; do not replay this ledger.');
  }
  const summary = Object.fromEntries(PROVIDER_IDS.map(id => {
    const rows = outcomes.filter(r => r.provider === id), times = rows.map(r => r.elapsed_ms).sort((a,b)=>a-b);
    const sum = field => rows.reduce((n,r) => n + r[field], 0);
    return [id, {attempts:rows.length, correct:rows.filter(r => r.correct).length, false_bins:rows.filter(r => r.false_bin).length,
      errors:rows.filter(r => r.http >= 400).length, timeouts:rows.filter(r => r.code === 'decision_timeout').length,
      p50_ms:times[Math.ceil(times.length*.5)-1], p95_ms:times[Math.ceil(times.length*.95)-1], known_usd:sum('billed_input_tokens')*PROVIDERS[id].input_per_million/1e6,
      unknown_usage_calls:sum('unknown_usage_calls')}];
  }));
  await append({ event:'summary', summary }); console.log(JSON.stringify(summary));
} finally { await ledger.close(); }
