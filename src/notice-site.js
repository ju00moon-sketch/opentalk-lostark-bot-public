// 공식 API(/news/notices)가 점검 등으로 실패할 때 쓰는 대체 경로 — 홈페이지 공지 목록 HTML을 읽어
// API와 같은 형태 [{ Type, Title, Link, Date }]로 돌려준다. 페이지 구조가 바뀌면 추측하지 않고 null을 돌린다.
const SITE_ORIGIN = 'https://lostark.game.onstove.com';
export const NOTICE_LIST_URL = `${SITE_ORIGIN}/News/Notice/List`;
export const NOTICE_SITE_TIMEOUT_MS = 5000;
export const NOTICE_SITE_MAX_BYTES = 512 * 1024;
export const NOTICE_SITE_MAX_ITEMS = 20;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 2026-09-17 실제 페이지 기준: <div class="list list--default"> 안에 전체 공지(<li class="list__item--notice">,
// href /News/Notice/NoticeViews/<id>?…)와 일반 공지(<li class="">, href /News/Notice/Views/<id>?…)가 차례로 온다.
const LIST_START = /<div class="list list--default">/;
const LIST_END = /<div class="pagination"|<!-- \/\/ 리스트 -->/;
const ITEM = /<li\s+class="(list__item--notice|list__item|)"\s*>([\s\S]*?)<\/li>/g;
const HREF = /<a\s+href="([^"]*)"/;
const NOTICE_PATH = /^\/News\/Notice\/(?:Notice)?Views\/(\d+)$/;
const CATEGORY = /<div class="list__category"[^>]*>([\s\S]*?)<\/div>/;
const CATEGORY_TEXT = /<span[^>]*>([^<]*)<\/span>/;
const TITLE = /<span class="list__title">([\s\S]*?)<\/span>/;
const DATE = /<span class="tz-convert"([^>]*)>([^<]*)<\/span>/;
const DATE_UTC = /data-utc="([^"]*)"/;
const DISPLAY_DATE = /^(\d{4})\.(\d{2})\.(\d{2})$/;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

const cleanText = (html) => decodeEntities(String(html).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

function kstDate(utc) {
  const time = Date.parse(utc);
  if (!Number.isFinite(time)) return null;
  return new Date(time + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function parseItem(html) {
  const href = HREF.exec(html);
  if (!href) return null;
  const path = NOTICE_PATH.exec(decodeEntities(href[1]).split('?', 1)[0]);
  if (!path) return null;
  const category = CATEGORY.exec(html);
  const type = category ? cleanText(CATEGORY_TEXT.exec(category[1])?.[1] ?? '') : '';
  const title = cleanText(TITLE.exec(html)?.[1] ?? '');
  const date = DATE.exec(html);
  if (!type || !title || !date) return null;
  const utc = DATE_UTC.exec(date[1]);
  const display = DISPLAY_DATE.exec(date[2].trim());
  const when = utc ? kstDate(utc[1]) : display ? `${display[1]}-${display[2]}-${display[3]}` : null;
  if (!when) return null;
  return { id: path[1], notice: { Type: type, Title: title, Link: `${SITE_ORIGIN}${path[0]}`, Date: when } };
}

// 항목 하나라도 예상 구조와 다르면 전체를 null로 — 일부만 맞는 페이지를 공지 목록으로 보여 주지 않는다.
export function parseSiteNotices(html) {
  if (typeof html !== 'string') return null;
  const start = LIST_START.exec(html);
  if (!start) return null;
  const rest = html.slice(start.index + start[0].length);
  const end = LIST_END.exec(rest);
  const list = end ? rest.slice(0, end.index) : rest;
  const notices = [];
  const seen = new Set();
  for (const match of list.matchAll(ITEM)) {
    const item = parseItem(match[2]);
    if (!item) return null;
    if (seen.has(item.id)) continue; // 전체 공지는 일반 목록에도 한 번 더 나온다
    seen.add(item.id);
    notices.push(item.notice);
  }
  // 상단 고정 전체 공지에는 2018·2020년 안내도 있어 페이지 순서 그대로면 옛 공지가 앞에 온다.
  // 날짜 내림차순으로 안정 정렬해 같은 날짜끼리는 페이지 순서(전체 공지 우선)를 유지한다.
  notices.sort((a, b) => (a.Date < b.Date ? 1 : a.Date > b.Date ? -1 : 0));
  return notices.length ? notices.slice(0, NOTICE_SITE_MAX_ITEMS) : null;
}

async function readBody(response) {
  if (Number(response.headers?.get?.('content-length')) > NOTICE_SITE_MAX_BYTES) throw new Error('site-size');
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('site-body');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > NOTICE_SITE_MAX_BYTES) throw new Error('site-size');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    void reader.cancel().catch(() => {});
  }
}

// 실패 이유를 가리지 않고 null — 호출한 쪽은 원래의 API 오류 문구를 그대로 쓴다.
export async function fetchSiteNotices({ fetchImpl = fetch, timeoutMs = NOTICE_SITE_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(NOTICE_LIST_URL, {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html', 'accept-language': 'ko-KR,ko;q=0.9' },
    });
    if (!response.ok) { void response.body?.cancel?.().catch(() => {}); return null; }
    return parseSiteNotices(await readBody(response));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
