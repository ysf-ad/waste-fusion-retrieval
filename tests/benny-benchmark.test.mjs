import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../benchmarks/benny-vision/run.mjs', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
test('pilot dry-run verifies frozen input; live is blocked before creating a ledger without approval and keys', t => {
  const dir = mkdtempSync(join(tmpdir(), 'benny-pilot-test-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const jpeg = Buffer.from([255,216,255,0,255,217]); // no inference; input hash/signature fixture only
  const manifest = Buffer.from(JSON.stringify({ cases:[{ id:'hand-case',file:'prepared.jpg',sha256:digest(jpeg),expected:{status:'no_item',reason:'human_only',bin:null} }] }));
  const file = join(dir, 'manifest.json'), ledger = join(dir, 'ledger.jsonl');
  writeFileSync(join(dir, 'prepared.jpg'), jpeg);
  writeFileSync(file, manifest);
  const env = { ...process.env, LIQUID_API_KEY:'', TYPESAFE_API_KEY:'' };
  const run = (...args) => spawnSync(process.execPath, [script,file,...args], { encoding:'utf8', timeout:5000, env });
  const frozen = digest(manifest), plan = run(frozen);
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).maxCalls, 6);
  assert.match(run('0'.repeat(64)).stderr, /differs from frozen/);
  assert.match(run(frozen, '--live', ledger, '0').stderr, /reserve approval too small/);
  assert.match(run(frozen, '--live', ledger, '100').stderr, /Both provider credentials/);
  assert.equal(existsSync(ledger), false);
});
