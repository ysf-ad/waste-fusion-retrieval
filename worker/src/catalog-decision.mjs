import { baselineQuestions, choice, QUESTIONS, SUBJECT_QUESTIONS } from './questions.mjs';
import { validateAnswers, POLICY_VERSION, GATES, passes, subjectDecision, abstain, conflictingMaterial } from './policy.mjs';
import { attachPolicy, ruleQuestions } from './rule-evaluation.mjs';
import { ProviderError, supportsExact } from './providers.mjs';

// Chunk-local scores propose candidates, not globally comparable confidence.
// Open-set heads share stage one; a rejected subject never needs stage two.
export async function identifyCatalog({ image, items, ask, env, provider, timeoutMs }) {
  if (!supportsExact(provider)) throw new ProviderError('exact_provider_unsupported', 'Full-catalog mode requires a supported decision provider. Use the compact path with Clef/Clef-Flash.', 400);
  const started = performance.now();
  const chunks = baselineQuestions(items);
  const firstSchema = { ...SUBJECT_QUESTIONS, ...chunks };
  const first = await ask({ image, questions: firstSchema, provider, env, timeoutMs });
  let preliminary;
  try { preliminary = validateAnswers(first?.answers, firstSchema); }
  catch { throw new ProviderError('invalid_model_output', 'Invalid catalog candidate decisions.'); }
  const metadata = (second, schema) => ({
    identification: 'two-pass exact catalog choice', model_calls: second ? 2 : 1,
    question_count: Object.keys(firstSchema).length + (schema ? Object.keys(schema).length : 0),
    usage: { input_tokens: (first.usage?.input_tokens || 0) + (second?.usage?.input_tokens || 0), output_tokens: (first.usage?.output_tokens || 0) + (second?.usage?.output_tokens || 0) },
  });
  const rejectedSubject = subjectDecision(preliminary, metadata());
  if (rejectedSubject) return rejectedSubject;
  if (preliminary.material.choice === 'mixed') return abstain(preliminary, 'Mixed materials are not a confirmed single-material identity. Review manually.', metadata(), false);
  const finalists = [];
  for (const id of Object.keys(chunks)) {
    const best = Object.entries(first.answers[id].probabilities).filter(([key]) => key !== 'none').sort((a, b) => b[1] - a[1])[0];
    if (!best) continue;
    const index = Number(best[0].slice(5));
    if (Number.isInteger(index) && items[index]) finalists.push({ key: best[0], row: items[index] });
  }
  if (!finalists.length) return abstain(preliminary, 'No catalog identity is available. Any material label is informational only.', metadata());
  const remaining = timeoutMs - (performance.now() - started);
  if (remaining < 100) throw new ProviderError('decision_timeout', 'Catalog candidate stage used the decision budget. Sort manually.', 504);
  const schema = { match: choice('Which ONE exact catalog name best describes photo? Choose none if every finalist is a poor match or the image is unclear. Do not choose an item merely because it has similar material.', {
    none: 'None fits sufficiently, or uncertain', ...Object.fromEntries(finalists.map(({ key, row }) => [key, row.item])),
  }), ...QUESTIONS };
  for (const finalist of finalists) for (const [id, question] of Object.entries(ruleQuestions(finalist.row, `rule_${finalist.key}`))) {
    if (Object.keys(schema).length < 64) schema[id] = question;
  }
  const second = await ask({ image, questions: schema, provider, env, timeoutMs: remaining });
  let validated;
  try { validated = validateAnswers(second?.answers, schema); }
  catch { throw new ProviderError('invalid_model_output', 'Invalid final catalog decision.'); }
  const meta = metadata(second, schema);
  const rejectedFinalSubject = subjectDecision(validated, meta);
  if (rejectedFinalSubject) return rejectedFinalSubject;
  // Rechecking the same item must not create a contradictory material label.
  const materialChanged = passes(preliminary.material, GATES.material) && passes(validated.material, GATES.material) &&
    preliminary.material.choice !== 'unknown' && validated.material.choice !== 'unknown' && preliminary.material.choice !== validated.material.choice;
  if (materialChanged || conflictingMaterial(validated)) return abstain(validated, 'Material and item evidence conflict or indicate mixed materials. No disposal policy is confirmed.', meta, false);
  const ranked = Object.entries(second.answers.match.probabilities).filter(([key]) => key !== 'none').sort((a, b) => b[1] - a[1]);
  const [selectedKey, probability] = ranked[0] || [];
  const matched = finalists.find(item => item.key === selectedKey)?.row;
  const identity = { ...meta, match_probability: probability ?? null, none_probability: second.answers.match.probabilities.none };
  if (validated.match.choice === 'none' || !passes(validated.match, GATES.kind) || !matched) {
    return abstain(validated, 'No sufficiently supported catalog identity. Any material label is informational only; no bin is confirmed.', identity);
  }
  const base = { ...identity, status: 'manual_review', category: null, source_items: [], instructions: [], clarification: [],
    automatic_routing_enabled: false, calibration: 'Conservative model-score gates, not calibrated correctness guarantees.',
    policy_version: POLICY_VERSION, policy_scope: 'Bundled Toronto Waste Wizard snapshot; follow all item-specific conditions.', observed: validated,
    selected_item: matched.item, selected_material: passes(validated.material, GATES.material) && validated.material.choice !== 'unknown' ? validated.material.choice : null,
    material_probability: validated.material.p, identity_uncertain: false,
    alternatives: ranked.slice(1, 4).map(([key, probability]) => ({ item: finalists.find(item => item.key === key)?.row.item, probability })),
    special_handling: ['HHW', 'Electronic Waste'].includes(matched.category) || validated.hazard.choice === 'evident' };
  return { ...attachPolicy(base, matched, validated, second.answers, `rule_${selectedKey}`), status: 'catalog_match',
    reason: 'Supported catalog item and its WasteWizard policy. Highlighted instructions are conditional model estimates; check unresolved conditions.' };
}
