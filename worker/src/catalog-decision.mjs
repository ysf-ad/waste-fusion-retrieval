import { baselineQuestions, choice, QUESTIONS } from './questions.mjs';
import { validateAnswers, POLICY_VERSION } from './policy.mjs';
import { attachPolicy, ruleQuestions } from './rule-evaluation.mjs';
import { ProviderError } from './providers.mjs';

// Full-catalog mode: local winners are candidates, NOT globally comparable
// probabilities. A second shared choice compares finalists on one distribution.
// Independent chunk scores must never be normalized into fake global confidence.
export async function identifyCatalog({ image, items, ask, env, provider, timeoutMs }) {
  if (provider !== 'jev') throw new ProviderError('exact_provider_unsupported', 'Full-catalog mode currently requires Jev. Use the compact path with Clef/Clef-Flash.', 400);
  const started = performance.now();
  const chunks = baselineQuestions(items);
  const first = await ask({ image, questions: chunks, provider, env, timeoutMs });
  let preliminary;
  try { preliminary = validateAnswers(first.answers, chunks); }
  catch { throw new ProviderError('invalid_model_output', 'Invalid catalog candidate decisions.'); }
  const finalists = [];
  for (const id of Object.keys(preliminary)) {
    const probabilities = first.answers[id].probabilities;
    const best = Object.entries(probabilities).filter(([key]) => key !== 'none').sort((a, b) => b[1] - a[1])[0];
    if (!best) continue;
    const index = Number(best[0].slice(5));
    if (Number.isInteger(index) && items[index]) finalists.push({ key: best[0], row: items[index] });
  }
  const remaining = timeoutMs - (performance.now() - started);
  if (remaining < 100) throw new ProviderError('decision_timeout', 'Catalog candidate stage used the decision budget. Sort manually.', 504);
  const matchQuestion = choice('Which ONE exact catalog name best describes photo? Choose none if every finalist is a poor match or the image is unclear. Do not choose an item merely because it has similar material.', {
    none: 'None fits sufficiently, or uncertain', ...Object.fromEntries(finalists.map(({ key, row }) => [key, row.item])),
  });
  const schema = { match: matchQuestion, ...QUESTIONS };
  // Rule-applicability heads share this same image/call with identity and facts.
  // Do not add a serial model round trip merely to highlight source instructions.
  for(const finalist of finalists)for(const [id,question] of Object.entries(ruleQuestions(finalist.row,`rule_${finalist.key}`))){
    if(Object.keys(schema).length<64)schema[id]=question;
  }
  const second = await ask({ image, questions: schema, provider, env, timeoutMs: remaining });
  let validated;
  try { validated = validateAnswers(second.answers, schema); }
  catch { throw new ProviderError('invalid_model_output', 'Invalid final catalog decision.'); }
  const ranked=Object.entries(second.answers.match.probabilities).filter(([key])=>key!=='none').sort((a,b)=>b[1]-a[1]);
  const [selectedKey,probability]=ranked[0]||[];
  const matched = finalists.find(item => item.key === selectedKey)?.row;
  if(!matched)throw new ProviderError('invalid_model_output','No catalog candidates were returned.');
  const base = { status: 'manual_review', category: null, source_items: [], instructions: [], clarification: [],
    automatic_routing_enabled: false, calibration: 'Highest-ranked named candidate; model probabilities are not calibrated correctness.',
    identification: 'two-pass exact catalog choice', policy_version: POLICY_VERSION,
    policy_scope: 'Bundled Toronto Waste Wizard snapshot; follow all item-specific conditions.', observed: Object.fromEntries(['match',...Object.keys(QUESTIONS)].map(id=>[id,validated[id]])),
    selected_item:matched.item,match_probability:probability,none_probability:second.answers.match.probabilities.none,
    identity_uncertain:validated.match.choice==='none',
    alternatives:ranked.slice(1,4).map(([key,probability])=>({item:finalists.find(item=>item.key===key)?.row.item,probability})),
    special_handling:['HHW','Electronic Waste'].includes(matched.category)||validated.hazard.choice==='evident',
    model_calls: 2, question_count: Object.keys(chunks).length + Object.keys(schema).length,
    usage: { input_tokens: (first.usage?.input_tokens || 0) + (second.usage?.input_tokens || 0), output_tokens: (first.usage?.output_tokens || 0) + (second.usage?.output_tokens || 0) } };
  const decision=attachPolicy(base,matched,validated,second.answers,`rule_${selectedKey}`);
  return { ...decision, status:'catalog_match',
    reason:base.identity_uncertain?'Closest named catalog candidate shown even though the model preferred no match. Treat this as a tentative best guess and check the item name.':'Highest-ranked catalog item and its WasteWizard policy. Highlighted source instructions reflect estimated rule applicability; check any unresolved conditions.' };

}
