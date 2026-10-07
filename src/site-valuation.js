// The bot shows the website's own numbers instead of repeating the calculation: the efficiency the
// character page displays and the expected acquisition gold ("뽑기 기댓값", highest record included) come
// from the web service's loopback-only bot endpoint (README.md). Without the
// shared token every lookup resolves to "unavailable" and the commands keep their fallbacks.
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const gold = (value) => (finite(value) && value >= 0 ? value : null);
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const PATH = '/internal/bot/character-values';
const ROSTER_PATH = '/internal/bot/roster-values';
const ROSTER_REFRESH_PATH = '/internal/bot/roster-values/refresh';
// The website answers at most this many anchors per request, so a large guild is asked in several rounds.
const ROSTER_CHUNK = 64;

export function createSiteValues({ fetchImpl = fetch, base = process.env.SITE_INTERNAL_URL || 'http://127.0.0.1:8090',
  token = process.env.BOT_INTERNAL_TOKEN, efficiencyTimeoutMs = 6000, valuationTimeoutMs = 12000, rosterTimeoutMs = 8000,
  // The first expected-value wait is short so the command answers quickly; Discord keeps polling afterwards.
  valuationWaitMs = Math.min(4000, valuationTimeoutMs) } = {}) {
  // Resolves to the parsed body, null when the site cannot answer, or 'timeout' when the wait ran out.
  async function call(path, { method = 'GET', query = null, payload = null, timeoutMs = rosterTimeoutMs } = {}) {
    if (typeof token !== 'string' || token.length < 32) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = new URL(path, base);
      for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
      const response = await fetchImpl(url, {
        method,
        headers: { 'X-Bot-Token': token, Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json' } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) return null;
      const data = await response.json();
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch (error) {
      return error?.name === 'AbortError' ? 'timeout' : null;
    } finally {
      clearTimeout(timer);
    }
  }

  // /환산가치: the stored 원정대 환산 가치 per registered character → Map(소문자 이름 → 앵커), or null when the site
  // answered nothing at all. A round that fails after earlier ones keeps what already arrived.
  async function getSiteRosterValues(names, { timeoutMs = rosterTimeoutMs } = {}) {
    const unique = [], seen = new Set();
    for (const name of names ?? []) {
      const key = typeof name === 'string' ? name.trim().toLowerCase() : '';
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(name.trim());
    }
    const values = new Map();
    for (let index = 0; index < unique.length; index += ROSTER_CHUNK) {
      const data = await call(ROSTER_PATH, { query: { names: unique.slice(index, index + ROSTER_CHUNK).join(',') }, timeoutMs });
      if (!data || data === 'timeout' || !Array.isArray(data.anchors)) return values.size > 0 ? values : null;
      for (const anchor of data.anchors) {
        if (anchor && typeof anchor === 'object' && typeof anchor.characterName === 'string') values.set(anchor.characterName.toLowerCase(), anchor);
      }
    }
    return values;
  }

  // The nightly job asks the website to recalculate; the answer only says whether the run started.
  async function requestRosterValueRefresh(names, { timeoutMs = rosterTimeoutMs } = {}) {
    const data = await call(ROSTER_REFRESH_PATH, { method: 'POST', payload: { names }, timeoutMs });
    return data && data !== 'timeout' && typeof data.status === 'string' ? data : null;
  }

  async function getRosterValueRefreshStatus({ timeoutMs = rosterTimeoutMs } = {}) {
    const data = await call(ROSTER_REFRESH_PATH, { timeoutMs });
    return data && data !== 'timeout' ? data : null;
  }

  // Resolves to the parsed body, null when the site cannot answer, or 'timeout' when the wait ran out.
  async function request(characterName, parts, timeoutMs) {
    if (typeof token !== 'string' || token.length < 32) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = new URL(PATH, base);
      url.searchParams.set('name', characterName);
      url.searchParams.set('parts', parts);
      const response = await fetchImpl(url, { headers: { 'X-Bot-Token': token, Accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
      if (!response.ok) return null;
      const data = await response.json();
      return typeof data?.characterName === 'string' && data.characterName.toLowerCase() === characterName.toLowerCase() ? data : null;
    } catch (error) {
      return error?.name === 'AbortError' ? 'timeout' : null;
    } finally {
      clearTimeout(timer);
    }
  }

  // { bracelet: { status, efficiency }, gem: { status, efficiency, optionEfficiency, pointEfficiency, effectEfficiencies } } or null.
  async function getSiteEfficiency(characterName) {
    const data = await request(characterName, 'efficiency', efficiencyTimeoutMs);
    const efficiency = data && data !== 'timeout' ? data.efficiency : null;
    return efficiency && typeof efficiency === 'object' ? efficiency : null;
  }

  // { status: 'done' | 'running' | 'unavailable', bracelet: { gold, record, reason }, gems: { gold, knownGold, items, known, reason } }
  async function getSiteValuation(characterName, { timeoutMs = valuationWaitMs } = {}) {
    const empty = { bracelet: { gold: null, record: false, reason: 'unavailable' }, gems: { gold: null, knownGold: null, items: 0, known: 0, reason: 'unavailable' } };
    const data = await request(characterName, 'valuation', timeoutMs);
    if (data === 'timeout') return { status: 'running', ...empty };
    const valuation = data?.valuation;
    if (!valuation || typeof valuation !== 'object') return { status: 'unavailable', ...empty };
    if (valuation.status === 'running') return { status: 'running', ...empty };
    if (valuation.status !== 'done') return { status: 'unavailable', ...empty };
    const bracelet = valuation.bracelet ?? {}, gems = valuation.gems ?? {};
    return {
      status: 'done',
      bracelet: { gold: gold(bracelet.gold), record: bracelet.record === true, reason: typeof bracelet.reason === 'string' ? bracelet.reason : null },
      gems: { gold: gold(gems.gold), knownGold: gold(gems.knownGold), items: count(gems.items), known: count(gems.known),
        reason: typeof gems.reason === 'string' ? gems.reason : null },
    };
  }

  // The character page's score, tier, best record and efficiencies for /포펙: the summary object, { status: 'running' } on timeout, null otherwise.
  async function getSiteSpec(characterName) {
    const data = await request(characterName, 'spec', valuationTimeoutMs);
    if (data === 'timeout') return { status: 'running' };
    const spec = data?.spec;
    return spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : null;
  }

  return { getSiteEfficiency, getSiteValuation, getSiteSpec, getSiteRosterValues, requestRosterValueRefresh, getRosterValueRefreshStatus };
}

// The shared client reads its settings when first used, after the bot has loaded its environment file.
let shared = null;
const client = () => (shared ??= createSiteValues());
export const getSiteEfficiency = (characterName) => client().getSiteEfficiency(characterName);
export const getSiteValuation = (characterName, options) => client().getSiteValuation(characterName, options);
export const getSiteRosterValues = (names, options) => client().getSiteRosterValues(names, options);
export const requestRosterValueRefresh = (names, options) => client().requestRosterValueRefresh(names, options);
export const getRosterValueRefreshStatus = (options) => client().getRosterValueRefreshStatus(options);

// Keeps asking the site while its job is still running, so a chat message can be updated once the number exists.
// Resolves with the finished valuation, or { status: 'timeout' } after the deadline.
export async function followSiteValuation(characterName, { getValuation = getSiteValuation, intervalMs = 4000, deadlineMs = 90000,
  pollTimeoutMs = 3000, setTimer = setTimeout, now = Date.now } = {}) {
  const started = now();
  while (now() - started < deadlineMs) {
    await new Promise((resolve) => setTimer(resolve, intervalMs));
    const value = await getValuation(characterName, { timeoutMs: pollTimeoutMs });
    if (value.status !== 'running') return value;
  }
  return { status: 'timeout', bracelet: { gold: null, record: false, reason: 'timeout' }, gems: { gold: null, knownGold: null, items: 0, known: 0, reason: 'timeout' } };
}
export const getSiteSpec = (characterName) => client().getSiteSpec(characterName);

export const DEVELOPMENT_NOTE = '기댓값은 개발 버전이라 정확하지 않을 수 있으며 결과가 나오지 않을 수 있습니다.';

export const goldText = (value) => `${Math.round(value).toLocaleString('ko-KR')} G`;

// 원정대 환산 가치는 억 단위가 흔해 자릿수를 다 적으면 한 줄이 넘친다 — 1억 이상은 `12.3억 G`, 1만 이상은 `9,800만 G`.
export function compactGoldText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return goldText(0);
  const size = Math.abs(value);
  if (size >= 100000000) return `${(value / 100000000).toFixed(1)}억 G`;
  if (size >= 10000) return `${Math.round(value / 10000).toLocaleString('ko-KR')}만 G`;
  return goldText(value);
}

// One line for the "기댓값" row of a command: gold (highest record marked), a partial sum, still calculating, or unavailable.
// live = the message will be edited when the site finishes (Discord); otherwise the reader has to ask again.
export function expectationText(valuation, part, { live = false } = {}) {
  if (valuation.status === 'running') return live ? '계산 중 · 끝나면 이 메시지를 갱신해요' : '계산 중 · 잠시 후 다시 조회해 주세요';
  if (valuation.status === 'timeout') return '계산이 오래 걸려요 · 잠시 후 다시 조회해 주세요';
  const entry = valuation[part];
  if (entry?.gold !== null && entry?.gold !== undefined) return `${goldText(entry.gold)}${entry.record ? ' · 최고 기록' : ''}`;
  if (part === 'gems' && entry?.knownGold !== null && entry?.knownGold !== undefined && entry.known > 0) {
    return `${goldText(entry.knownGold)} (${entry.items}개 중 ${entry.known}개만 계산)`;
  }
  if (part === 'bracelet' && entry?.reason === 'no_bracelet') return '팔찌 없음';
  if (part === 'bracelet' && entry?.reason === 'no_matching_listings') return '경매장에 비슷한 매물 없음';
  if (entry?.reason === 'rate_limited') return '조회가 많아요 · 잠시 후 다시 조회해 주세요';
  return '확인 불가';
}
