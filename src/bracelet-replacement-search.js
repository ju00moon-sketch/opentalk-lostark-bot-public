import { createHash } from 'node:crypto';
import { STAT_CODES, SPECIAL_MAX } from './bracelet-search.js';
import { parseBraceletEndDate } from './bracelet-base-price.js';

// A replacement price for a bracelet the conversion model cannot evaluate: a raid bracelet whose effects are
// fixed and cannot be enchanted, a tier 3 bracelet whose effect text is not in the official probability table,
// or a bracelet whose search found nothing. The ladder searches the same tier and grade with the bracelet's own
// combat and main stat lines, drops them one at a time, and ends at the grade's own listings
// (README.md).
export const BRACELET_REPLACEMENT_MODEL = 'bracelet-replacement-2026-09-19.1';
export const BRACELET_REPLACEMENT_BASIS = ['bracelet_replacement_relaxed', 'bracelet_market_average'];
const MAX_PRICE = 1_000_000_000_000;
const MAX_RULES = 2;
const COMBAT_TOLERANCE = 5;
const GRADES = ['유물', '고대'];
const MAIN_STATS = ['힘', '민첩', '지능'];
const OPTION_TYPES = new Set(['STAT', 'BRACELET_SPECIAL_EFFECTS', 'ABILITY_ENGRAVE',
  'BRACELET_RANDOM_SLOT', 'BRACELET_FIXED_SLOT', 'ARK_PASSIVE']);
const compact = text => text.normalize('NFC').replace(/\s+/g, '');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unavailable = reason => ({ status: 'unavailable', reason });

function rule(stat) {
  if (MAIN_STATS.includes(stat.name)) {
    return { id: `base.${stat.name}`, name: stat.name, first: 1, second: 11, value: stat.value,
      min: stat.value, max: stat.value, tolerance: 0, operator: '=' };
  }
  const min = Math.max(0, stat.value - COMBAT_TOLERANCE), max = stat.value + COMBAT_TOLERANCE;
  return { id: `combat.${stat.name}`, name: stat.name, first: 2, second: STAT_CODES[stat.name], value: stat.value,
    min, max, tolerance: COMBAT_TOLERANCE, operator: 'range' };
}

function stage(tier, grade, rules) {
  const body = { ItemLevelMin: 0, ItemLevelMax: 0, ItemGradeQuality: null,
    EtcOptions: rules.map(row => ({ FirstOption: row.first, SecondOption: row.second, MinValue: row.min, MaxValue: row.max })),
    Sort: 'BUY_PRICE', CategoryCode: 200040, CharacterClass: '', ItemTier: tier, ItemGrade: grade,
    ItemName: '', PageNo: 1, SortCondition: 'ASC' };
  return { status: 'ok', tier, grade, rules, body,
    basis: rules.length ? BRACELET_REPLACEMENT_BASIS[0] : BRACELET_REPLACEMENT_BASIS[1],
    conditions: rules.map(({ name, operator, value, min, max, tolerance }) => ({ name, operator, value, min, max, tolerance })),
    fingerprint: hash({ version: BRACELET_REPLACEMENT_MODEL, body, rules }) };
}

/**
 * Ordered replacement stages for one equipped bracelet: its two strongest combat/main stat lines, then one,
 * then the grade's own listings with no option filter at all. Identical stages collapse.
 */
export function buildBraceletReplacementPlan({ tier, grade, stats } = {}) {
  if (!integer(tier, 3, 4) || !GRADES.includes(grade)) return unavailable('bracelet_replacement_unsupported');
  if (!Array.isArray(stats) || stats.length > 16) return unavailable('bracelet_replacement_unsupported');
  const seen = new Set(), usable = [];
  for (const stat of stats) {
    if (!object(stat) || typeof stat.name !== 'string' || seen.has(stat.name) ||
      !(MAIN_STATS.includes(stat.name) || Object.hasOwn(STAT_CODES, stat.name)) ||
      !integer(stat.value, 1, 100000)) continue;
    seen.add(stat.name); usable.push({ name: stat.name, value: stat.value });
  }
  // Combat stats identify a bracelet far more tightly than the main stat, so they are kept first.
  usable.sort((a, b) => (MAIN_STATS.includes(a.name) ? 1 : 0) - (MAIN_STATS.includes(b.name) ? 1 : 0) ||
    b.value - a.value || a.name.localeCompare(b.name, 'ko'));
  const rules = usable.slice(0, MAX_RULES).map(rule);
  const stages = [], fingerprints = new Set();
  for (let count = rules.length; count >= 0; count--) {
    const candidate = stage(tier, grade, rules.slice(0, count));
    if (fingerprints.has(candidate.fingerprint)) continue;
    fingerprints.add(candidate.fingerprint); stages.push(candidate);
  }
  return { status: 'ok', modelVersion: BRACELET_REPLACEMENT_MODEL, tier, grade, stages,
    targetKey: hash({ version: BRACELET_REPLACEMENT_MODEL, tier, grade, rules }) };
}

function optionMismatch(options, rules) {
  if (!Array.isArray(options) || options.length > 12) return 'auction_shape_invalid';
  const seen = new Set(), metadataTypes = new Set();
  for (const option of options) {
    if (!object(option) || typeof option.OptionName !== 'string' || option.OptionName.length > 150 ||
      !OPTION_TYPES.has(option.Type) || !Number.isFinite(option.Value) || option.Value < 0 || option.Value > SPECIAL_MAX ||
      ('IsPenalty' in option && option.IsPenalty !== false) ||
      ('IsValuePercentage' in option && typeof option.IsValuePercentage !== 'boolean') ||
      (option.Type === 'ARK_PASSIVE' && option.OptionName !== '도약')) return 'auction_option_invalid';
    // Match the base normalizer: slots/ark are unique by type, fixed effects by name.
    // Slot labels need not be distinct from stat/effect labels or even nonempty.
    if (['BRACELET_RANDOM_SLOT', 'BRACELET_FIXED_SLOT', 'ARK_PASSIVE'].includes(option.Type)) {
      if (metadataTypes.has(option.Type)) return 'auction_option_duplicate';
      metadataTypes.add(option.Type);
    } else {
      const name = compact(option.OptionName);
      if (seen.has(name)) return 'auction_option_duplicate';
      seen.add(name);
    }
  }
  const matches = new Set();
  // Only this request's rules apply: do not restore stats/effects removed by the replacement ladder.
  for (const rule of rules) {
    const found = options.filter(option => option.Type === 'STAT' &&
      (compact(option.OptionName) === compact(rule.name) ||
        (MAIN_STATS.includes(rule.name) && compact(option.OptionName) === compact('힘 / 민첩 / 지능'))));
    if (found.length !== 1 || matches.has(found[0]) || found[0].Value < rule.min || found[0].Value > rule.max) return 'filter_mismatch';
    if (!Number.isSafeInteger(found[0].Value) || found[0].IsValuePercentage !== false) return 'auction_unit_invalid';
    matches.add(found[0]);
  }
  return null;
}

/** Fail closed on API schema/filter changes; only purchasable listings matching the sent rules are sampled. */
export function normalizeBraceletReplacementAuction(response, search, { now = Date.now(), requestedPageNo = 1 } = {}) {
  const result = { status: 'unavailable', samples: [], totalCount: 0, pageNo: requestedPageNo, pageSize: 10,
    checkedCount: 0, excludedCount: 0, tier: search?.tier, grade: search?.grade };
  if (search?.status !== 'ok' || !Array.isArray(search.rules) || !Number.isFinite(now) || !integer(requestedPageNo, 1, 1000000)) {
    return { ...result, reason: 'search_invalid' };
  }
  if (!object(response) || response.PageNo !== requestedPageNo || response.PageSize !== 10 ||
    !integer(response.TotalCount, 0, 10000000)) return { ...result, reason: 'auction_response_invalid' };
  const items = response.Items === null && response.TotalCount === 0 ? [] : response.Items;
  if (!Array.isArray(items) || items.length !== Math.min(10, Math.max(0, response.TotalCount - (requestedPageNo - 1) * 10))) {
    return { ...result, reason: 'auction_response_invalid' };
  }
  result.totalCount = response.TotalCount;
  if (!items.length) {
    if (response.TotalCount !== 0 || requestedPageNo !== 1) return { ...result, reason: 'auction_response_invalid' };
    return { ...result, status: 'no_listings' };
  }
  if ((requestedPageNo - 1) * 10 >= response.TotalCount) return { ...result, reason: 'auction_response_invalid' };
  const samples = []; let excluded = 0, last = 0;
  for (const item of items) {
    if (!object(item) || item.Tier !== search.tier || item.Grade !== search.grade ||
      typeof item.Name !== 'string' || !item.Name.includes('팔찌') || item.Name.length > 120 ||
      !object(item.AuctionInfo)) return { ...result, reason: 'filter_mismatch' };
    const mismatch = optionMismatch(item.Options, search.rules);
    if (mismatch) return { ...result, reason: mismatch };
    const price = item.AuctionInfo.BuyPrice, ends = parseBraceletEndDate(item.AuctionInfo.EndDate);
    if (ends === null) return { ...result, reason: 'auction_end_invalid' };
    if (price !== null && !integer(price, 0, MAX_PRICE)) return { ...result, reason: 'auction_price_invalid' };
    if (price === null || price === 0 || ends <= now) { excluded++; continue; }
    if (price < last) return { ...result, reason: 'auction_sort_invalid' };
    last = price; samples.push({ price, name: item.Name, tier: item.Tier, grade: item.Grade, endsAt: item.AuctionInfo.EndDate });
  }
  return { ...result, status: 'ok', samples, checkedCount: items.length, excludedCount: excluded };
}
