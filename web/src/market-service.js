import { GuildError } from './guild-store.js';
import { parseGemSearch } from '../../src/gem-search.js';
import { evenShareBid, preemptBid, resaleCap } from '../../src/bid-calculation.js';

const API = 'https://developer-lostark.game.onstove.com';
const sorts = new Set(['CURRENT_MIN_PRICE', 'YDAY_AVG_PRICE', 'RECENT_PRICE', 'GRADE']);
const invalid = () => new GuildError(400, 'invalid_market_request');
const unavailable = () => new GuildError(502, 'market_unavailable');
const limited = () => new GuildError(429, 'market_rate_limited');
const number = (value, max = Number.MAX_SAFE_INTEGER) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
const text = (value, max = 140) => typeof value === 'string' && value.length <= max
  ? value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim() : '';
const icon = value => typeof value === 'string' && value.length <= 2048 &&
  /^https:\/\/cdn-lostark\.game\.onstove\.com\/efui_iconatlas\/[A-Za-z0-9_./-]+\.(?:png|jpg|webp)$/i.test(value) && !value.includes('..') ? value : null;

export function normalizeMarketSearch(input = {}) {
  const kind = input.kind ?? 'market';
  const raw = input.query ?? '';
  if (!['market', 'gems'].includes(kind) || typeof raw !== 'string' || !raw.isWellFormed()) throw invalid();
  let query = raw.normalize('NFC').trim().replace(/ +/g, ' ');
  if (query.length > 60 || /[^가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9 '()·:+-]/u.test(query)) throw invalid();
  const category = Number(input.category ?? (kind === 'gems' ? 210000 : 50010));
  const page = Number(input.page ?? 1);
  const order = input.order ?? 'ASC';
  const sort = input.sort ?? (kind === 'gems' ? 'BUY_PRICE' : 'CURRENT_MIN_PRICE');
  if (!Number.isSafeInteger(category) || category < 0 || category > 999999 ||
      !Number.isSafeInteger(page) || page < 1 || page > 100 || !['ASC', 'DESC'].includes(order)) throw invalid();
  if (kind === 'gems') {
    const gem = parseGemSearch(query);
    if (!gem || !['BUY_PRICE', 'BIDSTART_PRICE', 'EXPIREDATE'].includes(sort)) throw invalid();
    query = `${gem.레벨}레벨 ${gem.종류}의 보석`;
    return { kind, query, category: 210000, page, sort, order };
  }
  if (!sorts.has(sort) || category === 0) throw invalid();
  return { kind, query, category, page, sort, order };
}

export function calculateMarketBid(priceInput, partyInput = 4) {
  const price = Number(priceInput);
  const partySize = Number(partyInput);
  if (!Number.isSafeInteger(price) || price < 1 || price > 1000000000 || ![4, 8, 16].includes(partySize)) throw invalid();
  return { price, partySize, feePercent: 5, preempt: Math.floor(preemptBid(price, partySize)),
    evenShare: Math.floor(evenShareBid(price, partySize)), resaleCap: Math.floor(resaleCap(price)) };
}

export function createMarketService({ config, fetchImpl = fetch, now = Date.now, cacheMs = 300000,
  maxEntries = 128, maxCacheBytes = 4 * 1024 * 1024, requestTimeoutMs = 8000,
  upstreamPerMinute = 20, concurrency = 2 } = {}) {
  const cache = new Map(), pending = new Map(), attempts = new Map(), starts = [], controllers = new Set(), queue = [];
  let active = 0, cacheBytes = 0, blockedUntil = 0, closed = false;
  function forget(key) { cacheBytes -= cache.get(key)?.bytes ?? 0; cache.delete(key); }
  // fresh=true는 캐시를 **읽지 않고** 새로 조회한다. 쓰기는 그대로 하므로 뒤 요청은 다시 캐시를 쓴다.
  // 불완전한 판을 받은 호출자가 회복 뒤 곧바로 다시 물어볼 수 있게 하기 위한 것이다.
  function share(key, operation, fresh = false) {
    if (closed) return Promise.reject(unavailable());
    const entry = cache.get(key);
    if (!fresh && entry?.until > now()) { cache.delete(key); cache.set(key, entry); return Promise.resolve(entry.value); }
    forget(key);
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 24) return Promise.reject(limited());
    const promise = Promise.resolve().then(operation).then(value => {
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (!closed && bytes <= maxCacheBytes) {
        cache.set(key, { value, bytes, until: now() + cacheMs }); cacheBytes += bytes;
        while (cache.size > maxEntries || cacheBytes > maxCacheBytes) forget(cache.keys().next().value);
      }
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  }
  function allow(ip) {
    const timestamp = now();
    for (const [key, value] of attempts) if (value.until <= timestamp) attempts.delete(key);
    let entry = attempts.get(ip);
    if (!entry) {
      if (attempts.size >= 10000) return false;
      entry = { count: 0, until: timestamp + 60000 }; attempts.set(ip, entry);
    }
    return ++entry.count <= 40;
  }
  function drain() {
    while (active < concurrency && queue.length) {
      const entry = queue.shift(); entry.signal.removeEventListener('abort', entry.abort);
      if (entry.signal.aborted) { entry.reject(unavailable()); continue; }
      active++; entry.resolve(() => { active--; drain(); });
    }
  }
  function acquire(signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted || closed) return reject(unavailable());
      if (queue.length >= 8) return reject(limited());
      const entry = { signal, resolve, reject };
      entry.abort = () => { const i = queue.indexOf(entry); if (i >= 0) queue.splice(i, 1); reject(unavailable()); };
      signal.addEventListener('abort', entry.abort, { once: true }); queue.push(entry); drain();
    });
  }
  async function request(path, body) {
    if (!config?.automaticApproval?.lostArkApiKey) throw new GuildError(503, 'market_unavailable');
    const controller = new AbortController(); controllers.add(controller);
    const signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    let release, reader;
    try {
      release = await acquire(signal); signal.throwIfAborted();
      const timestamp = now();
      while (starts.length && starts[0] <= timestamp - 60000) starts.shift();
      if (starts.length >= upstreamPerMinute || blockedUntil > timestamp) throw limited();
      starts.push(timestamp);
      const response = await fetchImpl(API + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal,
        headers: { Authorization: `bearer ${config.automaticApproval.lostArkApiKey}`, Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const reset = response.headers.get('x-ratelimit-reset');
      const until = /^\d{10}$/.test(reset || '') && Number(reset) * 1000 > timestamp && Number(reset) * 1000 < timestamp + 120000
        ? Number(reset) * 1000 : timestamp + 60000;
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (response.status === 429 || (/^\d+$/.test(remaining || '') && Number(remaining) <= 10)) blockedUntil = until;
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 429) throw limited();
        if (response.status === 404) throw new GuildError(404, 'market_not_found');
        throw unavailable();
      }
      if (response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '') ||
          Number(response.headers.get('content-length')) > 1048576 || !response.body) {
        void response.body?.cancel().catch(() => {}); throw unavailable();
      }
      reader = response.body.getReader();
      let size = 0; const chunks = [];
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 1048576) throw unavailable(); chunks.push(Buffer.from(value));
      }
      signal.throwIfAborted();
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch (error) {
      // The shared official transport may reject before a response is available.
      if (error?.status === 429) throw limited();
      if (error instanceof GuildError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer); controller.abort(); controllers.delete(controller);
      if (reader) void reader.cancel().catch(() => {}); release?.();
    }
  }
  function options() {
    return share('options', async () => {
      const raw = await request('/markets/options');
      if (!Array.isArray(raw?.Categories) || raw.Categories.length > 100) throw unavailable();
      const categories = [];
      const add = (row, parent = null) => {
        if (integer(row?.Code, 999999) === null || !text(row.CodeName, 60)) throw unavailable();
        categories.push({ code: row.Code, name: text(row.CodeName, 60), parent });
      };
      for (const row of raw.Categories) {
        add(row);
        if (row.Subs != null && (!Array.isArray(row.Subs) || row.Subs.length > 100)) throw unavailable();
        for (const child of row.Subs ?? []) add(child, row.Code);
      }
      if (categories.length > 500) throw unavailable();
      return { categories, updatedAt: now() };
    });
  }
  async function search(input, { fresh = false } = {}) {
    const params = normalizeMarketSearch(input);
    return share(`search:${JSON.stringify(params)}`, async () => {
      if (params.kind === 'market' && !(await options()).categories.some(row => row.code === params.category)) throw invalid();
      const gem = params.kind === 'gems';
      const body = { Sort: params.sort, CategoryCode: params.category, ItemName: params.query,
        PageNo: params.page, SortCondition: params.order, ItemGrade: null,
        ...(gem ? { ItemLevelMin: 0, ItemLevelMax: 0, ItemGradeQuality: null, ItemTier: 4 } : {}) };
      const raw = await request(gem ? '/auctions/items' : '/markets/items', body);
      if (integer(raw?.PageNo, 100) !== params.page || integer(raw.PageSize, 100) === null || raw.PageSize < 1 ||
          integer(raw.TotalCount, 1000000000) === null || (raw.Items !== null && !Array.isArray(raw.Items)) ||
          (raw.Items?.length ?? 0) > raw.PageSize || (raw.Items?.length ?? 0) > raw.TotalCount) throw unavailable();
      const items = (raw.Items ?? []).map((row, index) => {
        const name = text(row?.Name);
        if (!name || !text(row.Grade, 30)) throw unavailable();
        if (gem) {
          if (row.Name !== params.query || !row.AuctionInfo || typeof row.AuctionInfo !== 'object') throw unavailable();
          return { id: null, key: `gem-${params.page}-${index}`, name, grade: text(row.Grade, 30), icon: icon(row.Icon), bundleCount: 1,
            currentMinPrice: number(row.AuctionInfo.BuyPrice) > 0 ? row.AuctionInfo.BuyPrice : null,
            bidStartPrice: number(row.AuctionInfo.BidStartPrice), yDayAvgPrice: null, recentPrice: null, changePercent: null,
            options: (Array.isArray(row.Options) ? row.Options : []).slice(0, 16).map(option => ({
              name: text(option.OptionName, 100), className: text(option.ClassName, 40), value: number(option.Value), percent: option.IsValuePercentage === true,
            })).filter(option => option.name) };
        }
        if (integer(row.Id) === null || row.Id < 1 || integer(row.BundleCount, 1000000) === null || row.BundleCount < 1) throw unavailable();
        const current = number(row.CurrentMinPrice) > 0 ? row.CurrentMinPrice : null;
        const yesterday = number(row.YDayAvgPrice);
        const change = current !== null && yesterday > 0 ? (current - yesterday) / yesterday * 100 : null;
        return { id: row.Id, key: `${row.Id}-${integer(row.TradeRemainCount) ?? 'any'}-${index}`, name, grade: text(row.Grade, 30), icon: icon(row.Icon),
          bundleCount: row.BundleCount, tradeRemainCount: integer(row.TradeRemainCount), currentMinPrice: current,
          yDayAvgPrice: yesterday, recentPrice: number(row.RecentPrice), changePercent: Number.isFinite(change) ? Math.round(change * 100) / 100 : null };
      });
      return { ...params, items, totalCount: raw.TotalCount, pageSize: raw.PageSize,
        pageCount: Math.ceil(raw.TotalCount / raw.PageSize), updatedAt: now() };
    }, fresh);
  }
  function history(itemInput) {
    const id = Number(itemInput);
    if (!Number.isSafeInteger(id) || id < 1) return Promise.reject(invalid());
    return share(`history:${id}`, async () => {
      const raw = await request(`/markets/items/${id}`);
      if (raw === null || (Array.isArray(raw) && raw.length === 0)) throw new GuildError(404, 'market_not_found');
      if (!Array.isArray(raw) || raw.length > 30) throw unavailable();
      const variants = raw.map(row => {
        if (!text(row?.Name) || integer(row.BundleCount, 1000000) === null || row.BundleCount < 1 || !Array.isArray(row.Stats) || row.Stats.length > 60) throw unavailable();
        const history = row.Stats.map(stat => {
          if (typeof stat?.Date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(stat.Date) ||
              !Number.isFinite(Date.parse(stat.Date)) || new Date(stat.Date).toISOString().slice(0, 10) !== stat.Date ||
              number(stat.AvgPrice) === null || integer(stat.TradeCount) === null) throw unavailable();
          return { date: stat.Date, averagePrice: stat.AvgPrice, tradeCount: stat.TradeCount };
        }).sort((a, b) => a.date.localeCompare(b.date));
        if (new Set(history.map(row => row.date)).size !== history.length) throw unavailable();
        return { name: text(row.Name), bundleCount: row.BundleCount, tradeRemainCount: integer(row.TradeRemainCount), history };
      });
      return { id, variants, updatedAt: now() };
    });
  }
  function close() { closed = true; for (const controller of controllers) controller.abort(); cache.clear(); cacheBytes = 0; attempts.clear(); }
  return { options, search, history, calculateBid: calculateMarketBid, allow, close };
}
