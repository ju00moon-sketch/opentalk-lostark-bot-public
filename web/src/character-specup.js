// 캐릭터 화면 스펙업 탭이 읽는 판(README.md).
// 계산은 봇만 할 수 있어(격리 계정 래퍼·크리스탈 시세 파일) 같은 기기의 봇에게 루프백으로 물어본다.
// 봇은 기다리지 않고 running을 주므로 화면이 다시 묻는다. 홈페이지에는 결과를 저장하지 않는다.
// 봇이 준 판은 한 줄이라도 어긋나면 통째로 버린다 — 반쯤 맞는 값을 화면에 흘려보내지 않는다.
import { isValidPrice } from '../../src/crystal-price.js';

export const CHARACTER_SPECUP_PATH = '/api/auth/character/specup';
const BOT_PATH = '/internal/site/specup';
const STATUSES = ['running', 'done', 'unavailable', 'busy'];
const GAIN_SOURCES = ['model', 'lopec'];
const PRICE_SOURCES = ['api', 'lopec', 'fixed'];
const GEM_TYPES = ['피해', '쿨감'];
const ROW_LIMIT = 200;
const TEXT_LIMIT = 300;
const KIND_LIMIT = 20;

const text = (value, limit = TEXT_LIMIT) => (typeof value === 'string' && value.trim() && value.length <= limit ? value : null);
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const stamp = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
// 상한을 부르는 곳마다 적는다 — 하나로 묶었다가 크리스탈 시세처럼 범위가 다른 값이 조용히 걸린 적이 있다.
const count = (value, max) => (Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null);
const ELAPSED_MAX = 10 * 60 * 1000; // 대기 30초 + 계산 수명 60초보다 넉넉하게
const DROPPED_MAX = 100_000;

// 보석 행의 변경 내용. 없으면 undefined, 모양이 어긋나면 null로 판 전체를 버리게 한다.
function normalizeGem(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const skill = text(value.skill, 60);
  const from = count(value.from, 10), to = count(value.to, 10);
  if (!skill || !GEM_TYPES.includes(value.type) || from === null || to === null) return null;
  return { skill, type: value.type, from, to };
}

function normalizeRow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const option = text(value.option);
  const gainPercent = finite(value.gainPercent), finalScore = finite(value.finalScore);
  const expectedCost = finite(value.expectedCost);
  const gem = normalizeGem(value.gem);
  // per100k는 진짜 무료(비용 0)인 행에서 null이다. 그 외에는 숫자여야 한다.
  const per100k = value.per100k === null ? null : finite(value.per100k);
  // kind는 로펙이 주는 분류 글자를 그대로 보여 준다. 정해진 목록으로 묶으면 종류가 하나 늘 때 판 전체가 버려진다.
  const kind = text(value.kind, KIND_LIMIT);
  if (!kind || !option || gainPercent === null || finalScore === null ||
    expectedCost === null || expectedCost < 0 || gem === null ||
    !GAIN_SOURCES.includes(value.gainSource) || !PRICE_SOURCES.includes(value.priceSource) ||
    (expectedCost === 0 ? per100k !== null : per100k === null)) return null;
  return { kind, option, gainPercent, gainSource: value.gainSource, finalScore,
    expectedCost, per100k, priceSource: value.priceSource, ...(gem ? { gem } : {}) };
}

function normalizeGuide(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.rows) ||
    value.rows.length > ROW_LIMIT) return null;
  const baseScore = finite(value.baseScore);
  const droppedForPrice = count(value.droppedForPrice, DROPPED_MAX);
  const pricedAt = value.pricedAt === null ? null : stamp(value.pricedAt);
  const crystalPrice95 = value.crystalPrice95 === null ? null : (isValidPrice(value.crystalPrice95) ? value.crystalPrice95 : null);
  if (baseScore === null || baseScore <= 0 || droppedForPrice === null || typeof value.priceStale !== 'boolean' ||
    (pricedAt === null && value.pricedAt !== null) ||
    (crystalPrice95 === null && value.crystalPrice95 !== null)) return null;
  const rows = [];
  for (const entry of value.rows) {
    const row = normalizeRow(entry);
    if (!row) return null;
    rows.push(row);
  }
  return { baseScore, pricedAt, priceStale: value.priceStale, droppedForPrice, crystalPrice95, rows };
}

function normalizeCrystal(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const at = value.at === null || value.at === undefined ? null : stamp(value.at);
  if (!isValidPrice(value.price95) || (at === null && value.at !== null && value.at !== undefined)) return undefined;
  return { price95: value.price95, at, source: value.source === 'auto' ? 'auto' : 'manual' };
}

// 봇 응답을 화면이 그대로 쓸 수 있는 모양으로만 받아들인다.
export function normalizeSpecupAnswer(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !STATUSES.includes(value.status)) return null;
  if (value.status === 'busy') return { status: 'busy' };
  if (value.name !== name || stamp(value.startedAt) === null) return null;
  if (value.status === 'running') {
    const elapsedMs = count(value.elapsedMs, ELAPSED_MAX);
    return elapsedMs === null ? null : { status: 'running', startedAt: value.startedAt, elapsedMs };
  }
  const finishedAt = stamp(value.finishedAt);
  if (finishedAt === null) return null;
  if (value.status === 'unavailable') return { status: 'unavailable', startedAt: value.startedAt, finishedAt };
  const guide = normalizeGuide(value.guide);
  const crystal = normalizeCrystal(value.crystal);
  if (!guide || crystal === undefined) return null;
  return { status: 'done', startedAt: value.startedAt, finishedAt, guide, crystal };
}

export function createCharacterSpecupService({ fetchImpl = fetch, base = process.env.BOT_INTERNAL_URL || 'http://127.0.0.1:8080',
  token = null, now = Date.now, timeoutMs = 6000 } = {}) {
  const offline = () => ({ status: 'offline', checkedAt: now() });
  return {
    // 토큰을 공유하지 않은 환경에서는 봇에 묻지 않고 바로 조회 불가로 답한다.
    async read(name) {
      if (typeof token !== 'string' || token.length < 32) return offline();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const url = new URL(BOT_PATH, base);
        url.searchParams.set('name', name);
        const response = await fetchImpl(url, {
          headers: { 'X-Bot-Token': token, Accept: 'application/json' }, signal: controller.signal, redirect: 'error',
        });
        if (!response.ok) return offline();
        const answer = normalizeSpecupAnswer(await response.json(), name);
        return answer ? { ...answer, checkedAt: now() } : offline();
      } catch {
        return offline();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
