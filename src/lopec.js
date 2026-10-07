// lopec.kr에서 공식 API에 없는 지표를 가져온다 (환산 점수·순위·팔찌 효율).
// 서버 렌더링된 HTML을 읽으므로 사이트 개편에 깨질 수 있다. 실패하면 null을 돌려주고
// 커맨드는 해당 부분만 빼고 정상 출력한다.
const BASE_URL = 'https://lopec.kr';
const CACHE_MS = 5 * 60 * 1000;

const pageCache = new Map();
const pageInFlight = new Map();
const efficiencyCache = new Map();

export const BACKSLASH = String.fromCharCode(92);

// Public callers share one bounded transport with the existing bot queries.
export function createLopecTextFetcher({ fetchImpl = (url, init) => fetch(url, init), timeoutMs = 15000, maxBytes = 8 * 1024 * 1024,
  concurrency = 4, maxWaiting = 32 } = {}) {
  let active = 0;
  const waiting = [];
  const drain = () => {
    while (active < concurrency && waiting.length) {
      const entry = waiting.shift();
      entry.signal.removeEventListener('abort', entry.abort);
      if (entry.signal.aborted) continue;
      active++;
      entry.resolve(() => { active--; drain(); });
    }
  };
  return async function readText(url, { signal: parent } = {}) {
    const target = new URL(url);
    if (target.origin !== BASE_URL || target.username || target.password || target.hash) throw new Error('Invalid source URL');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    let release, reader;
    try {
      signal.throwIfAborted();
      release = await new Promise((resolve, reject) => {
        if (waiting.length >= maxWaiting) return reject(new Error('Source queue is full'));
        const entry = { resolve, signal, abort: null };
        entry.abort = () => { const index = waiting.indexOf(entry); if (index >= 0) waiting.splice(index, 1); reject(new Error('Source request expired')); };
        signal.addEventListener('abort', entry.abort, { once: true });
        waiting.push(entry); drain();
      });
      signal.throwIfAborted();
      const res = await fetchImpl(target.href, { redirect: 'error',
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; OpenTalkBot/1.0)' }, signal });
      if (!res.ok || res.redirected || !res.body || Number(res.headers.get('content-length')) > maxBytes) {
        void res.body?.cancel().catch(() => {}); throw new Error('Source response unavailable');
      }
      reader = res.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error('Source response is too large');
        chunks.push(Buffer.from(value));
      }
      signal.throwIfAborted();
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } finally {
      clearTimeout(timer); controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      release?.();
    }
  };
}
export const fetchText = createLopecTextFetcher();

function rememberPage(key, value) {
  const timestamp = Date.now();
  for (const [name, entry] of pageCache) if (timestamp - entry.at >= CACHE_MS) pageCache.delete(name);
  pageCache.delete(key);
  pageCache.set(key, { ...value, at: timestamp, bytes: Buffer.byteLength(JSON.stringify(value)) });
  let bytes = [...pageCache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  while (pageCache.size > 128 || bytes > 32 * 1024 * 1024) {
    const first = pageCache.keys().next().value;
    bytes -= pageCache.get(first).bytes;
    pageCache.delete(first);
  }
}

// 공개 시세는 JSON 데이터로만 읽는다. 실패는 호출자가 처리하고 캐시하지 않는다.
async function lopecPriceJson(path, field, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`로펙 시세 API 오류 (HTTP ${res.status})`);
  const data = await res.json();
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(data) || !record(data.snapshot) || !record(data.snapshot[field])
    || (data.snapshot.snapshotId != null && typeof data.snapshot.snapshotId !== 'string')
    || (data.isStale != null && typeof data.isStale !== 'boolean')
    || (data.staleReason != null && typeof data.staleReason !== 'string')) {
    throw new Error('로펙 시세 응답 형식 오류');
  }
  return data;
}

export const getLopecEnhancementSnapshot = () => lopecPriceJson('/api/auction/enhancement', 'prices');
export const postLopecAuctionPrices = (targets) => lopecPriceJson('/api/auction/prices', 'pricesByTarget', { targets });

// 문자열과 중첩 괄호를 건너뛰며 여는 괄호의 짝을 찾는다.
export function matchBrace(source, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === BACKSLASH) i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Next.js가 조각내어 심어 둔 flight 페이로드를 원래 문자열로 이어 붙인다.
export function flightPayload(html) {
  const marker = 'self.__next_f.push([1,"';
  let payload = '';
  let cursor = 0;
  for (;;) {
    const start = html.indexOf(marker, cursor);
    if (start === -1) break;
    let i = start + marker.length;
    let raw = '';
    while (i < html.length && html[i] !== '"') {
      if (html[i] === BACKSLASH) {
        raw += html[i] + html[i + 1];
        i += 2;
        continue;
      }
      raw += html[i];
      i += 1;
    }
    try {
      payload += JSON.parse(`"${raw}"`);
    } catch {
      // 조각 하나가 깨져도 나머지로 계속 시도한다
    }
    cursor = i + 1;
  }
  return payload;
}

// key 바로 뒤에 오는 객체를 파싱한다 (예: '"lostarkParser":').
export function objectAfter(payload, key) {
  const at = payload.indexOf(key);
  if (at === -1) return null;
  const open = payload.indexOf('{', at);
  const close = matchBrace(payload, open);
  if (close === -1) return null;
  try {
    return JSON.parse(payload.slice(open, close + 1));
  } catch {
    return null;
  }
}

// Flight의 JSON 레코드를 데이터로만 읽는다. 필드 순서와 컴포넌트 번호에 의존하지 않는다.
function flightObjects(payload) {
  const objects = [];
  const bytes = Buffer.from(payload, 'utf8');
  let cursor = 0;
  while (cursor < bytes.length) {
    const colon = bytes.indexOf(58, cursor);
    const framed = colon >= cursor && /^[\da-f]+$/i.test(bytes.toString('utf8', cursor, colon));
    const start = framed ? colon + 1 : cursor;
    // 긴 툴팁 등의 T 프레임은 UTF-8 바이트 수로 끝나며 다음 레코드가 바로 이어질 수 있다.
    if (framed && bytes[start] === 84) {
      const comma = bytes.indexOf(44, start);
      const rawLength = bytes.toString('utf8', start + 1, comma);
      if (comma < 0 || !/^[\da-f]+$/i.test(rawLength)) break;
      const end = comma + 1 + Number.parseInt(rawLength, 16);
      if (end > bytes.length) break;
      cursor = end;
      continue;
    }
    const newline = bytes.indexOf(10, start);
    const end = newline < 0 ? bytes.length : newline;
    const json = bytes.toString('utf8', start, end);
    cursor = end + 1;
    let root;
    try { root = JSON.parse(json); } catch { continue; }
    const stack = [root];
    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== 'object') continue;
      if (!Array.isArray(value)) objects.push(value);
      stack.push(...Object.values(value).reverse());
    }
  }
  return objects;
}

const scoreNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const characterKey = (name) => typeof name === 'string' ? name.normalize('NFC').toLowerCase() : null;
function decodedCharacter(name) {
  try { return characterKey(decodeURIComponent(name)); } catch { return null; }
}

// 현재 페이지는 프로필·현재 점수·최고 점수·후속 순위 자료를 서로 다른 레코드로 보낸다.
// 예전의 통합 요약도 지원하며, 현재 점수로 달성 최고 점수를 대신하지 않는다.
export function parseLopecScoreHtml(html, characterName) {
  const payload = flightPayload(html);
  const objects = flightObjects(payload);
  const name = characterKey(characterName);
  if (!name) return null;
  const main = objects.find((o) => characterKey(o.lostarkParser?.profile?.nickName) === name);
  const legacy = objects.find((o) => characterKey(o.name) === name && Object.hasOwn(o, 'specPoint'));
  const profile = main?.lostarkParser.profile;
  const point = objects.find((o) => typeof o.encodedName === 'string' && decodedCharacter(o.encodedName) === name
    && scoreNumber(o.specPoint) !== null);
  const summary = profile ? {
    name: profile.nickName,
    firstClass: profile.class,
    secondClass: profile.secondClass,
    supportCheck: profile.supportCheck,
    itemLevel: profile.itemLevel,
    server: profile.server,
    guild: profile.guild,
    profileImage: profile.image,
    specPoint: point?.specPoint,
  } : legacy;
  if (!summary?.firstClass || typeof summary.supportCheck !== 'boolean'
      || scoreNumber(summary.itemLevel) === null || scoreNumber(summary.specPoint) === null) return null;

  const latestNumber = (key) => objects.findLast((o) => scoreNumber(o[key]) !== null)?.[key] ?? null;
  const supplement = objects.findLast((o) => o.profileSupplement && typeof o.profileSupplement === 'object'
    && !Array.isArray(o.profileSupplement))?.profileSupplement;
  const cards = objects.findLast((o) => o.cardData && typeof o.cardData === 'object'
    && !Array.isArray(o.cardData))?.cardData ?? null;
  return {
    ...summary,
    ...(supplement ?? {}),
    combatPower: main?.lostarkParser.stats?.combatPower ?? objectAfter(payload, '"stats":')?.combatPower ?? null,
    dbScore: main ? scoreNumber(main.dbScore) : latestNumber('dbScore'),
    median: latestNumber('nowMedian'),
    gemMedian: latestNumber('arkgridGemMedian'),
    cardData: cards,
  };
}

// 캐릭터 페이지 HTML (5분 캐시) — /로펙과 /팔찌가 같이 쓴다.
export async function getSpecPointHtml(characterName) {
  const key = characterName.normalize('NFC').toLowerCase();
  const hit = pageCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.html;
  let pending = pageInFlight.get(key);
  if (!pending) {
    if (pageInFlight.size >= 32) throw new Error('Source queue is full');
    pending = fetchText(`${BASE_URL}/character/specPoint/${encodeURIComponent(characterName)}`)
      .then((html) => {
        rememberPage(key, { html });
        return html;
      })
      .finally(() => { pageInFlight.delete(key); });
    pageInFlight.set(key, pending);
  }
  return pending;
}

// 로펙 환산 점수와 순위. 조회 실패·미갱신 캐릭터면 null.
export async function getLopecScore(characterName) {
  try {
    const score = parseLopecScoreHtml(await getSpecPointHtml(characterName), characterName);
    if (!score) {
      pageCache.delete(characterName.normalize('NFC').toLowerCase());
      console.error('[로펙 점수] 점수 자료를 확인할 수 없음');
    }
    return score;
  } catch (err) {
    console.error('[로펙 점수]', err.message);
    return null;
  }
}

// idx를 감싸는 가장 안쪽 { … } 객체를 파싱한다 (뒤로 훑어 여는 괄호를 찾고 matchBrace로 닫는다).
function enclosingObject(payload, idx) {
  let depth = 0;
  for (let i = idx; i >= 0; i -= 1) {
    const c = payload[i];
    if (c === '}') depth += 1;
    else if (c === '{') {
      if (depth === 0) {
        const close = matchBrace(payload, i);
        if (close === -1) return null;
        try {
          return JSON.parse(payload.slice(i, close + 1));
        } catch {
          return null;
        }
      }
      depth -= 1;
    }
  }
  return null;
}

// 로펙 "원정대" 탭 — 계정의 모든 캐릭터와 각각의 로펙 점수(DB에 저장된 최고 환산 점수)를 한 번에 준다.
// 환산 점수는 딜러·서포터를 같은 척도로 매기므로 원정대 체급(/체급) 합산에 쓴다. 5분 캐시.
// 항목: { nickname, characterClass, itemLevel, lopecScore(없으면 null), combatPower, role: 'dealer'|'support'|null }
export async function getLopecExpedition(characterName) {
  const key = `expedition:${characterName}`;
  const hit = pageCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  try {
    const html = await fetchText(`${BASE_URL}/character/expedition/${encodeURIComponent(characterName)}`);
    const payload = flightPayload(html);
    const byName = new Map();
    for (const m of payload.matchAll(/"lopecScore":/g)) {
      const o = enclosingObject(payload, m.index);
      if (o?.nickname && !byName.has(o.nickname)) byName.set(o.nickname, o);
    }
    const data = byName.size > 0 ? [...byName.values()] : null;
    rememberPage(key, { data });
    return data;
  } catch (err) {
    console.error('[로펙 원정대]', err.message);
    return null;
  }
}

// 효율표 대시보드의 카드 값 (예: "팔찌 효율" → 12.41). 없으면 null.
// 정규식 대신 위치 검색으로 읽는다 — 라벨과 값 사이 마크업이 바뀌어도 덜 깨진다.
function readCard(html, label) {
  const labelAt = html.indexOf(label + '</h3>');
  if (labelAt === -1) return null;
  const valueAt = html.indexOf('cardValue', labelAt);
  if (valueAt === -1 || valueAt - labelAt > 400) return null;
  const open = html.indexOf('>', valueAt);
  const close = html.indexOf('<', open);
  const value = Number(html.slice(open + 1, close));
  return Number.isFinite(value) ? value : null;
}

// 효율표 기준 팔찌 효율(%). 캐릭터 페이지 배지값(lopec-sim.js)이 안 나올 때의 예비값.
export async function getBraceletEfficiency(characterName) {
  const hit = efficiencyCache.get(characterName);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  let value = null;
  try {
    const html = await fetchText(
      `${BASE_URL}/character/efficiency/${encodeURIComponent(characterName)}`,
    );
    value = readCard(html, '팔찌 효율');
  } catch {
    // 타임아웃·네트워크 오류는 조용히 넘긴다 — 팔찌 정보 자체는 보여줘야 한다
  }
  for (const [name, entry] of efficiencyCache) if (Date.now() - entry.at >= CACHE_MS) efficiencyCache.delete(name);
  efficiencyCache.delete(characterName);
  efficiencyCache.set(characterName, { at: Date.now(), value });
  while (efficiencyCache.size > 128) efficiencyCache.delete(efficiencyCache.keys().next().value);
  return value;
}
