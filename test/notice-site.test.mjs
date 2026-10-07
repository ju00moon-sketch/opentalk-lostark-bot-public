import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSiteNotices, fetchSiteNotices, decodeEntities, NOTICE_LIST_URL, NOTICE_SITE_MAX_BYTES } from '../src/notice-site.js';
import { createNoticesExecute, API_FOOTER, SITE_FOOTER } from '../src/commands/notices.js';
import { embedToText } from '../src/kakao/render.js';

// 2026-09-17 실제 페이지에서 따온 최소 조각 — 전체 공지 한 개가 일반 목록에 한 번 더 나오고, 일반 공지는 class가 비어 있다.
const item = ({ pinned = false, id, type, icon, title, utc, shown }) => `
        <li class="${pinned ? 'list__item--notice' : ''}">
            <a href="/News/Notice/${pinned ? 'NoticeViews' : 'Views'}/${id}?page=1&amp;searchtype=0&amp;searchtext=&amp;noticetype=all">
                <div class="list__category" aria-label="카테고리">
                            <span class="icon icon--${icon}">${type}</span>

                </div>
                <div class="list__subject" aria-label="제목">
                    <span class="list__title">${title}</span>
                </div>
                ${pinned ? '' : '<div class="list__read" aria-label="조회수">9999+</div>'}
                <div class="list__date" aria-label="등록일"><span class="tz-convert"${utc ? ` data-utc="${utc}"` : ''} data-type="relative">${shown}</span></div>
            </a>
        </li>`;
const page = (items, { tail = '<div class="pagination" aria-label="페이지네이션"></div>' } = {}) => `<html><body>
<div class="list list--default">
    <ul>
        <!-- 전체 공지 -->
${items.filter((entry) => entry.pinned).map(item).join('')}
        <!-- // 전체 공지 -->
    </ul>
    <ul>
${items.filter((entry) => !entry.pinned).map(item).join('')}
    </ul>
</div>
<!-- // 리스트 -->
${tail}
</body></html>`;

const fixture = [
  { pinned: true, id: 13544, type: '공지', icon: 'notice', title: '알려진 이슈를 안내해 드립니다. (9/17 수정)', utc: '2026-09-16T00:59:51Z', shown: '2026.09.16' },
  { id: 13545, type: '공지', icon: 'notice', title: '9월 16일(수) 업데이트 내역 안내', utc: '2026-09-16T00:59:53Z', shown: '2026.09.16' },
  { id: 13544, type: '공지', icon: 'notice', title: '알려진 이슈를 안내해 드립니다. (9/17 수정)', utc: '2026-09-16T00:59:51Z', shown: '2026.09.16' },
  { id: 13543, type: '점검', icon: 'check', title: '9/16(수) 정기 점검 &amp; <b>보상</b> 안내', utc: '2026-09-15T15:30:00Z', shown: '2026.09.16' },
  { id: 13540, type: '상점', icon: 'update', title: '9월 상점 갱신', utc: null, shown: '2026.09.10' },
];

test('parses pinned and regular notices in order, in the API shape, without duplicates', () => {
  assert.deepEqual(parseSiteNotices(page(fixture)), [
    { Type: '공지', Title: '알려진 이슈를 안내해 드립니다. (9/17 수정)', Link: 'https://lostark.game.onstove.com/News/Notice/NoticeViews/13544', Date: '2026-09-16' },
    { Type: '공지', Title: '9월 16일(수) 업데이트 내역 안내', Link: 'https://lostark.game.onstove.com/News/Notice/Views/13545', Date: '2026-09-16' },
    { Type: '점검', Title: '9/16(수) 정기 점검 & 보상 안내', Link: 'https://lostark.game.onstove.com/News/Notice/Views/13543', Date: '2026-09-16' },
    { Type: '상점', Title: '9월 상점 갱신', Link: 'https://lostark.game.onstove.com/News/Notice/Views/13540', Date: '2026-09-10' },
  ]);
});

test('UTC timestamps become Korean dates across midnight and entities are decoded', () => {
  const [late] = parseSiteNotices(page([{ id: 1, type: '이벤트', icon: 'event', title: 'A &lt;B&gt; &#39;C&#39; &#x26; D', utc: '2026-09-16T15:00:00Z', shown: '2026.09.16' }]));
  assert.equal(late.Date, '2026-09-17');
  assert.equal(late.Title, "A <B> 'C' & D");
  assert.equal(decodeEntities('&amp;&unknown;&#0;'), '&&unknown;&#0;');
});

test('old pinned notices sort behind newer regular ones while same-day pinned notices stay first', () => {
  const pinnedOld = [
    { pinned: true, id: 840, type: '공지', icon: 'notice', title: '악성코드 감염 예방을 위한 보안 수칙 안내', utc: '2020-02-26T08:52:11Z', shown: '2020.02.26' },
    { pinned: true, id: 58, type: '공지', icon: 'notice', title: '모험가 여러분의 계정 보호를 위한 안내', utc: '2018-11-05T07:55:03Z', shown: '2018.11.05' },
  ];
  const result = parseSiteNotices(page([fixture[0], ...pinnedOld, ...fixture.slice(1)]));
  assert.deepEqual(result.map((n) => [n.Link.split('/').pop(), n.Date]), [
    ['13544', '2026-09-16'], ['13545', '2026-09-16'], ['13543', '2026-09-16'], ['13540', '2026-09-10'],
    ['840', '2020-02-26'], ['58', '2018-11-05'],
  ]);
  assert.equal(result[0].Link, 'https://lostark.game.onstove.com/News/Notice/NoticeViews/13544');
  // 20개 상한은 정렬 뒤에 적용되어 옛 고정 공지가 최신 공지의 자리를 차지하지 않는다.
  const many = Array.from({ length: 20 }, (_, index) => ({ id: 200 + index, type: '공지', icon: 'notice', title: `최신 ${index}`, utc: '2026-09-09T00:00:00Z', shown: '2026.09.09' }));
  const capped = parseSiteNotices(page([...pinnedOld, ...many]));
  assert.equal(capped.length, 20);
  assert.ok(capped.every((n) => n.Date === '2026-09-09'));
});

test('no more than 20 notices are returned', () => {
  const many = Array.from({ length: 25 }, (_, index) => ({ id: 100 + index, type: '공지', icon: 'notice', title: `공지 ${index}`, utc: '2026-09-01T00:00:00Z', shown: '2026.09.01' }));
  assert.equal(parseSiteNotices(page(many)).length, 20);
});

test('empty, missing, or changed structure yields null instead of a guessed list', () => {
  assert.equal(parseSiteNotices(''), null);
  assert.equal(parseSiteNotices(null), null);
  assert.equal(parseSiteNotices('<html><body><ul><li>공지</li></ul></body></html>'), null);
  assert.equal(parseSiteNotices(page([])), null);
  const broken = [
    { id: 1, type: '', icon: 'notice', title: '분류 없음', utc: '2026-09-01T00:00:00Z', shown: '2026.09.01' },
    { id: 2, type: '공지', icon: 'notice', title: '', utc: '2026-09-01T00:00:00Z', shown: '2026.09.01' },
    { id: 3, type: '공지', icon: 'notice', title: '날짜 없음', utc: null, shown: '어제' },
    { id: 4, type: '공지', icon: 'notice', title: '시각 깨짐', utc: 'not-a-date', shown: '2026.09.01' },
  ];
  for (const entry of broken) assert.equal(parseSiteNotices(page([fixture[1], entry])), null, entry.title);
  assert.equal(parseSiteNotices(page([fixture[1]]).replace('/News/Notice/Views/13545', '/News/Event/Views/13545')), null);
  assert.equal(parseSiteNotices(page([fixture[1]]).replace('<li class="">', '<li class="list__card">')), null);
  // 목록 뒤의 다른 항목 구조는 보지 않는다.
  assert.equal(parseSiteNotices(page([fixture[1]], { tail: '<ul><li class="">기타</li></ul>' })).length, 1);
});

test('fetch uses a browser user agent, a timeout, no redirects, and returns null on failure or oversize', async () => {
  const calls = [];
  const okFetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(page(fixture), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  const notices = await fetchSiteNotices({ fetchImpl: okFetch });
  assert.equal(notices.length, 4);
  assert.equal(calls[0].url, NOTICE_LIST_URL);
  assert.equal(calls[0].options.redirect, 'error');
  assert.match(calls[0].options.headers['user-agent'], /^Mozilla\/5\.0 /);
  assert.ok(calls[0].options.signal instanceof AbortSignal);

  assert.equal(await fetchSiteNotices({ fetchImpl: async () => new Response('점검 중', { status: 503 }) }), null);
  assert.equal(await fetchSiteNotices({ fetchImpl: async () => { throw new TypeError('fetch failed'); } }), null);
  assert.equal(await fetchSiteNotices({ fetchImpl: async () => new Response('<html></html>', { status: 200 }) }), null);
  const oversized = page(fixture).replace('</body>', `<!-- ${'x'.repeat(NOTICE_SITE_MAX_BYTES)} --></body>`);
  assert.equal(await fetchSiteNotices({ fetchImpl: async () => new Response(oversized, { status: 200 }) }), null);
  assert.equal(await fetchSiteNotices({ fetchImpl: async () => new Response(page(fixture), { status: 200, headers: { 'content-length': String(NOTICE_SITE_MAX_BYTES + 1) } }) }), null);
  const slow = (url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  assert.equal(await fetchSiteNotices({ fetchImpl: slow, timeoutMs: 10 }), null);
});

function interaction() {
  const payloads = [];
  return { payloads, async deferReply() {}, async editReply(payload) { payloads.push(payload); } };
}
const apiError = Object.assign(new Error('로스트아크 API 오류 (HTTP 503)'), { status: 503, transient: true });
const siteNotices = parseSiteNotices(page(fixture));

test('/공지 falls back to the site list with its own footer when the API fails, on Discord and in the Kakao text form', async (t) => {
  t.mock.method(console, 'error', () => {});
  let siteCalls = 0;
  const execute = createNoticesExecute({ fetchNotices: async () => { throw apiError; }, fetchSite: async () => { siteCalls += 1; return siteNotices; } });
  const target = interaction();
  await execute(target);
  assert.equal(siteCalls, 1);
  const embed = target.payloads[0].embeds[0].toJSON();
  assert.equal(embed.footer.text, SITE_FOOTER);
  assert.match(embed.description, /^`공지` \[\*\*알려진 이슈를 안내해 드립니다\. \(9\/17 수정\)\*\*\]\(https:\/\/lostark\.game\.onstove\.com\/News\/Notice\/NoticeViews\/13544\) — 09\.16\n/);
  assert.match(embed.description, /`점검` \[\*\*9\/16\(수\) 정기 점검 & 보상 안내\*\*\]/);
  const kakao = embedToText(embed);
  assert.match(kakao, /^📢 최신 공지사항\n/);
  assert.ok(kakao.endsWith(`\n\n${SITE_FOOTER}`));
});

test('/공지 keeps the API list and footer when the API works, and the original error when both fail', async (t) => {
  t.mock.method(console, 'error', () => {});
  const api = [{ Type: '공지', Title: 'API 공지', Link: 'https://lostark.game.onstove.com/News/Notice/Views/1', Date: '2026-09-16T00:00:00' }];
  let siteCalls = 0;
  const working = interaction();
  await createNoticesExecute({ fetchNotices: async () => api, fetchSite: async () => { siteCalls += 1; return siteNotices; } })(working);
  assert.equal(siteCalls, 0);
  assert.equal(working.payloads[0].embeds[0].toJSON().footer.text, API_FOOTER);
  assert.match(working.payloads[0].embeds[0].toJSON().description, /API 공지.*09\.16$/);

  const empty = interaction();
  await createNoticesExecute({ fetchNotices: async () => [], fetchSite: async () => siteNotices })(empty);
  assert.equal(empty.payloads[0], '공지사항을 가져오지 못했어요.');

  const failing = createNoticesExecute({ fetchNotices: async () => { throw apiError; }, fetchSite: async () => null });
  await assert.rejects(failing(interaction()), { message: '로스트아크 API 오류 (HTTP 503)' });
});
