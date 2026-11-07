import { choice } from './questions.mjs';
const STATES = { applies: 'This instruction applies to the photographed item and its visibly established condition', does_not_apply: 'A visible condition rules this instruction out', check: 'This conditional instruction needs a fact that cannot be verified from the photo (including hidden contents, dimensions, labels or contamination)', reference: 'General reference or optional guidance, not the primary disposal instruction' };
export function ruleQuestions(source, prefix) {
  return Object.fromEntries(source.instructions.map((text,index)=>[`${prefix}_${index}`,choice(`For catalog item "${source.item}", assess this EXACT source instruction against the photo: "${text}". Do not infer hidden interiors are empty or infer physical size without a scale. Follow all conditions in a sentence; if any needed condition is unknown choose check. This assesses applicability, not whether the instruction is good advice.`,STATES)]));
}
function readState(answer) {
  if(!answer || !Object.hasOwn(STATES,answer.choice) || !answer.probabilities || Object.keys(answer.probabilities).length!==4)throw Error('Invalid source-rule applicability');
  const values=Object.values(answer.probabilities);
  if(Object.keys(STATES).some(key=>typeof answer.probabilities[key]!=='number') || values.some(p=>!Number.isFinite(p)||p<0||p>1) || Math.abs(values.reduce((a,b)=>a+b,0)-1)>.02 || values.some(p=>p>answer.probabilities[answer.choice]+.00001))throw Error('Invalid source-rule probabilities');
  return {state:answer.choice,p:answer.probabilities[answer.choice]};
}
function fallback(text, observed) {
  const lower=text.toLowerCase(), facts=[];
  const test=(id,yes,no)=>{const fact=observed[id];if(fact)facts.push({id,...fact});return yes.includes(fact?.choice)?true:no.includes(fact?.choice)?false:null;};
  const predicates=[];
  if(/\bblack\b/.test(lower))predicates.push(test('plastic_color',['black'],['non_black']));
  if(/\bcompostable\b|\bbiodegradable\b/.test(lower))predicates.push(test('compostable_mark',['marked'],['not_marked']));
  if(/\bshorter\b|\binches\b|\b4\s*"|\b10-50\b|\bif this item is infested\b/.test(lower))predicates.push(null);
  if(/\bempty\b|\brinsed\b|\bfree of residue\b/.test(lower))predicates.push(test('condition',['empty_clean'],['contents']));
  if(/\bsoiled\b/.test(lower))predicates.push(/foam/.test(lower)?test('condition',['contents'],['empty_clean']):test('paper_soiling',['soiled'],['clean']));
  if(!predicates.length)return {state:/^(place|wrap|batteries are|this item is household hazardous)/i.test(text)?'applies':'reference',facts};
  const or=/\bor\b/.test(lower)&&!/empty.*\bor\b/.test(lower);
  const state=or?(predicates.includes(true)?'applies':predicates.includes(null)?'check':'does_not_apply'):(predicates.includes(false)?'does_not_apply':predicates.includes(null)?'check':'applies');
  return {state,facts};
}
export function evaluateRules(source, observed, raw={}, prefix='policy') {
  const rules=source.instructions.map((text,index)=>{
    const inferred=fallback(text,observed), answer=raw[`${prefix}_${index}`];
    const selected=answer?readState(answer):inferred;
    // Even a model applicability vote cannot turn a hidden container interior
    // into a verified empty one. Keep missing physical size evidence explicit.
    const emptyUnknown=/\bempty\b|\brinsed\b|\bfree of residue\b/i.test(text)&&!['empty_clean','contents'].includes(observed.condition?.choice);
    const knownException=/\bor\b/i.test(text)&&(observed.plastic_color?.choice==='black'||observed.paper_soiling?.choice==='soiled');
    const unknownSize=/shorter than|\b4 inches\b|\b4\s*"/i.test(text)&&!knownException;
    // A direct unconditional disposal instruction does not need an extra
    // condition vote. Avoid turning 'place this item in garbage' into a check
    // just because an unrelated interior/label observation is unknown.
    const unconditional=/^place (?:this item |item )?in (?:the )?(?:garbage(?: bin)?|blue bin(?: \(recycling\))?|green bin(?: \(organics\))?)\.?$/i.test(text);
    let state=unconditional?'applies':selected.state;
    if(state==='applies'&&(emptyUnknown||unknownSize))state='check';
    return {index,text,state,facts:inferred.facts,...(answer?{model_state:selected.state,model_probability:selected.p,...(state===selected.state?{probability:selected.p}:{})}:{}),basis:unconditional?'Unconditional source instruction':answer?'Model estimate using this exact source instruction':'Observed-condition rule evaluation'};
  });
  const matchedException=rules.some(rule=>rule.state==='applies'&&/^place\b/i.test(rule.text)&&/garbage/i.test(rule.text)&&/black|compostable|soiled|shorter/i.test(rule.text));
  if(matchedException)for(const rule of rules)if(rule.state==='applies'&&/blue bin/i.test(rule.text))rule.state='does_not_apply';
  // An unconditional Blue Bin line does not erase an unresolved exception above it.
  const unresolvedException=rules.some(rule=>rule.state==='check'&&/black|compostable|soiled|shorter/i.test(rule.text));
  if(unresolvedException)for(const rule of rules)if(rule.state==='applies'&&/blue bin/i.test(rule.text))rule.state='check';
  return rules;
}
export function attachPolicy(decision, source, observed, raw, prefix) {
  const rule_evaluation=evaluateRules(source,observed,raw,prefix);
  const matched_rule_indexes=rule_evaluation.filter(rule=>rule.state==='applies').map(rule=>rule.index);
  let category=source.category;
  for(const rule of rule_evaluation){if(rule.state==='applies'&&/^place\b/i.test(rule.text)&&/\bgarbage\b/i.test(rule.text)){category='Garbage Bin';break;}}
  return {...decision,policy_category:category,proposed_category:category,source_category:source.category,rule_evaluation,matched_rule_indexes,
    policy_conditions_pending:rule_evaluation.some(rule=>rule.state==='check'),source_items:[source.item],instructions:[...source.instructions]};
}
