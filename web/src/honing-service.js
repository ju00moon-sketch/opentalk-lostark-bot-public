// 도구 화면의 재련 최저 비용 계산기.
// 봇의 `/강화`와 같은 계산기(`src/honing-optimizer.js`)를 쓰고 시세만 웹의 거래소 조회로 받는다.
// 스펙업과 달리 격리 계산이 없어 웹이 직접 계산한다 — 봇이 꺼져 있어도 이 화면은 돈다.
import { optimizeHoning, WALK_LIMIT } from '../../src/honing-optimizer.js';
import { BREATH_NAMES, BOOK_NAMES, BOOST_MODEL } from '../../src/data/honing-boost.js';
import { HONING_MODEL } from '../../src/data/honing-valuation.js';
import { GuildError } from './guild-store.js';

// 경로가 market 밑에 있는 이유: Nginx가 웹으로 넘기는 것은 /api/auth/ · /api/character/ · /api/market/ 뿐이다.
// 다른 자리에 두면 정적 파일로 떨어져 404가 된다(2026-09-21 실측).
export const HONING_PATH = '/api/market/honing';
const SHARD_BAG = '운명의 파편 주머니(대)';
const SHARDS_PER_BAG = 3000;
const KINDS = ['weapon', 'armor'];
const STAGE_MAX = 25;
const CACHE_MS = 5 * 60 * 1000;
const RESPONSE_BYTES = 1024 * 1024;

const REQUIRED = Object.freeze(['운명의 파괴석', '운명의 수호석', '운명의 돌파석', '아비도스 융화 재료', SHARD_BAG]);
const WANTED = new Set([...REQUIRED, ...Object.values(BREATH_NAMES),
  ...Object.values(BOOK_NAMES).flatMap(byKind => Object.values(byKind).flatMap(Object.values))]);
const QUERIES = Object.freeze([
  { category: 50010, query: '운명의' }, { category: 50010, query: '아비도스 융화' },
  { category: 50020, query: '숨결' }, { category: 50020, query: '야금술' }, { category: 50020, query: '재봉술' },
]);

// 화면이 쓰는 값만 넘긴다. 회차별 계획을 앞 열 줄로 자르면 그 뒤의 선택 전환이 사라져
// 화면이 「그 뒤로 계속 같다」고 잘못 말하게 된다. 그래서 자르지 않고, 전체 계획에서 만든
// **구간**(같은 선택이 이어지는 묶음)을 넘긴다 — 회차가 수백이어도 구간은 몇 개뿐이다.
const trimStage = stage => ({
  from: stage.from, to: stage.to, successBps: stage.successBps,
  expectedGold: stage.expectedGold, plainGold: stage.plainGold, expectedAttempts: stage.expectedAttempts,
  breathName: stage.breathName, bookName: stage.bookName,
  firstSuccessBps: stage.plan[0]?.successBps ?? stage.successBps,
  maximumAttempts: stage.plan.length,
  segments: stage.segments.map(segment => ({ from: segment.from, to: segment.to, breath: segment.breath,
    book: segment.book, guaranteed: segment.guaranteed, reachProbability: segment.reachProbability })),
  details: stage.details,
});

export function normalizeHoningRequest(input = {}) {
  const kind = input.kind;
  const from = Number(input.from), to = Number(input.to);
  if (!KINDS.includes(kind) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to)
    || from < 0 || to > STAGE_MAX || to <= from) throw new GuildError(400, 'invalid_request');
  return { kind, from, to };
}

export function createHoningService({ market, now = Date.now, cacheMs = CACHE_MS, maxResponseBytes = RESPONSE_BYTES } = {}) {
  let cache = null, cachedAt = 0, inFlight = null;
  // 우리 쪽에서 불완전한 판을 캐시하지 않아도, 하위 market.search가 정상 형식의 빈 결과를
  // 5분 캐시하면 시세가 회복돼도 그 시간 동안 계속 503이 된다. 그래서 불완전했던 다음 조회는
  // 하위 캐시를 읽지 않게(fresh) 요청한다 — 「다음 요청에서 다시 조회」를 실제로 지키기 위해서다.
  let refetch = false;

  async function fetchPrices(fresh) {
    const board = new Map(), sources = new Map();
    for (const { category, query } of QUERIES) {
      for (let page = 1; page <= 3; page++) {
        const result = await market.search({ kind: 'market', category, query, page }, { fresh });
        const items = result?.items ?? [];
        for (const item of items) {
          if (!WANTED.has(item.name) || board.has(item.name)) continue;
          const bundle = item.bundleCount > 0 ? item.bundleCount : 1;
          if (Number.isFinite(item.currentMinPrice) && item.currentMinPrice > 0) {
            board.set(item.name, item.currentMinPrice / bundle);
            sources.set(item.name, { source: 'market_bundle', sourceItemName: item.name,
              sourceBundleCount: bundle, sourceBundleGold: item.currentMinPrice, divisor: bundle });
          }
        }
        if (!items.length || page * (result.pageSize ?? items.length) >= (result.totalCount ?? 0)) break;
      }
    }
    const bag = board.get(SHARD_BAG);
    if (bag !== undefined) {
      board.set('운명의 파편', bag / SHARDS_PER_BAG);
      const source = sources.get(SHARD_BAG);
      sources.set('운명의 파편', { ...source, source: 'shard_bag', divisor: source.sourceBundleCount * SHARDS_PER_BAG });
    }
    return { board, sources };
  }

  // 항목이 하나라도 빠진 판은 캐시하지 않는다 — 5분 동안 「시세 없음」이 굳지 않게 다음 요청에서 다시 조회한다.
  function prices() {
    if (cache && now() - cachedAt <= cacheMs) return Promise.resolve({ ...cache, at: cachedAt });
    inFlight ??= fetchPrices(refetch)
      .then(({ board, sources }) => {
        const at = now();
        const complete = REQUIRED.every(name => board.has(name));
        if (complete) { cache = { board, sources }; cachedAt = at; }
        refetch = !complete;
        return { board, sources, at };
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    async get(input) {
      const { kind, from, to } = normalizeHoningRequest(input);
      const { board, sources, at } = await prices();
      const missing = REQUIRED.filter(name => !board.has(name));
      if (missing.length) throw new GuildError(503, 'honing_prices_unavailable');
      const result = optimizeHoning({ kind, from, to, priceOf: name => board.get(name) ?? null, includeDetails: true });
      if (!result || result.status !== 'ok') throw new GuildError(503, result?.reason ?? 'honing_unavailable');
      const names = new Set(result.stages.flatMap(stage => stage.details.materials.map(row => row.name)));
      const response = { kind, from, to, pricedAt: at, updatedAt: now(),
        expectedGold: result.expectedGold, plainGold: result.plainGold, notes: result.notes,
        stages: result.stages.map(trimStage),
        materials: Object.fromEntries([...WANTED].filter(name => board.has(name)).map(name => [name, board.get(name)])),
        details: { version: 1,
          model: { honingVersion: HONING_MODEL.version, boostVersion: BOOST_MODEL.version,
            artisanCoefficient: HONING_MODEL.artisan.coefficient, artisanResolution: HONING_MODEL.artisan.resolution,
            distributionMethod: 'finite_plan', distributionScope: 'stage' },
          totals: { expectedGold: result.expectedGold,
            expectedAttempts: result.stages.reduce((sum, stage) => sum + stage.expectedAttempts, 0),
            worstCaseGold: result.stages.reduce((sum, stage) => sum + stage.details.worstCase.gold, 0),
            maximumAttempts: result.stages.reduce((sum, stage) => sum + stage.plan.length, 0) },
          prices: [...names].map(name => ({ name, unit: name === '골드' ? 'gold' : 'item',
            unitGold: name === '골드' ? 1 : board.get(name) ?? null,
            ...(name === '골드' ? { source: 'fixed_gold', sourceItemName: '골드', sourceBundleCount: null, sourceBundleGold: null, divisor: null }
              : sources.get(name) ?? { source: 'market_bundle', sourceItemName: name, sourceBundleCount: null, sourceBundleGold: null, divisor: null }) })),
          pricedAt: at, priceTimeBasis: 'price_collection_completed', planDelivery: 'complete',
          limits: { responseBytes: RESPONSE_BYTES, attemptsPerStage: WALK_LIMIT, stages: STAGE_MAX } } };
      // JSON은 비유한 수를 null로 바꾸므로 직렬화 전에 잘못된 집계를 거절한다.
      const serialize = () => JSON.stringify(response, (_key, value) => {
        if (typeof value === 'number' && !Number.isFinite(value)) throw new GuildError(503, 'honing_unavailable');
        return value;
      });
      const limit = Math.min(RESPONSE_BYTES, maxResponseBytes);
      if (Buffer.byteLength(serialize()) > limit) {
        for (const stage of response.stages) stage.details.plan = null;
        response.details.planDelivery = 'omitted_size_limit';
        if (Buffer.byteLength(serialize()) > limit) throw new GuildError(503, 'honing_unavailable');
      }
      return response;
    },
    close() { cache = null; inFlight = null; },
  };
}
