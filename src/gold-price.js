// /골드시세 — 게임비트(중개 사이트) 서버별 골드 시세. 1만 골드당 원으로 지금 가격을 적고 전일 대비 변동을 붙인다.
// 홈페이지 「골드 시세 추이」와 같은 자료(게임비트 일봉)를 봇이 직접 읽는다. 일봉의 마지막 봉이 오늘 진행 중인
// 가격이므로 그 값을 그대로 쓰고, 바로 앞 날의 종가와 견준다(사용자 결정 2026-09-19).
export const GOLD_SERVERS = Object.freeze([
  { id: 'silian', name: '실리안', sid: '1845' },
  { id: 'karmine', name: '카마인', sid: '1848' },
  { id: 'kadan', name: '카단', sid: '1850' },
  { id: 'kazeros', name: '카제로스', sid: '1849' },
  { id: 'lupeon', name: '루페온', sid: '1844' },
  { id: 'ninav', name: '니나브', sid: '2072' },
  { id: 'aman', name: '아만', sid: '1846' },
  { id: 'abrelshud', name: '아브렐슈드', sid: '1847' },
].map(Object.freeze));
export const SOURCE_NAME = '게임비트';
export const BOARD_TITLE = '중개 사이트 기준 (전일기준/10,000당)';
export const FAILED_LINE = '조회 실패';
const CHART_URL = (sid) => `https://gamebit.co.kr/v3_get_chart_data.php?game=lostark&sid=${sid}&type=day`;
const USER_AGENT = 'Pogeunhaeyong/1.3 (+https://opentalk.example.invalid/)';
const KST = 9 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const BODY_MAX = 256 * 1024;

const kstDate = (ms) => new Date(ms + KST).toISOString().slice(0, 10);
const price = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1e8;

// 게임비트 일봉 응답을 검증해 날짜 오름차순 [{ time, date, close }]로. 형태가 조금이라도 다르면 실패로 본다.
export function normalizeDayRows(value, timestamp) {
  if (!Array.isArray(value) || !value.length || value.length > 400) throw new Error('unexpected chart shape');
  const seen = new Set();
  const rows = value.map((row) => {
    if (!row || !Number.isSafeInteger(row.time) || row.time < 1577804400 || row.time * 1000 > timestamp + DAY
      || (row.time + 9 * 3600) % 86400 !== 0 || !price(row.close) || seen.has(row.time)) throw new Error('unexpected chart row');
    seen.add(row.time);
    return { time: row.time * 1000, date: kstDate(row.time * 1000), close: row.close };
  });
  return rows.sort((a, b) => a.time - b.time);
}

// 지금 가격(마지막 봉)과 전일 종가 대비 변동. 바로 앞 날의 봉이 없으면(자료 구멍) 변동은 비운다.
export function pickCurrent(rows) {
  const latest = rows.at(-1);
  if (!latest) return null;
  const before = rows.at(-2);
  const shown = Math.round(latest.close);
  const consecutive = before && latest.time - before.time === DAY;
  return { date: latest.date, price: shown, diff: consecutive ? shown - Math.round(before.close) : null };
}

// 한 줄: "• 실리안: 755원 (📉 3)". 오른 날만 📈, 내리거나 그대로면 📉(변동 0 포함). 전날 봉이 없으면 변동을 비운다.
export function boardLine(entry) {
  if (!entry || entry.error) return `• ${entry?.name ?? '?'}: ${FAILED_LINE}`;
  const diff = entry.diff === null ? '' : ` (${entry.diff > 0 ? '📈' : '📉'} ${Math.abs(entry.diff)})`;
  return `• ${entry.name}: ${entry.price.toLocaleString('ko-KR')}원${diff}`;
}
export const boardLines = (board) => board.servers.map(boardLine);

export function createGoldPriceBoard({ fetchImpl = fetch, now = Date.now, ttlMs = 5 * 60 * 1000, timeoutMs = 6000, concurrency = 4 } = {}) {
  let cached = null, pending = null;

  async function fetchServer(server) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(CHART_URL(server.sid), {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > BODY_MAX) throw new Error('chart too large');
      const timestamp = now();
      const picked = pickCurrent(normalizeDayRows(JSON.parse(text), timestamp));
      if (!picked) throw new Error('no chart rows');
      return { name: server.name, ...picked };
    } finally {
      clearTimeout(timer);
    }
  }

  async function load() {
    const servers = new Array(GOLD_SERVERS.length);
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, GOLD_SERVERS.length) }, async () => {
      while (index < GOLD_SERVERS.length) {
        const at = index++;
        const server = GOLD_SERVERS[at];
        try { servers[at] = await fetchServer(server); } catch { servers[at] = { name: server.name, error: true }; }
      }
    }));
    const ok = servers.filter((row) => !row.error);
    // 가격 날짜는 서버마다 같아야 정상이다. 다르면(자정 직후 등) 가장 늦은 날짜를 적는다.
    const date = ok.length ? ok.map((row) => row.date).sort().at(-1) : null;
    return { servers, date, fetchedAt: now(), complete: ok.length === servers.length };
  }

  // 완전한 판만 5분 캐시. 일부 서버가 실패한 판은 보여 주되 다음 요청에서 다시 읽는다.
  async function get() {
    if (cached && cached.until > now()) return cached.board;
    if (pending) return pending;
    pending = load().then((board) => {
      if (board.complete) cached = { until: now() + ttlMs, board };
      return board;
    }).finally(() => { pending = null; });
    return pending;
  }

  return { get, clear() { cached = null; } };
}

export const goldPriceBoard = createGoldPriceBoard();
