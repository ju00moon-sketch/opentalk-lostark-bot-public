import { createHash } from 'node:crypto';
import { classifyRefinementOption } from './refinement-options.js';
import { isAbilityStoneReduction } from './official-input-forms.js';
import { OPTIONS, GRADE_INDEX } from './data/refine.js';

const VERSION = 'roster-targets-v1';
const COMPONENTS = ['gems', 'accessories', 'engravings', 'honing'];
const ARMOR = new Set(['무기', '투구', '상의', '하의', '장갑', '어깨', '완갑']);
const ACCESSORIES = { 목걸이: 200010, 귀걸이: 200020, 반지: 200030 };
const BOOK_GRADES = ['전설', '유물'];
// 조율된 광휘 보석이 복원되면 돌아가는 보석 두 가지. 어느 쪽이었는지는 관측되지 않아 싼 쪽을 쓴다.
const TUNED_ORIGINS = ['겁화', '작열'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
const own = (object, key) => typeof key === 'string' && Object.hasOwn(object, key);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = reason => { throw Object.assign(new Error(reason), { reason }); };
const requireValue = (condition, reason) => { if (!condition) fail(reason); };
const unavailable = reason => ({ status: 'unavailable', reason, items: [] });

function plain(value) {
  requireValue(typeof value === 'string' && value.length <= 16384 && value.isWellFormed(), 'invalid_text');
  const text = value.replace(/<br\s*\/?>|<\/(?:p|div)>/gi, '\n').replace(/<\/?(?:font|b|i|u|span|p|div|img)(?:\s+[^<>]*)?\s*>/gi, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&');
  requireValue(!/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u.test(text), 'invalid_text');
  return text.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\t ]+/g, ' ').trim();
}
function uniqueKeys(raw) {
  let index = 0, nodes = 0;
  const whitespace = () => { while (/[\t\r\n ]/.test(raw[index] ?? '\0')) index++; };
  function string() {
    const start = index++;
    while (index < raw.length) {
      if (raw[index] === '\\') index += 2;
      else if (raw[index++] === '"') return JSON.parse(raw.slice(start, index));
    }
    fail('invalid_tooltip');
  }
  function value(depth = 0) {
    requireValue(depth <= 32 && ++nodes <= 4096, 'invalid_tooltip'); whitespace();
    if (raw[index] === '"') { string(); return; }
    if (raw[index] === '{') {
      index++; whitespace(); const keys = new Set();
      if (raw[index] === '}') { index++; return; }
      while (index < raw.length) {
        whitespace(); const key = string(); requireValue(!keys.has(key), 'ambiguous_tooltip'); keys.add(key);
        whitespace(); index++; value(depth + 1); whitespace(); if (raw[index++] === '}') return;
      }
    } else if (raw[index] === '[') {
      index++; whitespace(); if (raw[index] === ']') { index++; return; }
      while (index < raw.length) { value(depth + 1); whitespace(); if (raw[index++] === ']') return; }
    } else { while (index < raw.length && !/[\t\r\n ,}\]]/.test(raw[index])) index++; return; }
    fail('invalid_tooltip');
  }
  value(); whitespace(); requireValue(index === raw.length, 'invalid_tooltip');
}
function tooltip(raw) {
  requireValue(typeof raw === 'string' && raw.length <= 131072, 'invalid_tooltip');
  let parsed; try { parsed = JSON.parse(raw); } catch { fail('invalid_tooltip'); }
  requireValue(record(parsed), 'invalid_tooltip'); uniqueKeys(raw);
  return Object.values(parsed).filter(value => value !== null);
}
function one(values, reason = 'ambiguous_tooltip') { requireValue(values.length === 1, reason); return values[0]; }
function identity(raw) {
  requireValue(record(raw), 'invalid_item');
  const name = plain(raw.Name); requireValue(name.length > 0 && name.length <= 180, 'invalid_item_name');
  const tip = tooltip(raw.Tooltip);
  requireValue(one(tip.filter(x => x?.type === 'NameTagBox').map(x => plain(x.value))) === name, 'inconsistent_item_name');
  const title = one(tip.filter(x => x?.type === 'ItemTitle').map(x => x.value)); requireValue(record(title), 'invalid_item_title');
  const label = plain(title.leftStr2);
  const tierMatch = /^(?:아이템\s*레벨\s*(\d+|\d{1,3}(?:,\d{3})+)\s*\(티어\s*(\d+)\)|아이템\s*티어\s*(\d+))$/.exec(label);
  requireValue(tierMatch && integer(Number(tierMatch[2] ?? tierMatch[3]), 1, 4), 'invalid_item_tier');
  const itemLevel = tierMatch[1] ? Number(tierMatch[1].replaceAll(',', '')) : null;
  requireValue(itemLevel === null || integer(itemLevel, 1, 3000), 'invalid_item_level');
  return { name, tip, tier: Number(tierMatch[2] ?? tierMatch[3]), itemLevel, quality: title.qualityValue };
}
function auction(body) {
  const query = { Sort: 'BUY_PRICE', SortCondition: 'ASC', PageNo: 1, ItemLevelMin: 0, ItemLevelMax: 0,
    CategoryCode: body.CategoryCode, ItemTier: body.ItemTier, ItemGrade: body.ItemGrade ?? null,
    ItemGradeQuality: body.ItemGradeQuality ?? null, ItemName: body.ItemName ?? '', EtcOptions: body.EtcOptions ?? [], SkillOptions: [] };
  return { quoteKey: `auction:${hash(query)}`, kind: 'auction', body: query };
}
function gemTarget(raw, id) {
  const { name, tip, tier } = identity(raw);
  requireValue(integer(raw.Slot, 0, 10) && integer(raw.Level, 1, 10), 'invalid_gem_slot_or_level');
  requireValue(typeof raw.Grade === 'string' && ['일반', '고급', '희귀', '영웅', '전설', '유물', '고대'].includes(raw.Grade), 'invalid_gem_grade');
  const match = /^(10|[1-9])레벨 (겁화|작열|멸화|홍염|광휘)의 보석(?: \(귀속\))?$/.exec(name);
  requireValue(match && Number(match[1]) === raw.Level, 'inconsistent_gem_identity');
  const trade = one(tip.filter(x => x?.type === 'MultiTextBox').map(x => plain(x.value)).filter(x => /거래/.test(x)), 'trade_status_unobserved');
  requireValue(/^\|?거래\s*(?:가능|불가)$/.test(trade), 'ambiguous_trade_status');
  const bound = /불가/.test(trade), labelledBound = /\(귀속\)$/.test(name);
  requireValue(!labelledBound || bound, 'inconsistent_trade_status');
  // 겁화·작열 보석을 조율하면 거래가 막힌 광휘의 보석이 되지만, 보석 전문가에게 복원하면 조율 전 보석으로 돌아온다
  // (공식 안내 2025-05-28, 조율 15일 뒤 복원 가능). 그래서 값이 0인 것은 이름에 (귀속)이 붙어 복원·합성이 막힌
  // 이벤트 보석뿐이고, 조율된 광휘 보석은 같은 레벨 겁화·작열 매물 중 싼 쪽 시세로 값을 매긴다(사용자 결정 2026-09-19).
  const tuned = match[2] === '광휘' && !labelledBound;
  requireValue(labelledBound || tuned || (tier === 4 && ['겁화', '작열'].includes(match[2])) || (tier === 3 && ['멸화', '홍염'].includes(match[2])), 'unsupported_gem_type');
  const fields = { kind: 'gem', tier, type: match[2], grade: raw.Grade, level: raw.Level, bound };
  const listing = (type) => auction({ CategoryCode: 210000, ItemTier: tier, ItemGrade: raw.Grade, ItemName: `${raw.Level}레벨 ${type}의 보석` });
  const quotes = labelledBound ? [] : tuned ? TUNED_ORIGINS.map(listing) : [listing(match[2])];
  return { item: { id, status: 'ok', targetKey: hash(fields), ...fields, slot: raw.Slot, name,
    ...(labelledBound ? { zeroReason: 'bound_gem' }
      : tuned ? { substituteQuoteKeys: quotes.map(x => x.quoteKey), substituteBasis: 'tuned_gem_restore' }
        : { quoteKey: quotes[0].quoteKey }), matchBasis: 'type_level_tier_skill_independent' }, quotes };
}
function accessoryTarget(raw, id) {
  const { name, tip, tier, quality } = identity(raw);
  requireValue(tier === 4 && ['유물', '고대'].includes(raw.Grade) && integer(quality, 0, 100), 'unsupported_accessory');
  const effects = one(tip.filter(x => x?.type === 'ItemPartBox' && record(x.value) && plain(x.value.Element_000) === '연마 효과'), 'refinement_unobserved');
  const lines = plain(effects.value.Element_001).split('\n').map(x => x.trim()).filter(Boolean);
  requireValue(lines.length >= 1 && lines.length <= 3, 'invalid_refinement_count');
  const options = lines.map(text => classifyRefinementOption(raw.Type, text));
  requireValue(options.every(x => x?.shortName && x.grade), 'unsupported_refinement_option');
  requireValue(new Set(options.map(x => x.shortName)).size === options.length, 'duplicate_refinement_option');
  const majorOptions = options.filter(x => x.optionCode >= 41 && x.optionCode <= 52).map(x => ({
    FirstOption: 7, SecondOption: x.optionCode, MinValue: OPTIONS[x.optionCode].values[GRADE_INDEX[x.grade]],
    MaxValue: OPTIONS[x.optionCode].values[GRADE_INDEX[x.grade]],
  })).sort((a, b) => a.SecondOption - b.SecondOption);
  const quote = auction({ CategoryCode: ACCESSORIES[raw.Type], ItemTier: tier, ItemGrade: raw.Grade,
    ItemGradeQuality: quality, EtcOptions: majorOptions });
  const fields = { kind: 'accessory', type: raw.Type, tier, grade: raw.Grade, quality, majorOptions };
  return { item: { id, status: 'ok', targetKey: hash(fields), ...fields, name, options,
    quoteKey: quote.quoteKey, matchBasis: 'major_options_exact_quality_at_least' }, quotes: [quote] };
}
function honingTarget(raw, id) {
  const { name, tip, tier, itemLevel } = identity(raw);
  // A vambrace that was never honed carries no "+N" prefix in its name ("운명의 전율 완갑"): that is stage 0,
  // observed. Weapons and armor always carry the prefix, so a bare name there is still unobserved (2026-09-19).
  const match = /^\+(\d+) (.+)$/.exec(name) ?? (raw.Type === '완갑' && !name.startsWith('+') ? [name, '0', name] : null);
  requireValue(match && integer(Number(match[1]), 0, 25) && (itemLevel !== null || raw.Type === '완갑'), 'honing_level_unobserved');
  // From stage 30 the official tooltip appends milestone lines ("30단계 - 기본 효과 +2%") after the
  // stage line, so the stage is read per line and the milestones are ignored.
  const labels = tip.filter(x => x?.type === 'SingleTextBox').flatMap(x => plain(x.value).split('\n'))
    .map(x => x.trim()).filter(x => /상급\s*재련/.test(x));
  let advancedRefinement = null;
  if (labels.length) {
    const advanced = /^\[상급 재련\] (\d+)단계$/.exec(one(labels, 'ambiguous_advanced_honing'));
    requireValue(advanced && integer(Number(advanced[1]), 0, 40), 'ambiguous_advanced_honing'); advancedRefinement = Number(advanced[1]);
  }
  const fields = { kind: 'honing', slot: raw.Type, tier, grade: raw.Grade, itemName: match[2], itemLevel,
    refinement: Number(match[1]), advancedRefinement };
  const grades = raw.Type === '완갑' ? ['일반', '고급', '희귀', '영웅', '전설', '유물', '고대'] : ['유물', '고대', '에스더'];
  requireValue(typeof raw.Grade === 'string' && grades.includes(raw.Grade), 'unsupported_honing_grade');
  return { item: { id, status: 'ok', targetKey: hash(fields), ...fields,
    advancedRefinementStatus: advancedRefinement === null ? 'unobserved' : 'observed' }, quotes: [] };
}
function engravingTarget(raw, id, serverName) {
  requireValue(record(raw) && typeof raw.Name === 'string' && /^[가-힣A-Za-z0-9 ·]{1,50}$/.test(raw.Name)
    && BOOK_GRADES.includes(raw.Grade) && integer(raw.Level, 0, 4), 'unsupported_engraving');
  const name = raw.Name.normalize('NFC').trim(); requireValue(name, 'unsupported_engraving');
  // Current official guide: each grade has four levels of five books; relic
  // requires all twenty legendary books. Unfinished reading is not observable.
  // https://lostark.game.onstove.com/GameGuide/Pages/각인
  const quotes = BOOK_GRADES.slice(0, BOOK_GRADES.indexOf(raw.Grade) + 1).map(grade => {
    const query = { kind: 'market', category: 40000, name: `${name} 각인서`, grade };
    return { quoteKey: `market:${hash(query)}`, ...query };
  });
  const fields = { kind: 'engraving', name, grade: raw.Grade, level: raw.Level };
  return { item: { id, status: 'ok', targetKey: hash(fields), ...fields, accountKey: `engraving:${serverName}:${name}`,
    coverage: 'equipped_only', progressCoverage: 'completed_levels_only', recipeVersion: 'official-engraving-2026-09-16',
    bookQuotes: quotes.map(x => ({ grade: x.grade, quoteKey: x.quoteKey, quantity: x.grade === raw.Grade ? raw.Level * 5 : 20 })) }, quotes };
}
function section(rows, prefix, parse, identityOf, maximum, quotes) {
  if (!Array.isArray(rows) || rows.length > maximum) return unavailable(`invalid_${prefix}_section`);
  if (!rows.length) return { status: 'empty', items: [] };
  const keys = rows.map(identityOf);
  if (keys.some(x => x === null || x === undefined) || new Set(keys).size !== keys.length) return unavailable(`duplicate_or_invalid_${prefix}_identity`);
  const items = rows.map((row, index) => {
    const id = `${prefix}:${keys[index]}`;
    try { const result = parse(row, id); result.quotes.forEach(quote => quotes.set(quote.quoteKey, quote)); return result.item; }
    catch (error) { return { id, status: 'unavailable', reason: error.reason || `invalid_${prefix}_item` }; }
  });
  return { status: items.every(x => x.status === 'ok') ? 'ok' : items.some(x => x.status === 'ok') ? 'partial' : 'unavailable', items };
}

// Raw armory input is necessary: display DTOs intentionally omit trade labels.
export function parseRosterValuationTargets(raw, { observedAt = Date.now() } = {}) {
  try {
    const characterName = raw?.ArmoryProfile?.CharacterName;
    const serverName = raw?.ArmoryProfile?.ServerName;
    requireValue(typeof characterName === 'string' && /^[가-힣A-Za-z0-9]{2,12}$/.test(characterName)
      && typeof serverName === 'string' && /^[가-힣A-Za-z0-9]{1,30}$/.test(serverName)
      && integer(observedAt, 0, Number.MAX_SAFE_INTEGER), 'invalid_profile_identity');
    const quotes = new Map();
    // The official API reports a character with no ordinary gem as `Gems: null` alongside an empty effect
    // list: an observed empty section, not a missing one (2026-09-19). Any other non-array stays unresolved.
    const gemRows = raw.ArmoryGem?.Gems === null && Array.isArray(raw.ArmoryGem?.Effects?.Skills) && raw.ArmoryGem.Effects.Skills.length === 0 ? [] : raw.ArmoryGem?.Gems;
    const gems = section(gemRows, 'gem', gemTarget, x => integer(x?.Slot, 0, 10) ? x.Slot : null, 11, quotes);
    const equip = raw.ArmoryEquipment;
    const validEquip = Array.isArray(equip) && equip.length <= 32 && equip.every(x => record(x) && typeof x.Type === 'string');
    const accessories = validEquip ? equip.filter(x => own(ACCESSORIES, x.Type)) : null;
    const counts = new Map();
    const accessoryKeys = validEquip ? accessories.map(x => { const count = (counts.get(x.Type) || 0) + 1; counts.set(x.Type, count); return `${x.Type}:${count}`; }) : [];
    const invalidSlots = [...counts].some(([type, count]) => count > (type === '목걸이' ? 1 : 2));
    const components = { gems,
      accessories: invalidSlots ? unavailable('duplicate_accessory_slot') : section(accessories, 'accessory', accessoryTarget, (_x, i) => accessoryKeys[i], 5, quotes),
      // The ability stone's reduction line rides in the same list; it is not a book, so it never becomes a target.
      engravings: section(Array.isArray(raw.ArmoryEngraving?.ArkPassiveEffects) ? raw.ArmoryEngraving.ArkPassiveEffects.filter(row => !isAbilityStoneReduction(row)) : raw.ArmoryEngraving?.ArkPassiveEffects,
        'engraving', (row, id) => engravingTarget(row, id, serverName), x => typeof x?.Name === 'string' ? x.Name.normalize('NFC').trim() : null, 5, quotes),
      honing: section(validEquip ? equip.filter(x => ARMOR.has(x.Type)) : null, 'honing', honingTarget, x => x?.Type, 7, quotes) };
    const fields = Object.fromEntries(COMPONENTS.map(key => [key, components[key].items.map(x => ({ id: x.id, targetKey: x.targetKey ?? null, status: x.status }))]));
    return { version: VERSION, status: Object.values(components).every(x => ['ok', 'empty'].includes(x.status)) ? 'ok' : 'partial',
      characterName, serverName, observedAt, targetKey: hash({ characterName, serverName, ...fields }), components, quotes: [...quotes.values()] };
  } catch { return { version: VERSION, status: 'unavailable', reason: 'invalid_profile_or_payload', characterName: null, observedAt: null,
    serverName: null, targetKey: null, components: Object.fromEntries(COMPONENTS.map(id => [id, unavailable('invalid_profile_or_payload')])), quotes: [] }; }
}
