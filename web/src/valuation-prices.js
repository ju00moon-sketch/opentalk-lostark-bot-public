import { createHash } from 'node:crypto';
import { GuildError } from './guild-store.js';
import { OPTIONS } from '../../src/data/refine.js';

const API = 'https://developer-lostark.game.onstove.com/auctions/items';
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1e12;
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const failure = () => new GuildError(502, 'valuation_price_unavailable');
const limited = () => new GuildError(429, 'valuation_rate_limited');
const invalid = () => new GuildError(400, 'invalid_valuation_quote');
const absent = reason => ({ status: 'unavailable', reason, unitGold: null, checkedAt: null });
const canonical = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const subtypes = { 안정: '질서', 견고: '질서', 불변: '질서', 침식: '혼돈', 왜곡: '혼돈', 붕괴: '혼돈' };
const grades = ['고급', '희귀', '영웅'];
const optionName = value => typeof value === 'string' ? value.normalize('NFC').replace(/[%+\s·,]/g, '') : '';
// Labels observed in the official auction response differ from the armory
// refinement text. Keep the suffix aliases specific to the verified effects.
const optionAliases = {
  42: ['적에게 주는 피해 증가'],
  43: ['세레나데, 신앙, 조화 게이지 획득량 증가'],
};
const ACCESSORY_CATEGORIES = new Set([200010, 200020, 200030]);
const optionGrade = row => {
  const at = OPTIONS[row.SecondOption]?.values.indexOf(row.MinValue) ?? -1;
  return at < 0 ? 0 : at;
};

function auctionBody(input) {
  if (!input || ![210000, 200010, 200020, 200030].includes(input.CategoryCode) ||
      !(input.CategoryCode === 210000 ? [3, 4].includes(input.ItemTier) : input.ItemTier === 4) ||
      typeof input.ItemName !== 'string' || input.ItemName.length > 80 || !input.ItemName.isWellFormed() ||
      !['고급', '희귀', '영웅', '전설', '유물', '고대'].includes(input.ItemGrade) ||
      (input.ItemGradeQuality != null && !integer(input.ItemGradeQuality, 0, 100)) ||
      !Array.isArray(input.EtcOptions) || input.EtcOptions.length > 3 ||
      !input.EtcOptions.every(row => row?.FirstOption === 7 && OPTIONS[row.SecondOption] &&
        integer(row.MinValue, 0, 100000) && row.MaxValue === row.MinValue) ||
      !Array.isArray(input.SkillOptions) || input.SkillOptions.length !== 0) throw invalid();
  return { Sort: 'BUY_PRICE', SortCondition: 'ASC', PageNo: 1, CategoryCode: input.CategoryCode,
    ItemTier: input.ItemTier, ItemGrade: input.ItemGrade, ItemGradeQuality: input.ItemGradeQuality ?? null,
    ItemName: input.ItemName, EtcOptions: input.EtcOptions, SkillOptions: [] };
}

function matchesListing(row, body, timestamp) {
  if (!row || row.Grade !== body.ItemGrade || row.Tier !== body.ItemTier || !positive(row.AuctionInfo?.BuyPrice)) return false;
  const end = row.AuctionInfo.EndDate;
  const expiry = typeof end === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(end)
    ? Date.parse(/[Zz]|[+-]\d{2}:\d{2}$/.test(end) ? end : `${end}+09:00`) : NaN;
  if (!Number.isFinite(expiry) || expiry <= timestamp) return false;
  if (body.CategoryCode === 210000) return row.Name === body.ItemName;
  if (typeof row.Name !== 'string' || !row.Name.endsWith(body.ItemName) ||
      !integer(row.GradeQuality, 0, 100) || row.GradeQuality < (body.ItemGradeQuality ?? 0) ||
      !Array.isArray(row.Options)) return false;
  return body.EtcOptions.every(filter => {
    const rule = OPTIONS[filter.SecondOption];
    const expected = filter.SecondOption <= 52 ? filter.MinValue / 100 : filter.MinValue;
    const names = new Set([rule.full, rule.name, ...(optionAliases[filter.SecondOption] ?? [])].map(optionName));
    const found = row.Options.filter(option => option?.Type === 'ACCESSORY_UPGRADE' &&
      option.IsValuePercentage === (filter.SecondOption <= 52) && names.has(optionName(option.OptionName)));
    return found.length === 1 && found[0].IsPenalty === false &&
      typeof found[0].Value === 'number' && Math.abs(found[0].Value - expected) < 1e-8;
  });
}

export function createValuationPriceService({ market, config, fetchImpl = fetch, now = Date.now,
  cacheMs = 15 * 60000, requestTimeoutMs = 8000, maxEntries = 256 } = {}) {
  const cache = new Map(), pending = new Map(), controllers = new Set(), queue = [];
  let closed = false, active = 0, blockedUntil = 0;
  function shared(key, operation) {
    if (closed) return Promise.reject(failure());
    const old = cache.get(key);
    if (old?.until > now()) { cache.delete(key); cache.set(key, old); return Promise.resolve(old.data); }
    cache.delete(key);
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 32) return Promise.reject(limited());
    const promise = Promise.resolve().then(operation).then(data => {
      if (closed) throw failure();
      cache.set(key, { data, until: now() + (data.status === 'unavailable' ? Math.min(cacheMs, 30000) : cacheMs) });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      return data;
    }).finally(() => pending.delete(key));
    pending.set(key, promise); return promise;
  }
  function drain() {
    while (!closed && active < 2 && queue.length) {
      const row = queue.shift(); row.signal.removeEventListener('abort', row.abort);
      if (row.signal.aborted) { row.reject(failure()); continue; }
      active++; let released = false;
      row.resolve(() => { if (!released) { released = true; active--; drain(); } });
    }
  }
  function acquire(signal) {
    return new Promise((resolve, reject) => {
      if (closed || signal.aborted) return reject(failure());
      if (queue.length >= 16) return reject(limited());
      const row = { signal, resolve, reject };
      row.abort = () => { const at = queue.indexOf(row); if (at !== -1) queue.splice(at, 1); reject(failure()); };
      signal.addEventListener('abort', row.abort, { once: true }); queue.push(row); drain();
    });
  }
  async function auction(body) {
    if (closed || !config?.automaticApproval?.lostArkApiKey) throw failure();
    if (blockedUntil > now()) throw limited();
    const controller = new AbortController(); controllers.add(controller);
    const { signal } = controller;
    let abort;
    const deadline = new Promise((_resolve, reject) => { abort = () => reject(failure()); signal.addEventListener('abort', abort, { once: true }); });
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const physical = (async () => {
      let release, reader, response;
      try {
        release = await acquire(signal); signal.throwIfAborted();
        if (blockedUntil > now()) throw limited();
        response = await fetchImpl(API, { method: 'POST', redirect: 'error', signal,
          headers: { Authorization: `bearer ${config.automaticApproval.lostArkApiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        signal.throwIfAborted();
        if (response.status === 429) { blockedUntil = now() + 60000; throw limited(); }
        if (!response.ok || response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '') ||
            Number(response.headers.get('content-length')) > 1048576 || !response.body) throw failure();
        reader = response.body.getReader(); let size = 0; const chunks = [];
        while (true) { const { done, value } = await reader.read(); signal.throwIfAborted(); if (done) break;
          size += value.byteLength; if (size > 1048576) throw failure(); chunks.push(Buffer.from(value)); }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } catch (error) { if (error?.status === 429) { blockedUntil = now() + 60000; throw limited(); } throw failure(); }
      finally { if (reader) void reader.cancel().catch(() => {}); else void response?.body?.cancel().catch(() => {}); release?.(); }
    })();
    try { return await Promise.race([physical, deadline]); }
    finally { clearTimeout(timer); controller.abort(); signal.removeEventListener('abort', abort); controllers.delete(controller); }
  }
  async function marketRows(category, name) {
    if (!market?.search) throw failure();
    const first = await market.search({ kind: 'market', category, query: name, page: 1, sort: 'GRADE', order: 'DESC' });
    if (!integer(first?.pageCount, 0, 4) || !Array.isArray(first.items)) throw failure();
    const items = [...first.items]; let checkedAt = first.updatedAt;
    for (let page = 2; page <= first.pageCount; page++) {
      if (closed) throw failure();
      const next = await market.search({ kind: 'market', category, query: name, page, sort: 'GRADE', order: 'DESC' });
      if (!Array.isArray(next?.items) || next.pageCount !== first.pageCount) throw failure();
      items.push(...next.items); checkedAt = Math.min(checkedAt, next.updatedAt);
    }
    return { items, checkedAt: Number.isFinite(checkedAt) ? checkedAt : now() };
  }
  // A bound or simply unlisted accessory has no listing of its own, so the same slot, tier and grade is searched
  // again without the quality floor, then with its weakest major effects dropped one at a time, down to the grade's
  // own listings. Every stage is its own body, so the fifteen minute cache holds one entry per relaxation step.
  function accessoryRelaxations(body) {
    const stages = [{ body, basis: null, relaxation: null }], seen = new Set([canonical(body)]);
    const relaxed = { ...body, ItemGradeQuality: null };
    const add = (next, basis, relaxation) => {
      const key = canonical(next);
      if (seen.has(key)) return;
      seen.add(key); stages.push({ body: next, basis, relaxation });
    };
    add(relaxed, 'replacement_relaxed_quality', { quality: true, droppedOptions: 0, droppedOptionCodes: [] });
    const weakestFirst = [...body.EtcOptions].sort((a, b) => optionGrade(a) - optionGrade(b) || a.SecondOption - b.SecondOption);
    const dropped = [];
    for (const row of weakestFirst) {
      dropped.push(row.SecondOption);
      add({ ...relaxed, EtcOptions: body.EtcOptions.filter(option => !dropped.includes(option.SecondOption)) },
        'replacement_relaxed_options', { quality: true, droppedOptions: dropped.length, droppedOptionCodes: [...dropped] });
    }
    return stages;
  }
  function auctionPrice(body) {
    return shared(canonical(['auction', body]), async () => {
      const raw = await auction(body);
      if (!raw || raw.PageNo !== 1 || !integer(raw.PageSize, 1, 100) || !integer(raw.TotalCount, 0, 1e9) ||
          (raw.Items !== null && !Array.isArray(raw.Items)) || (raw.Items?.length ?? 0) > Math.min(raw.TotalCount, raw.PageSize)) throw failure();
      const checkedAt = now(), rows = (raw.Items ?? []).filter(row => matchesListing(row, body, checkedAt));
      if (!rows.length) return absent(raw.TotalCount ? 'no_matching_listings' : 'no_listings');
      return { status: 'ok', unitGold: Math.min(...rows.map(row => row.AuctionInfo.BuyPrice)), checkedAt,
        source: 'official-auction', basis: 'current_matching_listing_minimum', matchedListings: rows.length, sampledListings: raw.Items?.length ?? 0 };
    });
  }
  async function accessoryPrice(body) {
    let exact = null;
    for (const stage of accessoryRelaxations(body)) {
      const result = await auctionPrice(stage.body);
      exact ??= result;
      if (result.status !== 'ok') continue;
      return stage.basis ? { ...result, estimated: true, basis: stage.basis, relaxation: stage.relaxation } : result;
    }
    return exact;
  }
  function get(quote) {
    if (!quote || typeof quote.quoteKey !== 'string' || quote.quoteKey.length > 160) return Promise.reject(invalid());
    if (quote.kind === 'market') {
      if (![40000, 50010, 50020].includes(quote.category) || typeof quote.name !== 'string' || !quote.name || quote.name.length > 60 ||
          typeof quote.grade !== 'string' || quote.grade.length > 20) return Promise.reject(invalid());
      return shared(canonical(['market', quote.category, quote.name, quote.grade]), async () => {
        const result = await marketRows(quote.category, quote.name);
        const listedName = quote.category === 40000 ? `${quote.grade} ${quote.name}` : quote.name;
        const matches = result.items.filter(row => row.name === listedName && row.grade === quote.grade &&
          positive(row.currentMinPrice) && integer(row.bundleCount, 1, 1000000));
        if (!matches.length) return absent('no_listings');
        return { status: 'ok', unitGold: Math.min(...matches.map(row => row.currentMinPrice / row.bundleCount)), checkedAt: result.checkedAt,
          source: 'official-market', basis: 'current_listing_minimum' };
      });
    }
    if (quote.kind !== 'auction') return Promise.reject(invalid());
    let body; try { body = auctionBody(quote.body); } catch (error) { return Promise.reject(error); }
    return ACCESSORY_CATEGORIES.has(body.CategoryCode) ? accessoryPrice(body) : auctionPrice(body);
  }
  function gemCatalogue() {
    return shared('arkgrid-gem-catalogue', async () => {
      const result = await marketRows(230000, '젬');
      const prices = {};
      for (const [subtype, family] of Object.entries(subtypes)) for (const grade of grades) {
        const rows = result.items.filter(row => row.name === `${family}의 젬 : ${subtype}` && row.grade === grade &&
          positive(row.currentMinPrice) && integer(row.bundleCount, 1, 1000000));
        prices[`${subtype}:${grade}`] = rows.length ? { status: 'ok', unitGold: Math.min(...rows.map(row => row.currentMinPrice / row.bundleCount)),
          checkedAt: result.checkedAt, source: 'official-market', basis: 'current_listing_minimum' } : absent('no_listings');
      }
      return { prices, checkedAt: result.checkedAt };
    });
  }
  function close() {
    closed = true; for (const controller of controllers) controller.abort();
    for (const row of queue.splice(0)) { row.signal.removeEventListener('abort', row.abort); row.reject(failure()); }
    cache.clear();
  }
  return { get, gemCatalogue, close };
}
