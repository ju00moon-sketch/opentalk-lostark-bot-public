import { createHash } from 'node:crypto';
import { GuildError } from './guild-store.js';
import { normalizeCharacter } from './character-profile.js';
import { calculateCharacterValuation, aggregateRosterValuations } from '../../src/roster-valuation.js';
import { createGemExpectationService } from '../../src/arkgrid-gem-expectation.js';
import { buildGemCostScenarios } from '../../src/arkgrid-gem-cost.js';
import { BRACELET_VALUE_RECORD_POLICY, BRACELET_T3_VALUE_RECORD_POLICY } from './bracelet-value-record-store.js';
import { BRACELET_REPLACEMENT_BASIS } from '../../src/bracelet-replacement-search.js';

const failure = () => new GuildError(502, 'valuation_unavailable');
const limited = () => new GuildError(429, 'valuation_rate_limited');
const missing = reason => ({ status:'unavailable', reason, items:[] });
const empty = () => ({ status:'empty', items:[] });
const keyOf = name => name.toLowerCase();
const BRACELET_STAT = /^(힘|민첩|지능|치명|특화|제압|신속|인내|숙련)\s*\+([\d,]+)$/;
// The stat lines an equipped bracelet shows, wherever the tooltip put them, for the replacement search.
function braceletStats(bracelet) {
  const rows=[...(Array.isArray(bracelet?.stats)?bracelet.stats:[]),...(Array.isArray(bracelet?.effects)?bracelet.effects:[])];
  const found=new Map();
  for(const row of rows) {
    const match=BRACELET_STAT.exec(typeof row?.text==='string'?row.text.trim():'');
    if(!match||found.has(match[1]))continue;
    const value=Number(match[2].replaceAll(',',''));
    if(Number.isSafeInteger(value)&&value>0)found.set(match[1],{name:match[1],value});
  }
  return [...found.values()];
}
const categories=['gems','accessories','engravings','honing','bracelet','arkgridGems'];
const scenarioIds=['general','boundGold','boundPheon','boundBoth'];
function braceletRecord(result,name,targetKey,now) {
  const record=result.record;
  return record&&keyOf(record.characterName||'')===keyOf(name)&&record.targetKey===targetKey&&
    record.policyVersion===(result.tier===3?BRACELET_T3_VALUE_RECORD_POLICY:BRACELET_VALUE_RECORD_POLICY)&&Number.isSafeInteger(record.recordedAt)&&record.recordedAt>=0&&record.recordedAt<=now&&
    Number.isFinite(record.costExpectedGold)&&record.costExpectedGold>0&&Number.isFinite(record.basePriceGold)&&record.basePriceGold>0&&
    Number.isFinite(record.expectedStartingBracelets)&&record.expectedStartingBracelets>=1&&
    Math.abs(record.costExpectedGold-record.basePriceGold*record.expectedStartingBracelets)<=Math.max(1,record.costExpectedGold)*1e-10?record:null;
}

function gemTotals(gems,unknown=0) {
  return {scenarios:Object.fromEntries(scenarioIds.map(id=>{
    const known=gems.filter(gem=>gem.scenarios?.[id]?.status==='ok'&&Number.isFinite(gem.scenarios[id].totalExpectedGold));
    const knownGold=known.reduce((sum,gem)=>sum+gem.scenarios[id].totalExpectedGold,0),missing=unknown+gems.length-known.length;
    return [id,{complete:missing===0,totalGold:missing===0?knownGold:null,knownGold,counts:{items:gems.length+unknown,known:known.length,unknown:missing}}];
  }))};
}

function rosterGemTotals(rows) {
  return {scenarios:Object.fromEntries(scenarioIds.map(id=>{
    const values=rows.map(row=>row.value?.gemValuation?.scenarios?.[id]);
    const knownGold=values.reduce((sum,value)=>sum+(value?.knownGold??0),0),complete=values.every(value=>value?.complete);
    const counts=values.reduce((sum,value)=>({items:sum.items+(value?.counts.items??1),known:sum.known+(value?.counts.known??0),unknown:sum.unknown+(value?.counts.unknown??1)}),{items:0,known:0,unknown:0});
    return [id,{complete,totalGold:complete?knownGold:null,knownGold,counts}];
  }))};
}

// Engraving books are server-bound: the card shows the roster's once-per-server list, not a per-character sum.
function categoryTotals(rows,aggregate) {
  return Object.fromEntries(categories.map(id=>{
    if(id==='engravings') {
      const books=Array.isArray(aggregate?.engravingBooks)?aggregate.engravingBooks:[],known=books.filter(book=>book.status==='ok').length;
      const knownGold=Number.isFinite(aggregate?.engravingBooksGold)?aggregate.engravingBooksGold:0,complete=aggregate?.engravingBooksComplete===true;
      return [id,{complete,knownGold,totalGold:complete?knownGold:null,counts:{items:books.length,known,unknown:books.length-known,estimated:0}}];
    }
    const groups=rows.map(row=>row.value?.components?.[id]);
    const knownGold=groups.reduce((total,group)=>total+(group?.knownGold??0),0);
    const counts=groups.reduce((total,group)=>({items:total.items+(group?.counts?.items??0),known:total.known+(group?.counts?.known??0),
      unknown:total.unknown+(group?.counts?.unknown??1),estimated:total.estimated+(group?.counts?.estimated??0)}),{items:0,known:0,unknown:0,estimated:0});
    const complete=groups.every(group=>group?.complete===true);
    return [id,{complete,knownGold,totalGold:complete?knownGold:null,counts}];
  }));
}

// 원정대 최고 기록이 저장해 두는 평가 입력 사본 (README.md).
// 기록 시점의 장비를 그대로 두고 오늘 시세로 다시 값을 매기기 위해, 평가가 실제로 읽는 필드만 담는다:
// `valuationTargets`(재련·보석·악세서리·각인서 대상과 시세 질의), 아크그리드 코어와 젬의 target,
// 장착 팔찌의 등급·티어와 옵션 줄, 팔찌 기댓값의 targetKey·status, 역할, 그리고 조회 시각(`updatedAt`).
// 장비 목록은 "있었는지"만 보므로 빈 배열로 줄인다. 한 캐릭터가 상한을 넘으면 null이고, 그 원정대는 기록을 갱신하지 않는다.
export const VALUATION_INPUTS_VERSION = 'roster-value-inputs-v1';
export const VALUATION_INPUTS_LIMIT = 256 * 1024;
const pick = (source,keys) => Object.fromEntries(keys.filter(key=>source?.[key]!==undefined).map(key=>[key,source[key]]));
// Only the text of a bracelet option line is read, by the replacement search's stat parser.
const optionLines = rows => Array.isArray(rows)?rows.map(row=>pick(row,['text'])):null;
// 평가가 실제로 읽는 필드만 고른다. 저장 사본(snapshotValuationInputs)과 지문(valuationFingerprint)이 같은 고르기를 쓰고,
// 사본에 한 번 더 적용해도 결과가 같다(사본으로 만든 지문이 원래 details로 만든 지문과 같다).
function valuationInputs(details) {
  const targets=details?.valuationTargets;
  if(!targets || typeof targets!=='object' || Array.isArray(targets))return null;
  const cores=Array.isArray(details.arkgrid?.cores)?details.arkgrid.cores.map(core=>({...pick(core,['name','slot']),
    gems:Array.isArray(core?.gems)?core.gems.map(gem=>pick(gem,['name','slot','icon','points','target'])):null})):null;
  const bracelet=details.bracelet?{...pick(details.bracelet,['name','tier','grade']),
    stats:optionLines(details.bracelet.stats),effects:optionLines(details.bracelet.effects)}:null;
  const expectation=details.efficiency?.braceletExpectation;
  return {valuationTargets:targets,arkgrid:cores?{cores}:null,bracelet,equipment:Array.isArray(details.equipment)?[]:null,
    efficiency:{braceletExpectation:expectation?pick(expectation,['targetKey','status']):null,
      score:pick(details.efficiency?.score,['role'])}};
}

// 원정대 환산 가치의 갱신 생략·기록 대조에 쓰는 지문. 평가가 읽는 입력 전체 — 재련·보석·악세서리·각인서 대상(targetKey),
// 아크그리드 코어와 젬, 장착 팔찌와 그 기댓값, 역할 — 를 담는다. 조회 때마다 바뀌는 값(`updatedAt`, 대상 목록의
// `observedAt`)은 빼서, 장비가 그대로면 지문도 그대로다. 대상 목록의 targetKey는 팔찌와 아크그리드 젬을 담지 않으므로
// 그것만 비교하면 팔찌만 바꾼 캐릭터를 다시 계산하지 않았다(2026-09-23 교차 검토 C-P1-1).
export const VALUATION_FINGERPRINT_VERSION = 'roster-value-fingerprint-v1';
export function valuationFingerprint(details) {
  const picked=valuationInputs(details);
  const targets=picked?.valuationTargets;
  if(!targets || typeof targets.targetKey!=='string' || !/^[a-f0-9]{64}$/.test(targets.targetKey))return null;
  const {valuationTargets,...rest}=picked;
  let text;
  try{text=JSON.stringify({version:VALUATION_FINGERPRINT_VERSION,targetKey:targets.targetKey,targetStatus:targets.status??null,...rest});}
  catch{return null;}
  return createHash('sha256').update(text).digest('hex');
}

export function snapshotValuationInputs(details,{maxBytes=VALUATION_INPUTS_LIMIT}={}) {
  const picked=valuationInputs(details);
  if(!picked || !Number.isSafeInteger(details.updatedAt))return null;
  const inputs={version:VALUATION_INPUTS_VERSION,updatedAt:details.updatedAt,...picked};
  let text;
  try{text=JSON.stringify(inputs);}catch{return null;}
  if(typeof text!=='string' || Buffer.byteLength(text)>maxBytes)return null;
  // What is handed back is what a store round trip would produce, so a replay cannot differ from the saved copy.
  try{return JSON.parse(text);}catch{return null;}
}

export function createCharacterValuationService({ readDetails, readRoster, prices, braceletValue, now=Date.now,
  currency={get:async()=>({status:'unavailable'})},gemSolver=createGemExpectationService(), honingRecipe=()=>null, operationTimeoutMs=120000, pollTimeoutMs=20000, cacheMs=300000,
  // Durable 원정대 환산 가치: a finished row and the roster it came from are handed over without touching the response.
  onRoster=()=>{}, onCharacterValue=()=>{} }={}) {
  const jobs=new Map(), characters=new Map(), inflight=new Map(), attempts=new Map(), controllers=new Set();
  const snapshots=new WeakMap();
  let closed=false;
  function allow(ip) {
    if(closed)return false;
    const time=now();for(const [key,row] of attempts)if(row.until<=time)attempts.delete(key);
    let row=attempts.get(ip);if(!row){if(attempts.size>=10000)return false;row={until:time+60000,count:0};attempts.set(ip,row);}
    return ++row.count<=60;
  }
  async function mapBounded(items, callback, signal) {
    const results=new Array(items.length);let index=0;
    await Promise.all(Array.from({length:Math.min(2,items.length)},async()=>{
      while(index<items.length){signal.throwIfAborted();const at=index++;results[at]=await callback(items[at],at);}
    }));return results;
  }
  // Ark grid gems: the expectation table priced with the shared gem catalogue. A throttled catalogue surfaces as 429.
  async function gemComponent(details,signal) {
    const cores=details.arkgrid?.cores;
    const equipped=Array.isArray(cores)?cores.flatMap(core=>Array.isArray(core.gems)?core.gems.map(gem=>({core,gem})):[]):null;
    const unknownCores=Array.isArray(cores)?cores.flatMap((core,index)=>Array.isArray(core.gems)?[]:[{
      id:`arkgrid-core-${index}`,name:core.name||'코어 젬',status:'unavailable',reason:'source_unavailable'}]):[];
    let arkgridGems=Array.isArray(equipped)?unknownCores.length?{status:'unavailable',items:unknownCores}:empty():missing('source_unavailable');
    const gemDetails=[];let currencyQuote=null;
    if(equipped?.length) {
      let catalogue;
      try{catalogue=await prices.gemCatalogue();}catch(error){if(error?.status===429)throw error;}
      try{currencyQuote=await currency.get();}catch{currencyQuote={status:'unavailable'};}
      const items=await mapBounded(equipped,async({core,gem},index)=>{
        const target=gem.target;
        const base={id:`arkgrid-gem-${index}`,name:gem.name||target?.name||'젬',targetKey:target?.targetKey};
        const display={...base,coreName:core.name,coreSlot:core.slot,slot:gem.slot,icon:gem.icon,points:gem.points??target?.points,target};
        const gradePrices=Object.fromEntries(['희귀','영웅'].map(grade=>[grade,catalogue?.prices?.[`${target?.subtype}:${grade}`]]));
        const purchaseGoldByGrade=Object.fromEntries(Object.entries(gradePrices).filter(([,price])=>price?.status==='ok'&&Number.isFinite(price.checkedAt)&&price.checkedAt<=now()&&now()-price.checkedAt<=900000).map(([grade,price])=>[grade,price.unitGold]));
        if(target?.status!=='ok'||!Object.keys(purchaseGoldByGrade).length){const failed={...base,status:'unavailable',reason:target?.status!=='ok'?'source_unavailable':'missing_quote'};gemDetails.push({...display,...failed});return failed;}
        const result=await gemSolver.getBest(target,{purchaseGoldByGrade,signal});signal.throwIfAborted();
        const costs=buildGemCostScenarios(result.alternatives||[],currencyQuote),general=costs.scenarios.general;
        const checkedAt=gradePrices[general.startingGrade]?.checkedAt;
        gemDetails.push({...display,...general,scenarios:costs.scenarios,alternatives:result.alternatives,checkedAt});
        return general.status==='ok'?{...base,status:'ok',modelVersion:result.modelVersion,expectedAcquisitionGold:general.totalExpectedGold,checkedAt}
          :{...base,status:'unavailable',reason:general.reason||result.reason||'calculation_unavailable'};
      },signal);
      items.push(...unknownCores);
      arkgridGems={status:items.every(item=>item.status==='ok')?'ok':'partial',items};
    }
    return {arkgridGems,gemDetails,currencyQuote,equipped,unknownCores};
  }
  // Equipped bracelet: the auction-based expectation or the saved best record for the same target. A throttled search surfaces as 429.
  async function braceletComponent(details,name,signal,{replacement=false}={}) {
    let bracelet=details.bracelet?missing('calculation_unavailable'):Array.isArray(details.equipment)?empty():missing('source_unavailable'),braceletDetails=null;
    if(details.bracelet) {
      try {
        const result=await braceletValue.get(name);signal.throwIfAborted();
        const recorded=braceletRecord(result,name,details.efficiency?.braceletExpectation?.targetKey,now());
        if(keyOf(result.characterName||'')===keyOf(name)&&['unavailable','no_listings'].includes(result.status)&&
            typeof result.reason==='string'&&result.reason.length<=2000&&
            (result.targetKey===details.efficiency?.braceletExpectation?.targetKey||result.targetKey===null&&details.efficiency?.braceletExpectation?.status==='unavailable')) {
          braceletDetails={...result,record:recorded};
          bracelet={status:'unavailable',items:[{id:'bracelet',name:details.bracelet.name||'장착 팔찌',status:'unavailable',reason:result.status==='no_listings'?'no_matching_listings':'calculation_unavailable'}]};
        }
        if(keyOf(result.characterName||'')===keyOf(name)&&typeof result.targetKey==='string'&&
            result.targetKey===details.efficiency?.braceletExpectation?.targetKey&&
            ['ok','unavailable','no_listings'].includes(result.status)&&
            result.reconversionTickets===(result.tier===3?0:3)&&result.totalRolls===(result.tier===3?4:7)&&
            (recorded||result.status==='ok'&&typeof result.costExpectedGold==='number'&&Number.isFinite(result.costExpectedGold)&&result.costExpectedGold>=0)) {
          braceletDetails={...result,record:recorded};
          bracelet={status:'ok',items:[{id:'bracelet',name:details.bracelet.name||'장착 팔찌',status:'ok',targetKey:result.targetKey,
            modelVersion:recorded?recorded.policyVersion:result.tier===3?'bracelet-t3-no-reconversion-v1':'bracelet-three-reconversion-v2',expectedAcquisitionGold:recorded?.costExpectedGold??result.costExpectedGold,
            // This timestamp validates reading the saved record against current equipment; its original date remains in braceletDetails.record.
            checkedAt:recorded?now():result.price?.checkedAt}]};
        }
      }catch(error){if(error?.status===429)throw error;}
    }
    // Nothing the conversion model can price — a fixed-effect raid bracelet, an unlisted tier 3 effect, or a search
    // that found no comparable listing — is replaced by what the same tier and grade actually costs.
    if(replacement&&details.bracelet&&bracelet.status!=='ok'&&typeof braceletValue.replacement==='function') {
      try {
        const result=await braceletValue.replacement({tier:details.bracelet.tier,grade:details.bracelet.grade,stats:braceletStats(details.bracelet)});
        signal.throwIfAborted();
        if(result?.status==='ok'&&Number.isFinite(result.meanGold)&&result.meanGold>0&&BRACELET_REPLACEMENT_BASIS.includes(result.basis)&&
            typeof result.targetKey==='string'&&typeof result.modelVersion==='string'&&Number.isSafeInteger(result.checkedAt)) {
          braceletDetails={...(braceletDetails||{}),replacement:result};
          bracelet={status:'ok',items:[{id:'bracelet',name:details.bracelet.name||'장착 팔찌',status:'ok',targetKey:result.targetKey,
            modelVersion:result.modelVersion,estimated:true,basis:result.basis,expectedAcquisitionGold:result.meanGold,checkedAt:result.checkedAt}]};
        }
      }catch(error){if(error?.status===429)throw error;}
    }
    return {bracelet,braceletDetails};
  }
  // Everything a valuation does once the equipment is in hand, so the same body serves a live lookup and a
  // replay of a stored snapshot. `observedAt` replaces the targets' own observation time for a replay:
  // calculateCharacterValuation refuses targets older than the quote window, and a record deliberately carries
  // equipment from an earlier day. The record keeps its own recordedAt, so nothing is lost by restamping here.
  async function evaluate(name, details, signal, {observedAt=null}={}) {
    const source=details?.valuationTargets;
    if(!source || keyOf(source.characterName||'')!==keyOf(name))throw failure();
    const cacheKey=`${keyOf(name)}:${source.targetKey}:${details.updatedAt}`;
    const previous=characters.get(cacheKey);if(previous?.until>now())return previous.data;
    const targets=observedAt===null?source:{...source,observedAt};
    const quotes={},costs={},requests=new Map();
    for(const quote of targets.quotes||[])requests.set(quote.quoteKey,quote);
    for(const target of targets.components?.honing?.items||[]) {
      if(target.status!=='ok')continue;
      const recipe=await honingRecipe(target);
      if(recipe?.status==='ok'){
        costs[target.targetKey]={...recipe,checkedAt:now()};
        for(const quote of recipe.quotes||[])requests.set(quote.quoteKey,quote);
      }
    }
    await mapBounded([...requests.values()],async quote=>{
      try{quotes[quote.quoteKey]=await prices.get(quote);}
      catch(error){if(error?.status===429)throw error;quotes[quote.quoteKey]={status:'unavailable',reason:'unavailable_price'};}
    },signal);
    signal.throwIfAborted();
    const {arkgridGems,gemDetails,currencyQuote,equipped,unknownCores}=await gemComponent(details,signal);
    const {bracelet,braceletDetails}=await braceletComponent(details,name,signal,{replacement:true});
    signal.throwIfAborted();if(closed)throw failure();
    const result=calculateCharacterValuation(targets,{quotes,costs,extraComponents:{bracelet,arkgridGems},now:now(),quoteMaxAgeMs:900000});
    for(const [category,component] of Object.entries(result.components||{})) {
      const originals=targets.components?.[category]?.items||({bracelet,arkgridGems}[category]?.items)||[];
      for(const item of component.items) {
        const source=originals.find(row=>row.id===item.id);
        item.name=source?.kind==='honing'?`+${source.refinement} ${source.itemName}`:
          source?.kind==='engraving'?`${source.name} · ${source.grade} Lv.${source.level}`:
          source?.name||source?.itemName||source?.slot||item.id;
        if(item.reason==='price_unavailable'&&['no_listings','no_matching_listings'].includes(quotes[source?.quoteKey]?.reason))
          item.reason=quotes[source.quoteKey].reason;
      }
    }
    const data={...result,characterName:name,gemDetails,gemValuation:{...gemTotals(gemDetails,Array.isArray(equipped)?unknownCores.length:1),currency:currencyQuote},braceletDetails,updatedAt:now(),equipmentUpdatedAt:details.updatedAt};
    // The inputs this valuation actually read, kept beside the result so the 원정대 최고 기록 store can save them
    // without the response carrying them. A character too large to snapshot simply has no entry.
    const inputs=snapshotValuationInputs(details);
    if(inputs)snapshots.set(data,inputs);
    characters.set(cacheKey,{until:now()+cacheMs,data});
    while(characters.size>128)characters.delete(characters.keys().next().value);
    return data;
  }
  async function calculate(name, signal) {
    const details=await readDetails(name);signal.throwIfAborted();
    return evaluate(name, details, signal);
  }
  // One physical calculation per key with a hard deadline; the slot stays taken until the late work actually exits.
  function bounded(map,key,cap,work) {
    if(map.has(key))return map.get(key);
    if(map.size>=cap)return Promise.reject(limited());
    const controller=new AbortController();controllers.add(controller);const {signal}=controller;
    let abort;const deadline=new Promise((_resolve,reject)=>{abort=()=>reject(failure());signal.addEventListener('abort',abort,{once:true});});
    const timer=setTimeout(()=>controller.abort(),operationTimeoutMs);
    const physical=Promise.resolve().then(()=>work(signal));
    const result=Promise.race([physical,deadline]).finally(()=>{clearTimeout(timer);controller.abort();signal.removeEventListener('abort',abort);controllers.delete(controller);});
    map.set(key,result);
    void physical.catch(()=>{}).finally(()=>{if(map.get(key)===result)map.delete(key);});
    return result;
  }
  function character(name){return bounded(inflight,keyOf(name),4,signal=>calculate(name,signal));}
  // One finished character valuation for the durable 원정대 환산 가치 store: the same physical calculation the
  // character page runs, so both share the four inflight slots, the five minute cache and the 120s deadline.
  async function value(name) {
    const target=normalizeCharacter(name);if(!target)throw new GuildError(400,'invalid_request');
    if(closed)throw failure();
    return structuredClone(await character(target));
  }
  // Today's price for equipment recorded earlier (원정대 최고 기록). It runs the same physical calculation under a
  // separate inflight key so a live lookup of the same character is never answered with the recorded equipment.
  // The bracelet expectation is fetched for the character as it is now, so a bracelet that has since changed
  // falls through to the replacement listing path instead of its own auction search.
  async function valueFrom(name, inputs) {
    const target=normalizeCharacter(name);if(!target)throw new GuildError(400,'invalid_request');
    if(closed)throw failure();
    if(!inputs || typeof inputs!=='object' || Array.isArray(inputs))throw failure();
    return structuredClone(await bounded(inflight,`${keyOf(target)}:record`,4,signal=>evaluate(target,inputs,signal,{observedAt:now()})));
  }
  // The bot's two rows (/팔찌 · /젬효율): bracelet and ark grid gem expectations only, computed side by side and without the
  // accessory, engraving and honing market quotes that make a full valuation wait on a cold price cache.
  const expectationCache=new Map(), expectationInflight=new Map();
  async function calculateExpectations(name,signal) {
    const details=await readDetails(name);signal.throwIfAborted();
    const targets=details?.valuationTargets;
    if(!targets || keyOf(targets.characterName||'')!==keyOf(name))throw failure();
    const cacheKey=`${keyOf(name)}:${targets.targetKey}:${details.updatedAt}`;
    const previous=expectationCache.get(cacheKey);if(previous?.until>now())return previous.data;
    let throttled=false;
    const limitedRow=(id,label)=>{throttled=true;return {status:'unavailable',items:[{id,name:label,status:'unavailable',reason:'rate_limited'}]};};
    const [gems,part]=await Promise.all([
      gemComponent(details,signal).catch(error=>{if(error?.status!==429)throw error;
        return {arkgridGems:limitedRow('arkgrid-gems','코어 젬'),gemDetails:[],currencyQuote:null,equipped:null,unknownCores:[]};}),
      braceletComponent(details,name,signal).catch(error=>{if(error?.status!==429)throw error;
        return {bracelet:limitedRow('bracelet',details.bracelet?.name||'장착 팔찌'),braceletDetails:null};})]);
    signal.throwIfAborted();if(closed)throw failure();
    const base={...targets,quotes:[],components:Object.fromEntries(categories.slice(0,4).map(id=>[id,empty()]))};
    const result=calculateCharacterValuation(base,{extraComponents:{bracelet:part.bracelet,arkgridGems:gems.arkgridGems},now:now(),quoteMaxAgeMs:900000});
    for(const [category,component] of Object.entries(result.components||{}))
      for(const item of component.items){const source=({bracelet:part.bracelet,arkgridGems:gems.arkgridGems}[category]?.items||[]).find(row=>row.id===item.id);item.name=source?.name||item.id;}
    const data={...result,scope:'expectations',characterName:name,gemDetails:gems.gemDetails,
      gemValuation:{...gemTotals(gems.gemDetails,Array.isArray(gems.equipped)?gems.unknownCores.length:1),currency:gems.currencyQuote},
      braceletDetails:part.braceletDetails,updatedAt:now(),equipmentUpdatedAt:details.updatedAt};
    // A throttled answer is returned once but never cached, so the next request retries the search.
    if(!throttled){expectationCache.set(cacheKey,{until:now()+cacheMs,data});while(expectationCache.size>128)expectationCache.delete(expectationCache.keys().next().value);}
    return data;
  }
  async function expectations(value) {
    const name=normalizeCharacter(value);if(!name)throw new GuildError(400,'invalid_request');
    if(closed)throw failure();
    const data=await bounded(expectationInflight,keyOf(name),2,signal=>calculateExpectations(name,signal));
    return {scope:'character',characterName:name,status:'done',progress:{done:1,total:1},
      characters:[{characterName:name,state:'done',value:structuredClone(data)}],updatedAt:now()};
  }
  async function get(value,scope='roster',{refresh=false}={}) {
    const name=normalizeCharacter(value);if(!name||!['roster','character'].includes(scope))throw new GuildError(400,'invalid_request');
    if(closed)throw failure();
    const key=`${scope}:${keyOf(name)}`;let job=jobs.get(key);
    if(job?.until<=now()&&!job?.pending||refresh&&!job?.pending&&!(job?.retryUntil>now())){jobs.delete(key);job=null;}
    if(!job) {
      if(jobs.size>=8){const oldest=[...jobs].find(([,row])=>!row.pending);if(!oldest)throw limited();jobs.delete(oldest[0]);}
      let roster;
      if(scope==='roster') {
        const data=await readRoster(name);if(closed)throw failure();roster=data?.roster?.characters;
        if(!Array.isArray(roster)||!roster.length||roster.length>100||!roster.some(row=>keyOf(row.characterName||'')===keyOf(name)))throw failure();
        try{onRoster(data.roster);}catch{}
      } else roster=[{characterName:name}];
      const names=new Set();
      if(roster.some(row=>!normalizeCharacter(row.characterName)||names.has(keyOf(row.characterName))||!names.add(keyOf(row.characterName))))throw failure();
      roster=[...roster].sort((a,b)=>(keyOf(a.characterName)===keyOf(name)?-1:keyOf(b.characterName)===keyOf(name)?1:0));
      // A concurrent poll may have initialized the same public roster while its lookup was pending.
      job=jobs.get(key);
      if(!job){
        if(jobs.size>=8){const oldest=[...jobs].find(([,row])=>!row.pending);if(!oldest)throw limited();jobs.delete(oldest[0]);}
        job={rows:roster.map(row=>({...row,state:'pending',value:null})),until:now()+cacheMs,pending:null};jobs.set(key,job);
      }
    }
    if(job.pending||job.rows.some(row=>row.state==='pending'))job.until=now()+cacheMs;
    if(!job.pending&&!(job.retryUntil>now())) {
      const next=job.rows.find(row=>row.state==='pending');
      if(next)job.pending=(async()=>{
        try{next.value=await character(next.characterName);if(!closed)next.state='done';try{onCharacterValue(next,snapshots.get(next.value)??null);}catch{}return 0;}
        catch(error){if(error?.status===429){job.retryUntil=now()+60000;return 60;}if(!closed){next.state='error';next.reason='character_unavailable';}return 0;}
      })().finally(()=>{job.pending=null;});
    }
    if(job.pending) {
      let pollTimer;
      // A response window ending must not cancel the shared calculation.
      try{await Promise.race([job.pending,new Promise(resolve=>{pollTimer=setTimeout(resolve,pollTimeoutMs);})]);}
      finally{clearTimeout(pollTimer);}
    }
    if(closed)throw failure();
    const retryAfterSeconds=job.retryUntil>now()?Math.ceil((job.retryUntil-now())/1000):0;
    const done=job.rows.filter(row=>row.state!=='pending').length;
    if(done===job.rows.length&&job.completedAt===undefined){job.completedAt=now();job.until=job.completedAt+cacheMs;}
    const aggregate=aggregateRosterValuations(job.rows.map(row=>row.value||{characterName:row.characterName,status:'unavailable',complete:false,totalGold:null}));
    aggregate.components=categoryTotals(job.rows,aggregate);
    return {scope,characterName:name,status:done===job.rows.length?'done':'running',progress:{done,total:job.rows.length},
      aggregate,gemValuation:rosterGemTotals(job.rows),characters:structuredClone(job.rows),updatedAt:now(),...(retryAfterSeconds?{retryAfterSeconds}:{})};
  }
  return {get,expectations,value,valueFrom,allow,close(){closed=true;for(const controller of controllers)controller.abort();gemSolver.close();jobs.clear();characters.clear();expectationCache.clear();attempts.clear();}};
}
