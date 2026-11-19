import { QUESTIONS } from './questions.mjs';
import { attachPolicy, ruleQuestions } from './rule-evaluation.mjs';

export const POLICY_VERSION = 'toronto-local-catalog-v1';
// Conservative engineering gates, not calibrated correctness guarantees.
export const GATES = Object.freeze({ subject: { minimum: 0.8, margin: 0.2 }, material: { minimum: 0.85, margin: 0.2 }, kind: { minimum: 0.8, margin: 0.2 }, fact: { minimum: 0.85, margin: 0.2 } });
const RULES = {
  plastic_drink_bottle: { source: 'plastic bottles', requires: { condition: 'empty_clean', plastic_color: 'non_black', compostable_mark: 'not_marked' } },
  metal_food_drink_can: { source: 'food cans', requires: { condition: 'empty_clean' } },
  glass_food_drink_container: { source: 'glass jars', requires: { condition: 'empty_clean' } },
  paper_sheet: { source: 'paper', requires: { paper_finish: 'uncoated', paper_soiling: 'clean' } },
  cardboard_box: { source: 'cardboard boxes (unwaxed)', requires: { paper_finish: 'uncoated', paper_soiling: 'clean' } },
  paper_cup: { source: 'paper coffee cups', requires: {} },
  snack_wrapper: { source: 'candy wrappers', requires: {} },
  food_scraps: { source: 'food waste', requires: {} },
  foam_food_container: { source: 'foam clamshell/takeout container', requires: { condition: 'empty_clean' } },
  rigid_plastic_food_container: { source: 'plastic food tubs', requires: { condition: 'empty_clean', plastic_color: 'non_black' } },
  plastic_film_bag: { source: 'plastic bags (soft and stretchy)', requires: { condition: 'empty_clean', plastic_color: 'non_black', compostable_mark: 'not_marked' } },
  battery: { source: 'household batteries', requires: {} },
  electronics: { source: 'cell phones/cellular/mobile phones', requires: {} },
  hazardous_product: { source: 'paints', requires: {} },
  sharp: { source: 'razor blades', requires: {} },
  textile: { source: 'clothing', requires: {} },
  ceramic: { source: 'ceramic dishes', requires: {} },
};
export function compactQuestions(items) {
  const schema = { ...QUESTIONS };
  for (const [kind,rule] of Object.entries(RULES)) {
    const source=items.find(item=>item.item===rule.source);
    if(source)Object.assign(schema,ruleQuestions(source,`rule_${kind}`));
  }
  if(Object.keys(schema).length>64)throw Error('Compact source-rule schema exceeds provider limit');
  return schema;
}
const QUESTIONS_FOR_USER = {
  condition: 'Is the container empty and rinsed? Open it and check the interior.',
  plastic_color: 'Is the plastic itself black (not merely the printed label)?',
  compostable_mark: 'Does the item have a compostable/biodegradable marking? Check all sides.',
  paper_finish: 'Is the paper/cardboard unwaxed and not plastic-lined?',
  paper_soiling: 'Is the paper/cardboard free from food, grease and liquid?',
};

export function validateAnswers(raw, schema = QUESTIONS) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Missing answers');
  const answers = {};
  for (const [id, question] of Object.entries(schema)) {
    const answer = raw[id];
    if (!answer || typeof answer !== 'object') throw new Error(`Missing answer: ${id}`);
    const keys = Object.keys(question.criteria);
    if (!keys.includes(answer.choice)) throw new Error(`Invalid choice: ${id}`);
    if (!answer.probabilities || Object.keys(answer.probabilities).length !== keys.length) throw new Error(`Invalid probabilities: ${id}`);
    let sum = 0;
    for (const key of keys) {
      const value = answer.probabilities[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid probability: ${id}`);
      sum += value;
    }
    if (Math.abs(sum - 1) > 0.02) throw new Error(`Unnormalized probabilities: ${id}`);
    const p = answer.probabilities[answer.choice];
    const runnerUp = Math.max(...keys.filter(key => key !== answer.choice).map(key => answer.probabilities[key]));
    if (runnerUp > p + 0.00001) throw new Error(`Inconsistent winner: ${id}`);
    answers[id] = { choice: answer.choice, p, margin: p - runnerUp };
  }
  return answers;
}
export function passes(answer, gate) { return Boolean(answer && answer.p >= gate.minimum && answer.margin >= gate.margin); }

// An abstention never contains a candidate policy: legacy and modern consumers
// must not mistake a rejected identity's category or instructions for guidance.
export function abstain(answers, reason, metadata = {}, allowMaterial = true) {
  const material = answers.material;
  const materialOnly = allowMaterial && passes(material, GATES.material) && !['unknown', 'mixed'].includes(material.choice);
  return { ...metadata, status: materialOnly ? 'material_only' : 'manual_review', reason,
    category: null, policy_category: null, proposed_category: null, source_category: null,
    selected_item: null, selected_kind: null, source_items: [], instructions: [], rule_evaluation: [], matched_rule_indexes: [], clarification: [],
    selected_material: materialOnly ? material.choice : null, material_probability: material?.p ?? null,
    identity_uncertain: true, policy_conditions_pending: false, automatic_routing_enabled: false,
    policy_version: POLICY_VERSION, calibration: 'Conservative uncalibrated model-score gates; no disposal policy is inferred from material alone.',
    special_handling: answers.hazard?.choice === 'evident', observed: answers };
}

export function subjectDecision(answers, metadata = {}) {
  const subject = answers.subject;
  if (passes(subject, GATES.subject) && subject.choice === 'single_item') return null;
  const confident = passes(subject, GATES.subject);
  const noItem = confident && ['human_only', 'no_item'].includes(subject?.choice);
  return { ...abstain(answers, noItem ? 'No separate item is identifiable. No disposal decision was made.' : 'A single separate item is not established. Scan one item clearly or request manual review.', metadata, false),
    status: noItem ? 'no_item' : 'manual_review', no_item_reason: confident ? subject.choice : 'uncertain_subject' };
}

const KIND_MATERIALS = {
  plastic_drink_bottle: ['plastic'], metal_food_drink_can: ['metal'], glass_food_drink_container: ['glass'],
  paper_sheet: ['paper'], cardboard_box: ['cardboard', 'paper'], paper_cup: ['paper', 'cardboard'],
  foam_food_container: ['foam'], rigid_plastic_food_container: ['plastic'], plastic_film_bag: ['plastic'],
  food_scraps: ['organic'], textile: ['textile'], ceramic: ['ceramic'],
};
export function conflictingMaterial(answers) {
  if (answers.material?.choice === 'mixed') return true;
  const expected = KIND_MATERIALS[answers.kind?.choice];
  return Boolean(expected && passes(answers.kind, GATES.kind) && passes(answers.material, GATES.material) &&
    answers.material.choice !== 'unknown' && !expected.includes(answers.material.choice));
}

export function resolvePolicy(raw, items) {
  const answers=validateAnswers(raw);
  const subject = subjectDecision(answers);
  if (subject) return subject;
  if (conflictingMaterial(answers)) return abstain(answers, 'Material and item evidence conflict or indicate mixed materials. No disposal policy is confirmed.', {}, false);
  if (!RULES[answers.kind.choice] || !passes(answers.kind, GATES.kind)) return abstain(answers, 'Item identity is not sufficiently supported. Any material label is informational only; no bin is confirmed.');
  const ranked=Object.entries(raw.kind.probabilities).filter(([kind])=>RULES[kind]).sort((a,b)=>b[1]-a[1]);
  const [kind,probability]=ranked[0];
  const rule=RULES[kind], source=items.find(item=>item.item===rule.source);
  if(!source)throw Error(`Catalog rule source missing: ${rule.source}`);
  const base={policy_version:POLICY_VERSION,policy_scope:'Bundled Toronto Waste Wizard snapshot; follow the item-specific source instructions.',
    automatic_routing_enabled:false,calibration:'Conservative model-score gates, not calibrated correctness guarantees.',
    category:null,selected_kind:kind,selected_item:kind.replaceAll('_',' ').replace(/^./,c=>c.toUpperCase()),match_probability:probability,
    identity_uncertain:['unknown','other'].includes(answers.kind.choice),observed:answers,clarification:[],
    alternatives:ranked.slice(1,4).map(([item,probability])=>({item:item.replaceAll('_',' '),probability})),
    identification:'common-item policy rule, not exact catalog identification'};
  let decision=attachPolicy(base,source,answers,raw,`rule_${kind}`);
  const special=['battery','electronics','hazardous_product','sharp'].includes(kind)||answers.hazard.choice==='evident';
  if(special)return {...decision,status:'manual_review',special_handling:true,reason:'Best matching item and source guidance shown. Follow the special-handling or sharp-object instructions; do not use an automated ordinary-bin decision.'};
  if (!passes(answers.hazard, GATES.fact) || answers.hazard.choice !== 'absent') return {...decision,status:'manual_review',category:null,reason:'Special-handling hazards cannot be ruled out. Review the item and its source instructions manually.'};
  const exception=['plastic_drink_bottle','plastic_film_bag','rigid_plastic_food_container','foam_food_container'].includes(kind)&&((answers.plastic_color.choice==='black'&&passes(answers.plastic_color,GATES.fact))||(kind!=='foam_food_container'&&answers.compostable_mark.choice==='marked'&&passes(answers.compostable_mark,GATES.fact)));
  if(exception)return {...decision,status:'suggestion',category:'Garbage Bin',policy_category:'Garbage Bin',proposed_category:'Garbage Bin',reason:'The source rule directs black or compostable material to garbage. Review the highlighted instruction.'};
  for(const [id,expected] of Object.entries(rule.requires))if(answers[id].choice!==expected||!passes(answers[id],GATES.fact))decision.clarification.push({id,question:QUESTIONS_FOR_USER[id],observed:answers[id].choice,required:expected});
  if(decision.clarification.length||decision.policy_conditions_pending)return {...decision,status:'needs_clarification',reason:'Best matching item and its WasteWizard policy are shown. Highlighted checks identify conditions the photo cannot establish.'};
  return {...decision,status:'suggestion',category:decision.policy_category,reason:'Highest-ranked item type and its source policy; highlighted instructions reflect the observed condition.'};
}

export function searchCatalog(items, text, limit = 10) {
  if (typeof text !== 'string' || text.length < 2 || text.length > 120) return [];
  const terms = text.toLowerCase().trim().split(/\s+/);
  return items.filter(item => terms.every(term => item.item.toLowerCase().includes(term)))
    .sort((a, b) => a.item.length - b.item.length || a.item.localeCompare(b.item)).slice(0, limit);
}
