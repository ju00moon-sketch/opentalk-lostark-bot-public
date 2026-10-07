import { createHash } from 'node:crypto';
import { readBraceletExpectationInput } from './bracelet-expectation-input.js';
import { BRACELET_T4_DATA, BRACELET_T4_EFFECTS } from './bracelet-t4-data.js';
import { BRACELET_T3_DATA, BRACELET_T3_EFFECTS } from './bracelet-t3-data.js';
import { STAT_CODES, SPECIAL_EFFECTS, SPECIAL_MAX } from './bracelet-search.js';

const MODEL = '2026-09-16.5-tier-specific';
const MAX_PRICE = 1_000_000_000_000;
const compact = text => text.normalize('NFC').replace(/\s+/g, '');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const SPECIAL_NAMES = {
  'special.attackMoveSpeed': '공격 및 이동 속도 증가', 'special.seedDamage': '시드 이하 주는 피해 증가',
  'special.seedReduction': '시드 이하 받는 피해 감소', 'special.physicalDefense': '물리 방어력',
  'special.magicalDefense': '마법 방어력', 'special.maxHp': '최대 생명력',
  'special.hpRegen': '전투 중 생명력 회복량', 'special.resourceRegen': '전투 자원 회복량',
  'special.movementCooldown': '이동기 및 기상기 재사용 대기시간 감소', 'special.immunity': '피격 이상 면역 효과',
};
const unprocessedEvidence = '공식 가이드상 효과를 부여한 팔찌는 귀속되어 거래할 수 없으므로 정상 경매장 등록 매물을 미부여 팔찌로 판단합니다. 거래 가능 횟수는 변환 잔여 횟수가 아닙니다.';
const unavailable = reason => ({ status: 'unavailable', reason });
class BraceletPriceValidationError extends Error {}
function error(reason) { throw new BraceletPriceValidationError(reason); }
function fixedRule(target, rarity, checkAvailability, itemTier) {
  const effect = (itemTier===3?BRACELET_T3_EFFECTS:BRACELET_T4_EFFECTS).find(row => row.id === target.id);
  if (!effect?.fixedAllowed) error('fixed_option_unsupported');
  if (effect.ranges) {
    const hit = /^(힘|민첩|지능|체력|치명|특화|제압|신속|인내|숙련)\s*\+([\d,]+)$/.exec(target.text);
    const value = target.value, ranges = effect.ranges[rarity];
    if (!hit || !integer(value, ranges[0].min, ranges.at(-1).max)) error('fixed_value_invalid');
    const name = hit[1], base = ['힘','민첩','지능'].includes(name), vitality = name === '체력';
    const apiName = base ? '힘 / 민첩 / 지능' : name;
    const floor = ranges[0].min, ceiling = ranges.at(-1).max;
    const tolerance = effect.category === 'combat' ? Math.min(5,ceiling-value) : 0;
    return { id: target.id, name, apiName, first: base || vitality ? 1 : 2,
      second: base ? 11 : vitality ? 6 : STAT_CODES[name], min: Math.max(floor,value-tolerance), max: value+tolerance,
      operator: tolerance ? 'range' : '=', value, tolerance, allowedRange: [floor,ceiling], percentage: false, types: ['STAT'] };
  }
  if(itemTier===3)error('fixed_option_unsupported');
  // An exact 6% movement/attack-speed search returned ABILITY_ENGRAVE Value=5
  // with IsValuePercentage=false. Those values do not establish the real effect
  // strength; do not invent a scale or substitute an effect ID for its amount.
  const name = SPECIAL_NAMES[target.id], api = SPECIAL_EFFECTS.find(row => row.name === name);
  const tier = effect.tiers[rarity].find(row => row.tier === target.tier);
  if (!api || !tier || tier.values.length !== 1) error('fixed_option_unsupported');
  const value = tier.values[0];
  if (!['special.physicalDefense','special.magicalDefense','special.maxHp','special.hpRegen'].includes(target.id)) {
    if (!checkAvailability) error('fixed_special_value_unverified');
    // Some official options return an opaque value (including zero), and their
    // numeric search bounds are ignored. This superset can prove absence only.
    return {id:target.id,name,apiName:name,first:5,second:api.code,min:0,max:SPECIAL_MAX,
      operator:'presence',value,tolerance:0,unverifiedSpecial:true,percentage:null,
      types:['BRACELET_SPECIAL_EFFECTS','ABILITY_ENGRAVE']};
  }
  return { id: target.id, name, apiName: name, first: 5, second: api.code, min: value,
    max: value, operator: '=', value, tolerance: 0, allowedValues: effect.tiers[rarity].map(row=>row.values[0]),
    percentage: false, types: ['BRACELET_SPECIAL_EFFECTS'] };
}

const RELAXATIONS = ['none', 'stats-only', 'stats-only-main-any'];
const searchRule = rule => rule.id.startsWith('combat.') || rule.id === 'base.mainStat';
// Core options: a relaxed search must not price a bracelet by listings that carry a
// different combat stat or a main stat in the slot the search left open.
const CORE_OPTION_NAMES = new Set(['치명','특화','신속','제압','인내','숙련','힘','민첩','지능',compact('힘 / 민첩 / 지능')]);
const CORE_MISMATCH = Symbol('core-mismatch');
/** One search stage: 'none' keeps every fixed option, the relaxed stages keep combat stats and the main stat only. */
function assembleStage(context, relaxation) {
  const {itemTier, grade, fixedCount, grantedCount, rules: all} = context;
  const rules = relaxation === 'none' ? all : all.filter(searchRule).map(rule => relaxation === 'stats-only-main-any' && rule.id === 'base.mainStat'
    ? {...rule, min: rule.allowedRange[0], max: rule.allowedRange[1], operator: 'any', tolerance: 0} : rule);
  const conditions = all.map(rule => {
    const used = rules.find(row => row.id === rule.id);
    return used ? {name: used.name, operator: used.operator, value: used.value, min: used.min, max: used.max, tolerance: used.tolerance, used: true}
      : {name: rule.name, operator: 'any', value: rule.value, min: null, max: null, tolerance: 0, used: false};
  });
  const EtcOptions = rules.map(row => ({FirstOption:row.first,SecondOption:row.second,MinValue:row.min,MaxValue:row.max}));
  EtcOptions.push({FirstOption:4,SecondOption:1,MinValue:fixedCount,MaxValue:fixedCount}, {FirstOption:4,SecondOption:2,MinValue:grantedCount,MaxValue:grantedCount});
  const body = {ItemLevelMin:0,ItemLevelMax:0,ItemGradeQuality:null,EtcOptions,Sort:'BUY_PRICE',CategoryCode:200040,CharacterClass:'',ItemTier:itemTier,ItemGrade:grade,ItemName:'',PageNo:1,SortCondition:'ASC'};
  const fingerprint = createHash('sha256').update(JSON.stringify({version:MODEL,body,rules})).digest('hex');
  return {status:'ok',tier:itemTier,grade,fixedCount,grantedCount,relaxation,conditions,rules,body,fingerprint,
    ...(rules.some(rule=>rule.unverifiedSpecial) ? {availabilityOnly:true} : {})};
}

/** Compare bounded combat values; keep other fixed values and empty slot counts exact. */
export function buildBaseBraceletSearch(expectation, {checkAvailability = false} = {}) {
  try { return assembleStage(prepareSearch(expectation, checkAvailability === true), 'none'); }
  catch (err) { return unavailable(err instanceof BraceletPriceValidationError ? err.message : 'expectation_invalid'); }
}

/**
 * Ordered search stages: the exact search first, then (only when a combat stat or the
 * main stat is fixed) combat stats plus the exact main stat, then combat stats with any
 * main-stat value.
 * Stages with identical fingerprints collapse; an availability-only exact stage is
 * skipped when a relaxed stage can price the bracelet without the special effect.
 */
export function buildBaseBraceletSearchPlan(expectation, {checkAvailability = false} = {}) {
  try {
    const context = prepareSearch(expectation, checkAvailability === true);
    const candidates = context.rules.some(searchRule) ? RELAXATIONS : RELAXATIONS.slice(0, 1);
    const stages = [], seen = new Set();
    for (const relaxation of candidates) {
      const stage = assembleStage(context, relaxation);
      if (seen.has(stage.fingerprint)) continue;
      seen.add(stage.fingerprint); stages.push(stage);
    }
    return {status:'ok', stages: stages.length > 1 && stages[0].availabilityOnly === true ? stages.slice(1) : stages};
  } catch (err) { return unavailable(err instanceof BraceletPriceValidationError ? err.message : 'expectation_invalid'); }
}

function prepareSearch(expectation, checkAvailability) {
  const e = expectation;
  if (!object(e) || e.status !== 'ok' || !['ancient','relic'].includes(e.rarity) || !Array.isArray(e.target) || e.target.length < 2 || e.target.length > 5) error('expectation_invalid');
  const itemTier=e.tier===undefined?4:e.tier;
  if(![3,4].includes(itemTier))error('expectation_invalid');
  const data=itemTier===3?BRACELET_T3_DATA:BRACELET_T4_DATA;
  if (e.target.some(row => !object(row) || typeof row.id !== 'string' || typeof row.fixed !== 'boolean' || typeof row.text !== 'string' || !row.text || row.text.length > 1000 || /[<>&]/.test(row.text))) error('target_invalid');
  const grade = e.rarity === 'ancient' ? '고대' : '유물';
  // Reuse the complete-statement parser instead of trusting client-supplied IDs.
  const html = e.target.map(row => {
    let text=row.text;
    if(itemTier===3&&row.id?.startsWith('special.')){
      if(typeof row.labelColor!=='string'||!/^#[0-9A-F]{6}$/.test(row.labelColor))error('target_invalid');
      text=text.replace(/^\[([^\]]+)\]/,`[<FONT COLOR='${row.labelColor}'>$1</FONT>]`);
    }
    return `<img src='emoticon_tooltip_bracelet_${row.fixed ? 'locked' : 'changeable'}'></img>${text}`;
  }).join('<br>');
  const reread = readBraceletExpectationInput({ Type: '팔찌', Grade: grade, Tooltip: JSON.stringify({
    title: { type: 'ItemTitle', value: { leftStr2: `아이템 티어 ${itemTier}` } },
    effects: { type: 'ItemPartBox', value: { Element_000: '팔찌 효과', Element_001: html } },
  }) });
  if (reread.status !== 'ok' || reread.target.length !== e.target.length || reread.target.some((row,i) => row.id !== e.target[i].id || row.value !== e.target[i].value || row.tier !== e.target[i].tier)) error('target_mismatch');
  const fixed = e.target.filter(row => row.fixed), grantedCount = e.target.length - fixed.length;
  if (![1,2].includes(fixed.length) || !data.grantedCounts[e.rarity].some(row => row.count === grantedCount)
    || (e.fixedCount !== undefined && e.fixedCount !== fixed.length) || (e.grantedCount !== undefined && e.grantedCount !== grantedCount)) error('slot_count_invalid');
  const rules = fixed.map(row => fixedRule(row,e.rarity,checkAvailability,itemTier)).sort((a,b) => a.first-b.first || a.second-b.second);
  if (new Set(rules.map(row => `${row.first}:${row.second}`)).size !== rules.length) error('fixed_duplicate');
  return {itemTier, grade, fixedCount: fixed.length, grantedCount, rules};
}
export function parseBraceletEndDate(text) {
  if (typeof text !== 'string' || text.length > 40) return null;
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?(Z|[+-]\d\d:\d\d)?$/.exec(text);
  if (!m) return null;
  const [,y,month,day,hour,minute,second] = m;
  const wall=Date.UTC(+y,+month-1,+day,+hour,+minute,+second);
  const check=new Date(wall);
  if (check.getUTCFullYear()!==+y || check.getUTCMonth()!==+month-1 || check.getUTCDate()!==+day || check.getUTCHours()!==+hour || check.getUTCMinutes()!==+minute || check.getUTCSeconds()!==+second) return null;
  const result=Date.parse(text+(m[8] ? '' : '+09:00')); return Number.isFinite(result) ? result : null;
}
function normalizeItem(item, search, now) {
  if (!object(item) || item.Tier !== search.tier || item.Grade !== search.grade || typeof item.Name !== 'string' || !item.Name.includes('팔찌') || item.Name.length > 120) error('filter_mismatch');
  if (!Array.isArray(item.Options) || item.Options.length > 12 || !object(item.AuctionInfo)) error('auction_shape_invalid');
  const info=item.AuctionInfo;
  // The live API reports 0 for ordinary bracelet offers. It is not a roll count.
  if (!integer(info.TradeAllowCount,0,1)) error('trade_state_unknown');
  if ('IsCompetitive' in info && typeof info.IsCompetitive !== 'boolean') error('trade_state_unknown');
  const fixed=[],seen=new Set(); let random=null,explicitFixed=null,ark=null;
  for (const option of item.Options) {
    if (!object(option) || typeof option.OptionName !== 'string' || option.OptionName.length > 150 || typeof option.Value !== 'number' || !Number.isFinite(option.Value) || option.Value < 0 || option.Value > SPECIAL_MAX) error('auction_option_invalid');
    if ('IsPenalty' in option && option.IsPenalty !== false) error('auction_option_invalid');
    if (option.Type === 'BRACELET_RANDOM_SLOT') { if(random!==null) error('auction_option_duplicate'); random=option.Value; }
    else if (option.Type === 'BRACELET_FIXED_SLOT') { if(explicitFixed!==null) error('auction_option_duplicate'); explicitFixed=option.Value; }
    else if (option.Type === 'ARK_PASSIVE') { if(ark!==null || option.OptionName!=='도약') error('auction_option_invalid'); ark=option.Value; }
    else if (['STAT','BRACELET_SPECIAL_EFFECTS','ABILITY_ENGRAVE'].includes(option.Type)) {
      const name=compact(option.OptionName);if(seen.has(name)) error('auction_option_duplicate');seen.add(name);fixed.push(option);
    } else error('auction_option_unknown');
  }
  if (random!==search.grantedCount || fixed.length!==search.fixedCount || (explicitFixed!==null && explicitFixed!==search.fixedCount)) error('filter_mismatch');
  const matches=new Set();
  for(const rule of search.rules) {
    const found=fixed.filter(option => rule.types.includes(option.Type) && (compact(option.OptionName)===compact(rule.name)
      // Official main-stat offers use this combined label (First1/Second11).
      || (rule.id==='base.mainStat' && compact(option.OptionName)===compact('힘 / 민첩 / 지능'))));
    if(found.length!==1 || matches.has(found[0]) || found[0].Value<rule.min || found[0].Value>rule.max) error('filter_mismatch');matches.add(found[0]);
    if(found[0].IsValuePercentage!==rule.percentage || (found[0].Type==='STAT' && !Number.isSafeInteger(found[0].Value))) error('auction_unit_invalid');
    if ((rule.allowedRange && (found[0].Value<rule.allowedRange[0] || found[0].Value>rule.allowedRange[1])) || (rule.allowedValues && !rule.allowedValues.includes(found[0].Value))) error('auction_value_unknown');
  }
  // Slots a relaxed stage left open may hold vitality or a special effect, not another core option.
  if (fixed.some(option => !matches.has(option) && option.Type==='STAT' && CORE_OPTION_NAMES.has(compact(option.OptionName)))) return CORE_MISMATCH;
  const ends=parseBraceletEndDate(info.EndDate); if(ends===null) error('auction_end_invalid');
  const price=info.BuyPrice;
  if (price!==null && !integer(price,0,MAX_PRICE)) error('auction_price_invalid');
  if (price===null || price===0 || ends<=now) return null;
  return {price,name:item.Name,tier:item.Tier,grade:item.Grade,endsAt:info.EndDate,tradeAllowCount:info.TradeAllowCount,
    options:fixed.map(option=>({name:option.OptionName,value:option.Value})),grantedCount:random};
}

/** Fail closed on API filter/schema changes; non-purchasable listings are excluded. */
export function normalizeBaseBraceletAuction(response, search, {now=Date.now(),requestedPageNo=search?.body?.PageNo}={}) {
  const result={status:'unavailable',samples:[],totalCount:0,pageNo:requestedPageNo,pageSize:10,checkedCount:0,excludedCount:0,coreMismatchCount:0,
    tier:search?.tier,grade:search?.grade,conditions:search?.conditions??[],unprocessedEvidence};
  try {
    if (search?.status!=='ok' || !Array.isArray(search.rules) || !Number.isFinite(now) || !integer(requestedPageNo,1,1000000)) error('search_invalid');
    if (!object(response) || response.PageNo!==requestedPageNo || response.PageSize!==10 || !integer(response.TotalCount,0,10000000)) error('auction_response_invalid');
    const items=response.Items===null && response.TotalCount===0 ? [] : response.Items;
    if(!Array.isArray(items) || items.length!==Math.min(10,Math.max(0,response.TotalCount-(requestedPageNo-1)*10))) error('auction_response_invalid');
    result.totalCount=response.TotalCount;
    if (!items.length) { if(response.TotalCount!==0 || requestedPageNo!==1) error('auction_response_invalid'); return {...result,status:'no_listings'}; }
    if (search.availabilityOnly === true) error('fixed_special_value_unverified');
    if ((requestedPageNo-1)*10>=response.TotalCount) error('auction_response_invalid');
    const samples=[];let excluded=0,coreMismatch=0,last=0;
    for(const item of items) {const sample=normalizeItem(item,search,now);if(sample===CORE_MISMATCH){coreMismatch++;continue;}if(!sample){excluded++;continue;}if(sample.price<last)error('auction_sort_invalid');last=sample.price;samples.push(sample);}
    return {...result,status:'ok',samples,checkedCount:items.length,excludedCount:excluded,coreMismatchCount:coreMismatch};
  } catch(err) {return {...result,reason:err instanceof BraceletPriceValidationError ? err.message : 'auction_response_invalid'};}
}

/** Equal-weight actual listing samples; no deduplication of equal legitimate prices. */
export function estimateBaseBraceletPrice(samples) {
  const result={status:'unavailable',price:null,used:0,excluded:0,sampleCount:0,stddevLog:null,lowSample:true,spread:null};
  if(!Array.isArray(samples)||samples.length>50||samples.some(sample=>!object(sample)||!integer(sample.price,1,MAX_PRICE))) return {...result,reason:'price_samples_invalid'};
  if(!samples.length)return {...result,status:'no_listings'};
  const values=samples.map(sample=>sample.price),logs=values.map(Math.log),count=logs.length,mean=logs.reduce((sum,x)=>sum+x,0)/count;
  const variance=count>1?logs.reduce((sum,x)=>sum+(x-mean)**2,0)/(count-1):null;
  const sd=variance===null?null:values.every(value=>value===values[0])?0:Math.sqrt(variance);
  const selected=values.filter((value,i)=>sd===null||Math.abs(logs[i]-mean)<=2*sd+1e-12);
  if(!selected.length)return {...result,reason:'price_samples_invalid'};
  return {status:'ok',price:selected.reduce((sum,x)=>sum+x,0)/selected.length,used:selected.length,excluded:count-selected.length,sampleCount:count,stddevLog:sd,lowSample:selected.length<10,spread:{min:Math.min(...selected),max:Math.max(...selected)}};
}
