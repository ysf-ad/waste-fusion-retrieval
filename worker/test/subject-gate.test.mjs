import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { QUESTIONS, SUBJECT_QUESTIONS } from '../src/questions.mjs';
import { compactQuestions, resolvePolicy } from '../src/policy.mjs';
import { identifyCatalog } from '../src/catalog-decision.mjs';
import { createHandler } from '../src/service.mjs';
import { createDeployedHandler } from '../src/deployment.mjs';
const items = JSON.parse(await readFile(new URL('../src/items.json', import.meta.url)));
const defaults = {subject:'single_item',material:'unknown',kind:'plastic_drink_bottle',hazard:'absent',condition:'empty_clean',plastic_color:'non_black',compostable_mark:'not_marked',paper_finish:'uncoated',paper_soiling:'clean'};
function answer(q,choice,p=.98){const keys=Object.keys(q.criteria);return {choice,probabilities:Object.fromEntries(keys.map(k=>[k,k===choice?p:(1-p)/(keys.length-1)]))};}
function raw(schema,overrides={}){return Object.fromEntries(Object.entries(schema).map(([id,q])=>{const value=overrides[id]??defaults[id]??(id==='match'?'item_0':id.startsWith('items_')?Object.keys(q.criteria).find(k=>k!=='none'):'check');return [id,typeof value==='object'?value:answer(q,value)];}));}
function noPolicy(d){assert.equal(Object.hasOwn(d,'selected_material'),false);assert.equal(Object.hasOwn(d,'material_probability'),false);for(const key of ['category','policy_category','proposed_category','source_category','selected_item','selected_kind'])assert.equal(d[key],null,key);for(const key of ['source_items','instructions','rule_evaluation','matched_rule_indexes'])assert.deepEqual(d[key],[],key);assert.equal(d.automatic_routing_enabled,false);assert.equal(d.identity_uncertain,true);}
function exact(first={},second={}){let calls=0;const seen=[];return {seen,run:()=>identifyCatalog({image:'mock',items:[items.find(i=>i.item==='plastic bottles')],env:{},provider:'d1.2-ultra',timeoutMs:1700,ask:async o=>{seen.push(o);return {answers:raw(o.questions,++calls===1?first:second),usage:{input_tokens:7}};}})};}
for(const subject of ['human_only','no_item','multiple_items','unknown']){
 test(`compact ${subject} overrides a confident hallucinated bottle with no policy`,()=>{const d=resolvePolicy(raw(QUESTIONS,{subject,material:'plastic'}),items);noPolicy(d);assert.equal(d.status,['human_only','no_item'].includes(subject)?'no_item':'manual_review');assert.equal(d.no_item_reason,subject);assert.equal(Object.hasOwn(d,'selected_material'),false);});
 test(`exact ${subject} stops after first shared call`,async()=>{const fixture=exact({subject,material:'plastic'}),d=await fixture.run();noPolicy(d);assert.equal(fixture.seen.length,1);assert.equal(d.model_calls,1);assert.equal(d.question_count,Object.keys(fixture.seen[0].questions).length);assert.deepEqual(d.usage,{input_tokens:7,output_tokens:0});assert(Object.keys(SUBJECT_QUESTIONS).every(id=>fixture.seen[0].questions[id]));});
}
test('uncertain human-only vote abstains without claiming that a person was identified',()=>{const d=resolvePolicy(raw(QUESTIONS,{subject:answer(QUESTIONS.subject,'human_only',.6)}),items);noPolicy(d);assert.equal(d.status,'manual_review');assert.equal(d.no_item_reason,'uncertain_subject');});
test('item held by a human is allowed when a separate item is established',()=>{const d=resolvePolicy(raw(QUESTIONS,{subject:'single_item',material:'plastic'}),items);assert.equal(d.selected_kind,'plastic_drink_bottle');assert.equal(d.category,'Blue Bin');assert.equal(d.identity_uncertain,false);});
for(const material of ['wood','glass','metal','textile'])test(`unsupported item keeps reliable ${material} diagnostic-only without a bin or guessed row`,()=>{const d=resolvePolicy(raw(QUESTIONS,{kind:'other',material}),items);noPolicy(d);assert.equal(d.status,'manual_review');assert.equal(d.observed.material.choice,material);assert.equal(d.observed.material.p,.98);});
for(const material of ['unknown','mixed'])test(`unknown identity with ${material} material requires manual review`,()=>{const d=resolvePolicy(raw(QUESTIONS,{kind:'unknown',material}),items);noPolicy(d);assert.equal(d.status,'manual_review');assert.equal(Object.hasOwn(d,'selected_material'),false);});
test('weak material does not create material-only fallback',()=>{const d=resolvePolicy(raw(QUESTIONS,{kind:'unknown',material:answer(QUESTIONS.material,'wood',.84)}),items);noPolicy(d);assert.equal(d.status,'manual_review');});
test('conflicting compact material and identity do not attach either candidate policy',()=>{const d=resolvePolicy(raw(QUESTIONS,{material:'metal'}),items);noPolicy(d);assert.equal(d.status,'manual_review');});
test('weak identity and evident hazard cannot attach an ordinary candidate policy',()=>{const d=resolvePolicy(raw(QUESTIONS,{kind:answer(QUESTIONS.kind,'plastic_drink_bottle',.4),hazard:'evident',material:'plastic'}),items);noPolicy(d);assert.equal(d.special_handling,true);});
test('uncertain hazard never issues an ordinary bin even for a strong kind',()=>{const d=resolvePolicy(raw(QUESTIONS,{hazard:'unknown'}),items);assert.equal(d.status,'manual_review');assert.equal(d.category,null);});
for(const match of ['none',answer({criteria:{none:0,item_0:0}},'item_0',.79)])test(`exact rejected identity has no candidate policy (${typeof match==='string'?match:'weak'})`,async()=>{const f=exact({material:'wood'},{match,kind:'other',material:'wood'}),d=await f.run();noPolicy(d);assert.equal(d.status,'manual_review');assert.equal(d.observed.material.choice,'wood');assert.equal(f.seen.length,2);assert.equal(d.model_calls,2);});
test('exact stage-two subject rejection clears all policy and cannot use prior material',async()=>{const f=exact({material:'plastic'},{subject:'human_only',material:'plastic'}),d=await f.run();noPolicy(d);assert.equal(d.status,'no_item');assert.equal(d.no_item_reason,'human_only');assert.equal(Object.hasOwn(d,'selected_material'),false);});
test('exact cross-stage material conflict abstains even with a confident exact match',async()=>{const f=exact({material:'wood'},{material:'plastic'}),d=await f.run();noPolicy(d);assert.equal(d.status,'manual_review');});
test('exact mixed material stops in the first pass',async()=>{const f=exact({material:'mixed'}),d=await f.run();noPolicy(d);assert.equal(d.status,'manual_review');assert.equal(d.model_calls,1);});
test('supported exact Liquid decision keeps two calls and at most 64 heads',async()=>{const f=exact({material:'plastic'},{material:'plastic'}),d=await f.run();assert.equal(d.status,'catalog_match');assert.equal(d.selected_item,'plastic bottles');assert.equal(f.seen.length,2);assert(f.seen.every(c=>Object.keys(c.questions).length<=64));assert.equal(d.model_calls,2);assert.equal(d.usage.input_tokens,14);});
test('supported wooden catalog identity retains the real row, not a material label',async()=>{const source=items.find(row=>/wood/i.test(row.item));assert(source);let calls=0;const d=await identifyCatalog({image:'mock',items:[source],provider:'d1.2-ultra',timeoutMs:1700,ask:async o=>{calls++;return {answers:raw(o.questions,{material:'wood',kind:'other'})};}});assert.equal(d.status,'catalog_match');assert.equal(d.selected_item,source.item);assert.deepEqual(d.source_items,[source.item]);assert.deepEqual(d.instructions,source.instructions);assert.equal(d.observed.material.choice,'wood');assert.equal(Object.hasOwn(d,'selected_material'),false);assert.equal(Object.hasOwn(d,'material_probability'),false);assert.equal(calls,2);});
test('empty catalog abstains in one call despite reliable material',async()=>{let calls=0;const d=await identifyCatalog({image:'mock',items:[],provider:'jev',timeoutMs:1700,ask:async o=>{calls++;return {answers:raw(o.questions,{material:'wood'})};}});noPolicy(d);assert.equal(d.status,'manual_review');assert.equal(calls,1);});
test('open-set production heads stay out of closed-set benchmark calls',async()=>{const image='data:image/png;base64,'+Buffer.from('\x89PNG\r\n\x1a\n','latin1').toString('base64');for(const mode of ['trashnet','taco','realwaste','realwaste8']){let calls=0;const handler=createHandler(items,async o=>{calls++;assert.equal(o.questions.subject,undefined);assert.equal(Object.keys(o.questions).length,1);const [id,q]=Object.entries(o.questions)[0];return {answers:{[id]:answer(q,Object.keys(q.criteria)[0])}};});const response=await handler(new Request('https://localhost/api/classify',{method:'POST',body:JSON.stringify({image,mode})}),{DECISION_PROVIDER:'jev'});assert.equal(response.status,200,mode);assert.equal(calls,1);}});
test('compact provider schema with subject/material stays bounded',()=>{const schema=compactQuestions(items);assert(Object.keys(schema).length<=64);for(const q of Object.values(schema))assert(Object.keys(q.criteria).length<=255);});
for (const [name,first,second,status,callsExpected] of [
  ['human only',{subject:'human_only',kind:'plastic_drink_bottle'},null,'no_item',1],
  ['empty scene',{subject:'no_item'},null,'no_item',1],
  ['uncertain subject',{subject:'unknown'},null,'manual_review',1],
  ['wood fallback',{material:'wood'},{match:'none',material:'wood',kind:'other'},'manual_review',2],
  ['local and final none',{items_0:answer({criteria:{none:0,item_0:0}},'none',.99)},{match:'none'},'manual_review',2],
  ['weak final match',{}, {match:answer({criteria:{none:0,item_0:0}},'item_0',.79)},'manual_review',2],
]) test(`deployed legacy ${name} cannot leak candidate identity or bin`,async()=>{
  let calls=0;
  const handler=createDeployedHandler([{item:'cigarettes',category:'Garbage Bin',instructions:['Place item in the Garbage Bin.']}],async o=>{
    const overrides=++calls===1?first:second;
    return {answers:raw(o.questions,overrides??{})};
  });
  const response=await handler(new Request('https://localhost/predict',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({imageDataUrl:'data:image/jpeg;base64,/9j/4A==',mode:'exact'})}));
  assert.equal(response.status,200);const d=await response.json();noPolicy(d);assert.equal(d.status,status);assert.equal(calls,callsExpected);
  assert.equal(d.results[0].category,'Not accepted');
  assert.doesNotMatch(d.results[0].item,/cigarette|plastic|bottle/i);assert.doesNotMatch(d.item_name,/cigarette|plastic|bottle/i);
  assert.doesNotMatch(d.results[0].instruction,/cigarette|Garbage Bin|Blue Bin|Green Bin/i);
  assert.doesNotMatch(d.results[0].item,/looks like|wood/i);
  if(status==='no_item')assert.equal(d.no_item_reason,first.subject);
});
