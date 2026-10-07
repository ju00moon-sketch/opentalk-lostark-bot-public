const BASE_COMPONENTS = ['gems', 'accessories', 'engravings', 'honing'];
const EXTRA_COMPONENTS = ['bracelet', 'arkgridGems'];
const MARKET_COMPONENTS = new Set(['gems', 'accessories', 'engravings']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const fresh = (value, now, maxAge) => Number.isSafeInteger(value) && value >= 0 && value <= now && now - value <= maxAge;
// A replacement basis: the item is priced, but from a relaxed search rather than its own exact listing.
const BASIS = /^[a-z][a-z_]{0,59}$/;
const replacementBasis = value => typeof value === 'string' && BASIS.test(value) ? value : null;
const unavailableItem = (item, reason) => ({ id: typeof item?.id === 'string' ? item.id.slice(0, 100) : 'unknown',
  status: 'unavailable', reason, targetKey: hash(item?.targetKey) ? item.targetKey : null,
  ...(item?.kind === 'engraving' || item?.accountKey ? { accountKey: item.accountKey, grade: item.grade, level: item.level } : {}),
  marketReplacementGold: null, expectedAcquisitionGold: null, knownGold: 0, totalGold: null });

function sum(values) {
  let total = 0;
  for (const value of values) { if (!money(value) || !money(total + value)) return null; total += value; }
  return total;
}
function totals(items, forcedUnknown = false) {
  const missing = Number.isSafeInteger(forcedUnknown) ? forcedUnknown : forcedUnknown ? 1 : 0;
  const known = items.filter(x => x.status === 'ok');
  const market = sum(known.map(x => x.marketReplacementGold ?? 0));
  const expected = sum(known.map(x => x.expectedAcquisitionGold ?? 0));
  const knownGold = market === null || expected === null ? null : sum([market, expected]);
  const complete = !missing && known.length === items.length && knownGold !== null;
  return { complete, marketReplacementGold: complete ? market : null, expectedAcquisitionGold: complete ? expected : null,
    knownMarketReplacementGold: market, knownExpectedAcquisitionGold: expected, knownGold,
    totalGold: complete ? knownGold : null, counts: { items: items.length, known: known.length,
      unknown: items.length - known.length + missing, estimated: known.filter(x => x.estimated === true).length } };
}
function quoteValue(quoteKey, quotes, now, maxAge) {
  const quote = typeof quoteKey === 'string' && Object.hasOwn(quotes, quoteKey) ? quotes[quoteKey] : null;
  if (!record(quote) || quote.status !== 'ok' || !money(quote.unitGold) || quote.unitGold <= 0 || !fresh(quote.checkedAt, now, maxAge)) return null;
  const basis = quote.estimated === true ? replacementBasis(quote.basis) : null;
  return { gold: quote.unitGold, checkedAt: quote.checkedAt, ...(basis ? { basis, estimated: true } : {}) };
}
function recipeValue(recipe, quotes, now, maxAge) {
  if (!Array.isArray(recipe.requirements) || recipe.requirements.length > 64 || !money(recipe.fixedGold)) return null;
  let gold = recipe.fixedGold, checkedAt = recipe.checkedAt;
  const seen = new Set();
  for (const entry of recipe.requirements) {
    if (!record(entry) || typeof entry.quoteKey !== 'string' || seen.has(entry.quoteKey) || !money(entry.quantity)) return null;
    seen.add(entry.quoteKey); if (entry.quantity === 0) continue;
    const quoted = quoteValue(entry.quoteKey, quotes, now, maxAge); if (!quoted) return null;
    gold += entry.quantity * quoted.gold; if (!money(gold)) return null;
    checkedAt = Math.min(checkedAt, quoted.checkedAt);
  }
  return { gold, checkedAt };
}
function costValue(item, component, costs, quotes, now, maxAge) {
  let cost = Object.hasOwn(costs, item.targetKey) ? costs[item.targetKey] : null;
  if (!cost && component === 'engravings' && item.recipeVersion === 'official-engraving-2026-09-16' && Array.isArray(item.bookQuotes)) {
    cost = { status: 'ok', targetKey: item.targetKey, modelVersion: item.recipeVersion, checkedAt: now, fixedGold: 0,
      requirements: item.bookQuotes.map(row => ({ quoteKey: row.quoteKey, quantity: row.quantity })) };
  }
  if (!record(cost) || cost.status !== 'ok' || cost.targetKey !== item.targetKey || typeof cost.modelVersion !== 'string'
    || !cost.modelVersion || cost.modelVersion.length > 120 || !fresh(cost.checkedAt, now, maxAge)) return null;
  if (cost.expectedAcquisitionGold !== undefined) {
    if (!money(cost.expectedAcquisitionGold) || cost.requirements !== undefined) return null;
    return { gold: cost.expectedAcquisitionGold, checkedAt: cost.checkedAt, modelVersion: cost.modelVersion };
  }
  const priced = recipeValue(cost, quotes, now, maxAge);
  return priced ? { ...priced, modelVersion: cost.modelVersion } : null;
}
function calculateItem(item, component, context) {
  const { quotes, costs, now, maxAge } = context;
  if (!record(item) || item.status !== 'ok' || !hash(item.targetKey) || typeof item.id !== 'string' || item.id.length > 100)
    return unavailableItem(item, typeof item?.reason === 'string' && /^[a-z_]{1,80}$/.test(item.reason) ? item.reason : 'target_unavailable');
  let priced;
  if (component === 'gems' && item.bound === true && item.zeroReason === 'bound_gem') priced = { gold: 0, checkedAt: null, basis: 'bound_gem_zero' };
  else if (component === 'gems' || component === 'accessories') {
    // 조율된 보석은 자기 매물이 없고 복원 대상 보석으로만 팔 수 있다 — 후보 시세 중 싼 쪽을 대체 값으로 쓴다.
    const substitutes = component === 'gems' && Array.isArray(item.substituteQuoteKeys)
      && item.substituteQuoteKeys.length > 0 && item.substituteQuoteKeys.length <= 4
      && item.substituteQuoteKeys.every(key => typeof key === 'string') ? item.substituteQuoteKeys : null;
    if (substitutes) {
      const options = substitutes.map(key => quoteValue(key, quotes, now, maxAge)).filter(Boolean);
      const cheapest = options.length ? options.reduce((low, row) => (row.gold < low.gold ? row : low)) : null;
      const basis = replacementBasis(item.substituteBasis);
      priced = cheapest && basis ? { ...cheapest, basis, estimated: true } : null;
    } else priced = quoteValue(item.quoteKey, quotes, now, maxAge);
    if (!priced) return unavailableItem(item, 'price_unavailable');
    priced.basis ??= 'current_market';
  } else if (EXTRA_COMPONENTS.includes(component)) {
    if (!money(item.expectedAcquisitionGold) || !fresh(item.checkedAt, now, maxAge) || typeof item.modelVersion !== 'string' || !item.modelVersion || item.modelVersion.length > 120)
      return unavailableItem(item, 'expectation_unavailable');
    const basis = item.estimated === true ? replacementBasis(item.basis) : null;
    priced = { gold: item.expectedAcquisitionGold, checkedAt: item.checkedAt, modelVersion: item.modelVersion,
      basis: basis ?? 'expected_acquisition', ...(basis ? { estimated: true } : {}) };
  } else {
    priced = costValue(item, component, costs, quotes, now, maxAge);
    if (!priced) return unavailableItem(item, component === 'honing' ? 'honing_recipe_or_price_unavailable' : 'book_price_unavailable');
    priced.basis = component === 'engravings' ? 'observed_engraving_books' : 'expected_acquisition';
  }
  const market = MARKET_COMPONENTS.has(component);
  return { id: item.id, status: 'ok', targetKey: item.targetKey, basis: priced.basis, checkedAt: priced.checkedAt,
    ...(priced.estimated ? { estimated: true } : {}),
    ...(priced.modelVersion ? { modelVersion: priced.modelVersion } : {}),
    ...(component === 'engravings' ? { accountKey: item.accountKey, grade: item.grade, level: item.level, coverage: 'equipped_only', progressCoverage: 'completed_levels_only' } : {}),
    marketReplacementGold: market ? priced.gold : 0, expectedAcquisitionGold: market ? 0 : priced.gold, knownGold: priced.gold, totalGold: priced.gold };
}
function calculateComponent(id, component, context) {
  const valid = record(component) && ['ok', 'empty', 'partial', 'unavailable'].includes(component.status)
    && Array.isArray(component.items) && component.items.length <= 64;
  if (!valid || (component.status === 'empty' && component.items.length) || (component.status === 'ok' && !component.items.length))
    return { id, status: 'unavailable', items: [], reason: 'component_unavailable', ...totals([], true) };
  const ids = component.items.map(x => x?.id);
  if (ids.some(x => typeof x !== 'string') || new Set(ids).size !== ids.length)
    return { id, status: 'unavailable', items: [], reason: 'duplicate_item_identity', ...totals([], true) };
  const items = component.items.map(item => calculateItem(item, id, context));
  const forcedUnknown = ['partial', 'unavailable'].includes(component.status) && !items.some(x => x.status !== 'ok');
  const result = totals(items, forcedUnknown);
  return { id, status: result.complete ? items.length ? 'ok' : 'empty' : result.counts.known ? 'partial' : 'unavailable', items, ...result };
}
function failedCharacter(name = null, reason = 'targets_unavailable') {
  return { status: 'unavailable', characterName: name, reason, components: {}, ...totals([], true), estimatedItems: 0 };
}
// Character totals over the listed component groups; a null result means the sum left the safe range.
function characterTotals(groups) {
  const all = groups.flatMap(x => x.items);
  const missing = groups.reduce((count, group) => count + group.counts.unknown - group.items.filter(x => x.status !== 'ok').length, 0);
  const result = totals(all, missing);
  if (result.knownGold === null) return null;
  result.marketReplacementGold = groups.filter(x => MARKET_COMPONENTS.has(x.id)).every(x => x.complete) ? result.knownMarketReplacementGold : null;
  result.expectedAcquisitionGold = groups.filter(x => !MARKET_COMPONENTS.has(x.id)).every(x => x.complete) ? result.knownExpectedAcquisitionGold : null;
  return result;
}

// All prices and expectations are injected. This module performs no requests.
export function calculateCharacterValuation(targets, { quotes = {}, costs = {}, extraComponents = {}, now = Date.now(), quoteMaxAgeMs = 300000 } = {}) {
  try {
    now = typeof now === 'function' ? now() : now;
    if (!record(targets) || !['ok', 'partial'].includes(targets.status) || targets.version !== 'roster-targets-v1'
      || typeof targets.characterName !== 'string' || !/^[가-힣A-Za-z0-9]{2,12}$/.test(targets.characterName)
      || typeof targets.serverName !== 'string' || !/^[가-힣A-Za-z0-9]{1,30}$/.test(targets.serverName)
      || !hash(targets.targetKey) || !record(targets.components) || !record(quotes) || !record(costs) || !record(extraComponents)
      || !Number.isSafeInteger(now) || !Number.isSafeInteger(quoteMaxAgeMs) || quoteMaxAgeMs < 0 || quoteMaxAgeMs > 3600000
      || !fresh(targets.observedAt, now, quoteMaxAgeMs)) return failedCharacter(targets?.characterName, 'targets_unavailable_or_stale');
    const context = { quotes, costs, now, maxAge: quoteMaxAgeMs };
    const components = Object.fromEntries(BASE_COMPONENTS.map(id => [id, calculateComponent(id, targets.components[id], context)]));
    for (const id of EXTRA_COMPONENTS) if (Object.hasOwn(extraComponents, id)) components[id] = calculateComponent(id, extraComponents[id], context);
    const groups = Object.values(components);
    const result = characterTotals(groups);
    // Engraving books are bound to the server, so a roster counts them once at the top instead of inside each character.
    const excludingSharedBooks = characterTotals(groups.filter(x => x.id !== 'engravings'));
    if (!result || !excludingSharedBooks) return failedCharacter(targets.characterName, 'value_overflow');
    return { status: result.complete ? 'ok' : result.counts.known ? 'partial' : 'unavailable', characterName: targets.characterName, serverName: targets.serverName,
      targetKey: targets.targetKey, observedAt: targets.observedAt, checkedAt: now, components, ...result,
      // Items priced from a replacement listing rather than their own: complete, but marked as substituted.
      estimatedItems: result.counts.estimated, excludingSharedBooks };
  } catch { return failedCharacter(); }
}

const SERVER_NAME = /^[가-힣A-Za-z0-9]{1,30}$/;
const bookRank = item => (item.grade === '유물' ? 5 : 0) + item.level;
// Lists one character's equipped books into the server-and-engraving groups; false means the list itself is not fully known.
function groupEngravingBooks(character, groups) {
  const books = character.components.engravings;
  if (!record(books) || !Array.isArray(books.items) || !record(books.counts) || books.counts.unknown > books.items.filter(x => x.status !== 'ok').length) return false;
  let listed = true;
  for (const item of books.items) {
    if (typeof character.serverName !== 'string' || !SERVER_NAME.test(character.serverName) || typeof item.accountKey !== 'string'
      || !['전설', '유물'].includes(item.grade) || !Number.isInteger(item.level) || item.level < 0 || item.level > 4) { listed = false; continue; }
    const sharingKey = `${character.serverName}:${item.accountKey}`;
    const list = groups.get(sharingKey) || []; list.push({ ...item, characterName: character.characterName, serverName: character.serverName }); groups.set(sharingKey, list);
  }
  return listed;
}

export function aggregateRosterValuations(characters) {
  try {
    if (!Array.isArray(characters) || !characters.length || characters.length > 240) return failedCharacter(null, 'invalid_roster');
    const names = characters.map(row => row?.characterName?.toLowerCase());
    if (names.some(x => typeof x !== 'string') || new Set(names).size !== names.length) return failedCharacter(null, 'duplicate_roster_identity');
    let market = 0, expected = 0, complete = true, unknownCharacters = 0, engravingBooksComplete = true;
    let estimatedItems = 0, estimatedCharacters = 0;
    const groups = new Map();
    for (const character of characters) {
      const own = record(character) ? character.excludingSharedBooks : null;
      if (!record(character) || !record(character.components) || !record(own) || !money(own.knownMarketReplacementGold) || !money(own.knownExpectedAcquisitionGold)) {
        complete = false; engravingBooksComplete = false; unknownCharacters++; continue;
      }
      market += own.knownMarketReplacementGold; expected += own.knownExpectedAcquisitionGold;
      const estimated = Number.isSafeInteger(character.estimatedItems) && character.estimatedItems >= 0 ? character.estimatedItems : 0;
      if (estimated) { estimatedItems += estimated; estimatedCharacters++; }
      if (!own.complete) { complete = false; unknownCharacters++; }
      if (!groupEngravingBooks(character, groups)) engravingBooksComplete = false;
    }
    // One value per server and engraving: the highest equipped stage, whether one character or many wear it.
    const engravingBooks = [];
    for (const entries of groups.values()) {
      entries.sort((a, b) => bookRank(b) - bookRank(a) || (b.checkedAt ?? 0) - (a.checkedAt ?? 0));
      const best = entries[0], ok = best.status === 'ok' && money(best.marketReplacementGold);
      if (!ok) engravingBooksComplete = false;
      engravingBooks.push({ serverName: best.serverName, accountKey: best.accountKey, name: best.accountKey.slice(best.accountKey.lastIndexOf(':') + 1),
        grade: best.grade, level: best.level, status: ok ? 'ok' : 'unavailable', gold: ok ? best.marketReplacementGold : null,
        reason: ok ? null : typeof best.reason === 'string' ? best.reason : 'book_price_unavailable',
        characters: entries.map(x => x.characterName), coverage: 'maximum_observed_equipped_level' });
    }
    engravingBooks.sort((a, b) => (b.gold ?? -1) - (a.gold ?? -1));
    const engravingBooksGold = sum(engravingBooks.filter(x => x.status === 'ok').map(x => x.gold));
    if (!engravingBooksComplete) complete = false;
    market = engravingBooksGold === null ? null : sum([market, engravingBooksGold]);
    const knownGold = market === null ? null : sum([market, expected]);
    if (knownGold === null) return failedCharacter(null, 'value_overflow');
    return { status: complete ? 'ok' : 'partial', complete, marketReplacementGold: complete ? market : null,
      expectedAcquisitionGold: complete ? expected : null, knownMarketReplacementGold: market, knownExpectedAcquisitionGold: expected,
      knownGold, totalGold: complete ? knownGold : null, engravingBooks, engravingBooksGold, engravingBooksComplete, estimatedItems,
      counts: { characters: characters.length, knownCharacters: characters.length - unknownCharacters, unknownCharacters, estimatedCharacters } };
  } catch { return failedCharacter(null, 'invalid_roster'); }
}
