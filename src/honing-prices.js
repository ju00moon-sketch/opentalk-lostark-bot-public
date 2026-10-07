// 재련 최저 비용 계산에 필요한 거래소 시세를 한 번에 모은다.
// `/쌀`과 같은 방식으로 이름 부분 검색을 써서 호출 수를 줄이고, 완전한 판만 5분 캐시한다.
// 파편은 낱개로 팔지 않으므로 주머니(대) 1개 = 3,000개로 환산한다(기존 환산 가치 모델과 같은 기준).
import { searchMarketItems } from './lostark.js';
import { BREATH_NAMES, BOOK_NAMES } from './data/honing-boost.js';

const CACHE_TTL = 5 * 60 * 1000;
const SHARDS_PER_BAG = 3000;
const SHARD_BAG = '운명의 파편 주머니(대)';

// 계산에 반드시 있어야 하는 재료 — 하나라도 빠지면 캐시하지 않고 다음 요청에서 다시 조회한다.
export const REQUIRED_NAMES = Object.freeze([
  '운명의 파괴석', '운명의 수호석', '운명의 돌파석', '아비도스 융화 재료', SHARD_BAG,
]);
const BOOST_NAMES = Object.freeze([
  ...Object.values(BREATH_NAMES),
  ...[...new Set(Object.values(BOOK_NAMES).flatMap(byKind => Object.values(byKind).flatMap(Object.values)))],
]);
const WANTED = new Set([...REQUIRED_NAMES, ...BOOST_NAMES]);

const QUERIES = Object.freeze([
  { category: 50010, name: '운명의' },
  { category: 50010, name: '아비도스 융화' },
  { category: 50020, name: '숨결' },
  { category: 50020, name: '야금술' },
  { category: 50020, name: '재봉술' },
]);

export function createHoningPrices({ search = searchMarketItems, now = Date.now, ttlMs = CACHE_TTL } = {}) {
  let cache = null, cachedAt = 0, inFlight = null;

  async function fetchPrices() {
    const board = new Map();
    for (const { category, name } of QUERIES) {
      // 한 쪽은 10개. 검색 묶음이 그보다 크면 다음 쪽까지 읽는다.
      for (let page = 1; page <= 3; page++) {
        const result = await search(category, name, { page });
        for (const item of result?.Items ?? []) {
          if (!WANTED.has(item.Name) || board.has(item.Name)) continue;
          const bundle = item.BundleCount > 0 ? item.BundleCount : 1;
          // 0·null·NaN·음수 최저가는 「매물 없음」이지 공짜가 아니다. 웹 market-service와 같은 기준으로 건너뛴다.
          const price = Number(item.CurrentMinPrice);
          if (!Number.isFinite(price) || price <= 0) continue;
          board.set(item.Name, price / bundle);
        }
        if (page * (result?.PageSize ?? 10) >= (result?.TotalCount ?? 0)) break;
      }
    }
    const bag = board.get(SHARD_BAG);
    if (Number.isFinite(bag) && bag > 0) board.set('운명의 파편', bag / SHARDS_PER_BAG);
    return board;
  }

  function board() {
    if (cache && now() - cachedAt <= ttlMs) return Promise.resolve({ board: cache, at: cachedAt });
    inFlight ??= fetchPrices()
      .then(values => {
        const at = now();
        if (REQUIRED_NAMES.every(name => values.has(name))) { cache = values; cachedAt = at; }
        return { board: values, at };
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    async load() {
      const { board: values, at } = await board();
      const missing = REQUIRED_NAMES.filter(name => !values.has(name));
      return { at, missing, priceOf: name => values.get(name) ?? null, has: name => values.has(name) };
    },
  };
}

export const honingPrices = createHoningPrices();
export const __test = { QUERIES, BOOST_NAMES };
