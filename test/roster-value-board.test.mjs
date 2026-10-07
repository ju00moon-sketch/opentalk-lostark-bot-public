import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { registerHooks } from 'node:module';

// /환산가치 is exercised end to end against a stand-in for the website's loopback roster value route
// (README.md); registrations come from a fixture instead of the real file.
globalThis.__tierFixtureLinks = {};
let stateWrites = 0;
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/src/json-store.js')) {
      return {
        format: 'module', shortCircuit: true,
        source: `
          export class CorruptStoreError extends Error {}
          export function readJson(path) {
            if (!String(path).endsWith('user-links.json')) throw new Error('Unexpected state read');
            return structuredClone(globalThis.__tierFixtureLinks);
          }
          export const readJsonLenient = readJson;
          export const writeJsonAtomic = () => { globalThis.__tierUnexpectedWrite(); };
        `,
      };
    }
    return nextLoad(url, context);
  },
});
globalThis.__tierUnexpectedWrite = () => { stateWrites += 1; throw new Error('Unexpected state write'); };

const TOKEN = 't'.repeat(40);
const computed = Date.UTC(2026, 8, 18, 20, 5); // KST 2026-09-19 05:05
const character = (characterName, itemLevel, role = null, status = 'missing', knownGold = null) =>
  ({ characterName, serverName: '루페온', itemLevel, role, status, knownGold });
// 원정대 단위 최고 기록은 현재값 옆에 따로 온다. 기록이 있으면 순위도 줄도 기록 기준이다.
const missingRecord = { status: 'missing', knownGold: null, recordedAt: null, repricedAt: null,
  counts: { characters: 0, knownCharacters: 0, dealers: 0, supports: 0 }, members: [] };
const record = ({ knownGold, characters, known = characters, dealers, supports, recordedAt = computed }) => ({
  status: 'ok', knownGold, recordedAt, repricedAt: computed,
  counts: { characters, knownCharacters: known, dealers, supports },
  members: Array.from({ length: characters }, (_, i) => ({ characterName: `멤버${i}`, itemLevel: 1740, role: i < dealers ? 'dealer' : 'support' })),
});
const anchor = (characterName, characters, { knownGold, known, complete = true, oldest = computed, record: row = missingRecord }) => ({
  characterName, status: known === 0 ? 'missing' : complete ? 'ok' : 'partial',
  roster: { checkedAt: computed, characters },
  aggregate: { knownGold, complete, engravingBooksGold: 0,
    counts: { characters: characters.filter((row) => row.itemLevel >= 1720).length, knownCharacters: known,
      unknownCharacters: characters.filter((row) => row.itemLevel >= 1720).length - known } },
  computedAt: known === 0 ? null : { oldest, newest: computed },
  record: row,
});
const fixtures = new Map([
  ['최고부자', anchor('최고부자', [character('최고부자', 1745, 'dealer', 'ok', 800000000), character('부캐가나', 1730, 'support', 'ok', 430000000),
    character('저렙이', 1700)], { knownGold: 1230000000, known: 2, oldest: computed - 3600000,
    record: record({ knownGold: 24260000000, characters: 6, dealers: 5, supports: 1 }) })],
  ['반쪽이', anchor('반쪽이', [character('반쪽이', 1740, 'dealer', 'ok', 98000000), character('미계산이', 1725)],
    { knownGold: 98000000, known: 1, complete: false,
      record: record({ knownGold: 98000000, characters: 3, known: 2, dealers: 3, supports: 0, recordedAt: computed - 86400000 }) })],
  ['대기중', anchor('대기중', [character('대기중', 1730)], { knownGold: 0, known: 0 })],
  ['저렙만', anchor('저렙만', [character('저렙만', 1700), character('더저렙', 1690)], { knownGold: 0, known: 0 })],
  // 첫 갱신 전이라 아직 기록이 없는 사람 — 이때만 지금 장비의 값으로 줄을 적는다.
  ['새내기', anchor('새내기', [character('새내기', 1735, 'dealer', 'ok', 500000000), character('둘째캐', 1720, 'support', 'ok', 200000000)],
    { knownGold: 700000000, known: 2 })],
]);

const requests = [];
let outage = false, refreshOutage = false, refreshStatus = 'started';
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  let body = null;
  if (request.method === 'POST') { const chunks = []; for await (const chunk of request) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks).toString()); }
  requests.push({ path: url.pathname, names: url.searchParams.get('names'), token: request.headers['x-bot-token'], body });
  const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
  if (request.headers['x-bot-token'] !== TOKEN) return send(404, { error: 'not_found' });
  if (url.pathname === '/internal/bot/roster-values/refresh') return refreshOutage ? send(503, { error: 'unavailable' }) : send(200, { status: refreshStatus });
  if (url.pathname !== '/internal/bot/roster-values') return send(404, { error: 'not_found' });
  if (outage) return send(503, { error: 'storage_unavailable' });
  const names = (url.searchParams.get('names') ?? '').split(',').filter(Boolean);
  send(200, { anchors: names.map((name) => fixtures.get(name)
    ?? { characterName: name, status: 'missing', roster: null, aggregate: null, computedAt: null }), updatedAt: computed });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
process.env.SITE_INTERNAL_URL = `http://127.0.0.1:${server.address().port}`;
process.env.BOT_INTERNAL_TOKEN = TOKEN;
test.after(() => server.close());

const { expeditionBoard, execute, refreshMyRoster, kstStamp, kstDate,
  RECORD_NOTE, REFRESH_NOTE, REGISTER_HINT, RUNNING_NOTE, SITE_DOWN_NOTE } = await import('../src/commands/roster-value.js');
const { compactGoldText } = await import('../src/site-valuation.js');
const { FOLD_PADDING } = await import('../src/ranking.js');
const { matchTextCommand } = await import('../src/text-commands.js');

const entries = [
  { userId: '111111111111111111', character: '반쪽이' },
  { userId: 'kakao:1', character: '최고부자' },
  { userId: 'kakao:2', character: '저렙만' },
  { userId: 'kakao:3', character: '대기중' },
  { userId: 'kakao:4', character: '없는사람' },
  { userId: 'kakao:5', character: '새내기' },
];

test('gold is written in 억 and 만 units and the stored time is shown in KST', () => {
  assert.equal(compactGoldText(1230000000), '12.3억 G');
  assert.equal(compactGoldText(100000000), '1.0억 G');
  assert.equal(compactGoldText(98000000), '9,800만 G');
  assert.equal(compactGoldText(10000), '1만 G');
  assert.equal(compactGoldText(9999), '9,999 G');
  assert.equal(compactGoldText(0), '0 G');
  assert.equal(compactGoldText(null), '0 G');
  assert.equal(kstStamp(computed), '09/19 05:05');
  assert.equal(kstDate(computed), '09/19');
  assert.equal(kstDate(computed - 86400000), '09/18');
});

test('the board ranks by the roster record and keeps uncomputed people at the bottom', async () => {
  const board = await expeditionBoard(entries);
  assert.deepEqual(board.sections[0].ranked.map((entry) => entry.character), ['최고부자', '새내기', '반쪽이', '대기중', '저렙만']);
  assert.deepEqual(board.failed, ['없는사람']);
  assert.equal(board.failedHint, '아직 계산 전이에요. 계산을 시작했어요. 1~3분 뒤 다시 확인해 주세요');
  assert.equal(board.title, '🏆 길드 내 원정대 환산 가치 랭킹 — 1720↑ 골드 환산');
  const [top, fresh, half, waiting, low] = board.sections[0].lines;
  // 기록 기준: 오늘 남은 2캐가 아니라 기록을 세운 날의 6캐와 그때의 합이 적힌다.
  assert.equal(top, '🥇 **최고부자** · 최고 1,745.0\n└ 환산 가치 **242.6억 G** · 1720↑ **6캐** (딜 5 · 폿 1) · 평균 40.4억 G · 기록 09/19');
  // 기록이 아직 없는 사람만 지금 장비의 값으로 적히고, 날짜도 붙지 않는다.
  assert.equal(fresh, '🥈 **새내기** · 최고 1,735.0\n└ 환산 가치 **7.0억 G** · 1720↑ **2캐** (딜 1 · 폿 1) · 평균 3.5억 G');
  // 「일부 시세 없음」도 기록 집계 기준이다 — 오늘 원정대는 2캐지만 기록은 3캐 중 2캐만 값을 알았다.
  assert.match(half, /환산 가치 \*\*9,800만 G\*\* · 1720↑ \*\*3캐\*\* \(딜 3 · 폿 0\) · 평균 3,267만 G · 일부 시세 없음 1캐 · 기록 09\/18$/);
  assert.match(waiting, /계산 대기 · 1720↑ \*\*1캐\*\* · 계산을 시작했어요\. 1~3분 뒤 다시 확인해 주세요$/);
  assert.equal(low, '**5.** **저렙만**\n└ 1720↑ 캐릭 없음 · 총 2캐');
  assert.equal(board.note, RECORD_NOTE);
  assert.match(board.note, /원정대 최고 기록 기준\(장비는 기록 시점, 시세는 매일 갱신\) · 지금 장비로 다시 계산하려면 \/환산가치 갱신/);
  // The footer says the same basis as the character page and how old the oldest stored number is.
  assert.match(board.footer, /재련·보석·악세서리·각인서·팔찌·아크그리드 젬, 각인서는 서버별 1회/);
  assert.match(board.footer, /홈페이지 캐릭터 화면과 같은 기준 · 가장 오래된 계산 09\/19 04:05$/);
  // 저장된 값이 없는 앵커는 조회 직후 바로 계산이 요청된다.
  assert.ok(requests.every((row) => row.token === TOKEN));
  const refresh = requests.filter((row) => row.path === '/internal/bot/roster-values/refresh');
  assert.equal(refresh.length, 1);
  assert.deepEqual(refresh[0].body.names, ['저렙만', '대기중', '없는사람']);
});

test('a refresh the site refuses leaves the nightly wording in place and an outage asks for nothing', async () => {
  refreshOutage = true;
  try {
    const board = await expeditionBoard(entries);
    assert.equal(board.failedHint, '아직 계산 전이에요. 새벽 갱신 뒤 다시 확인해 주세요');
    assert.ok(board.sections[0].lines.some((line) => /계산 대기 · 1720↑ \*\*1캐\*\* · 새벽 갱신 뒤 다시 확인해 주세요$/.test(line)));
  } finally { refreshOutage = false; }
  outage = true;
  requests.length = 0;
  try {
    await expeditionBoard(entries);
    // 사이트가 조회조차 못 하면 계산을 요청해도 소용없다.
    assert.deepEqual(requests.filter((row) => row.path.endsWith('/refresh')), []);
  } finally { outage = false; }
});

test('a site that cannot answer lists everyone as not calculated yet', async () => {
  outage = true;
  try {
    const board = await expeditionBoard(entries);
    assert.deepEqual(board.sections[0].lines, []);
    assert.deepEqual(board.failed, entries.map((entry) => entry.character));
    assert.doesNotMatch(board.footer, /가장 오래된 계산/);
  } finally { outage = false; }
});

function makeInteraction(platform, list) {
  globalThis.__tierFixtureLinks = Object.fromEntries(list.map((entry) => [entry.userId, entry.character]));
  const replies = [];
  return {
    platform, replies, user: { id: list[0].userId },
    guild: { members: { fetch: async ({ user }) => new Map(user.map((id) => [id, {}])) } },
    options: { getInteger: () => null },
    async deferReply() {},
    async reply(value) { replies.push(value); },
    async editReply(value) { replies.push(value); },
  };
}

test('production execute emits correct Discord and Kakao roster value payloads', async () => {
  for (const platform of ['discord', 'kakao']) {
    const interaction = makeInteraction(platform, entries);
    await execute(interaction);
    assert.equal(interaction.replies.length, 1);
    const reply = interaction.replies[0];
    const text = platform === 'discord' ? JSON.stringify(reply.embeds[0].toJSON()) : reply.content;
    assert.match(text, /최고부자[\s\S]*반쪽이[\s\S]*대기중[\s\S]*저렙만/);
    assert.match(text, /242.6억 G/);
    assert.match(text, /기록 09\/19/);
    assert.match(text, /일부 시세 없음 1캐/);
    assert.match(text, /계산 대기/);
    assert.match(text, /없는사람/);
    assert.match(text, /아직 계산 전이에요/);
    assert.doesNotMatch(text, /undefined|NaN/);
    if (platform === 'discord') {
      const embed = reply.embeds[0].toJSON();
      assert.match(embed.footer.text, /^5명 · 1720 이상 캐릭터의 원정대 환산 가치 합/);
      // 기준 한 줄은 푸터 둘째 줄로 내려간다.
      assert.equal(embed.footer.text.split('\n')[1], RECORD_NOTE);
      assert.match(embed.description, /← 나/);
      assert.ok(JSON.stringify(embed).length < 6000);
    } else {
      assert.match(reply.content, /▸ 집계 5명/);
      // 카톡은 주의줄(※)이 하나 더 붙는다. 둘 다 순위 아래에 온다.
      assert.ok(reply.content.includes(`※ ${RECORD_NOTE}`));
      assert.match(reply.content, /조회 안 됨/);
      assert.ok(reply.content.indexOf('▸ 순위') < reply.content.indexOf('※ 1720 이상 캐릭터의 원정대 환산 가치 합'));
      assert.ok(reply.content.indexOf('※ 1720 이상 캐릭터의 원정대 환산 가치 합') < reply.content.indexOf(`※ ${RECORD_NOTE}`));
      assert.ok(reply.content.indexOf('없는사람') < reply.content.indexOf('▸ 순위'));
    }
    assert.equal(reply.components.length, 1);
  }
  assert.equal(stateWrites, 0);
});

function refreshInteraction(platform, userId, links = {}) {
  globalThis.__tierFixtureLinks = links;
  const replies = [];
  return {
    platform, replies, user: { id: userId },
    options: { getInteger: () => null, getString: (name) => (name === '갱신' ? '지금' : null) },
    async deferReply() {},
    async reply(value) { replies.push(value); },
    async editReply(value) { replies.push(value); },
  };
}

test('a Kakao board too long for the room is sent whole as one folded message, a page or a short board is not', async () => {
  // 서른 명의 기록을 더하면 순위판이 방 분량(1,500자)을 넘는다 — 잘라서 링크로 넘기지 않고 접힌 전문 하나로 보낸다.
  const many = Array.from({ length: 30 }, (_, i) => `부자${String(i + 1).padStart(2, '0')}`);
  for (const [i, name] of many.entries()) {
    fixtures.set(name, anchor(name, [character(name, 1740, 'dealer', 'ok', 900000000)], { knownGold: 900000000, known: 1,
      record: record({ knownGold: 9000000000 - i * 1000000, characters: 4, dealers: 3, supports: 1 }) }));
  }
  const list = [...entries, ...many.map((name, i) => ({ userId: `kakao:many${i}`, character: name }))];
  try {
    const kakao = makeInteraction('kakao', list);
    await execute(kakao);
    const reply = kakao.replies[0];
    assert.ok(reply.content.length > 1500);
    assert.equal(typeof reply.kakaoBridgeText, 'string');
    const [top, rest] = reply.kakaoBridgeText.split(`\n\n${FOLD_PADDING}\n`);
    assert.match(top, /▸ 집계 35명/);
    assert.match(top, /조회 안 됨[\s\S]*없는사람/);
    assert.doesNotMatch(top, /부자01/);
    // 기준 설명은 순위 아래로 내려간다 — 방에 먼저 보이는 것은 집계와 조회 실패뿐이다.
    assert.doesNotMatch(top, /※/);
    assert.ok(rest.indexOf(`※ ${RECORD_NOTE}`) > rest.indexOf('부자01'), '기준 설명이 순위 뒤에 온다');
    for (const name of [...many, '최고부자', '반쪽이', '대기중', '저렙만', '새내기']) assert.ok(rest.includes(name), `${name} 줄이 접힌 전문에 있어야 한다`);
    assert.doesNotMatch(reply.kakaoBridgeText, /전체 보기|뒤가 잘렸어요/);
    // 쪽을 고르면 그 쪽만 보통 메시지로 간다.
    const paged = makeInteraction('kakao', list);
    paged.options = { getInteger: () => 2 };
    await execute(paged);
    assert.equal(paged.replies[0].kakaoBridgeText, undefined);
    assert.match(paged.replies[0].content, /2\/2쪽/);
    // 한 쪽뿐인데 쪽을 적어도(ㅊㄱ 2) 전체 판이라 접힌 전문으로 간다.
    const single = makeInteraction('kakao', [...entries, ...list.slice(6, 24)]);
    single.options = { getInteger: () => 2 };
    await execute(single);
    assert.equal(typeof single.replies[0].kakaoBridgeText, 'string');
    assert.doesNotMatch(single.replies[0].kakaoBridgeText, /\d\/\d쪽/);
    // 다섯 명짜리 판은 그대로 보통 메시지다.
    const short = makeInteraction('kakao', entries);
    await execute(short);
    assert.equal(short.replies[0].kakaoBridgeText, undefined);
  } finally { for (const name of many) fixtures.delete(name); }
});

test('/환산가치 갱신 asks the website to price the caller\u2019s own registered roster again', async () => {
  requests.length = 0;
  // 등록이 없으면 다시 계산할 원정대가 없다 — 사이트를 부르지도 않는다.
  const none = refreshInteraction('discord', 'u1', {});
  await execute(none);
  assert.deepEqual(none.replies, [`\`/등록\`으로 ${REGISTER_HINT}`]);
  assert.deepEqual(requests, []);

  const asked = refreshInteraction('discord', 'u1', { u1: '최고부자' });
  await execute(asked);
  assert.deepEqual(asked.replies, [`**최고부자** 원정대 ${REFRESH_NOTE}.`]);
  const kakao = refreshInteraction('kakao', 'kakao:9', { 'kakao:9': '반쪽이' });
  await execute(kakao);
  // 카톡은 굵게 표시와 백틱을 쓰지 않는다.
  assert.deepEqual(kakao.replies, [`반쪽이 원정대 ${REFRESH_NOTE}.`]);
  const kakaoNone = refreshInteraction('kakao', 'kakao:9', {});
  await execute(kakaoNone);
  assert.deepEqual(kakaoNone.replies, [`/등록으로 ${REGISTER_HINT}`]);

  assert.deepEqual(requests.map((row) => row.path), Array(2).fill('/internal/bot/roster-values/refresh'));
  assert.deepEqual(requests.map((row) => row.body.names), [['최고부자'], ['반쪽이']]);
  assert.ok(requests.every((row) => row.token === TOKEN));
  assert.equal(stateWrites, 0);
});

test('/환산가치 갱신 says what happened when a run is already going or the site is down', async () => {
  refreshStatus = 'running';
  try {
    const busy = refreshInteraction('discord', 'u1', { u1: '최고부자' });
    await execute(busy);
    assert.deepEqual(busy.replies, [RUNNING_NOTE]);
  } finally { refreshStatus = 'started'; }
  refreshOutage = true;
  try {
    const down = refreshInteraction('kakao', 'kakao:9', { 'kakao:9': '반쪽이' });
    await execute(down);
    assert.deepEqual(down.replies, [SITE_DOWN_NOTE]);
  } finally { refreshOutage = false; }
  // 요청 자체가 던져도 안내만 바뀐다.
  const thrown = refreshInteraction('discord', 'u1', { u1: '최고부자' });
  await refreshMyRoster(thrown, { requestRefresh: async () => { throw new Error('boom'); }, linked: () => '최고부자' });
  assert.deepEqual(thrown.replies, [SITE_DOWN_NOTE]);
});

test('갱신 is read the same way from the 초성 alias, a chat command and the Kakao slash form', () => {
  const map = new Map([['환산가치', { data: { name: '환산가치', toJSON: () => ({ name: '환산가치', options: [] }) } }]]);
  const kakaoOptions = { prefixes: ['/'], bareChosung: false, anyCommand: true };
  const parse = (input, options) => matchTextCommand(input, map, options)?.options;
  assert.deepEqual(parse('ㅎㅅㄱㅊ 갱신'), { 갱신: '지금' });
  assert.deepEqual(parse('.환산가치 갱신'), { 갱신: '지금' });
  assert.deepEqual(parse('/환산가치 갱신', kakaoOptions), { 갱신: '지금' });
  assert.deepEqual(parse('/ㅎㅅㄱㅊ 갱신', kakaoOptions), { 갱신: '지금' });
  // 쪽 번호는 그대로 살아 있고, 둘을 같이 치면 커맨드 쪽에서 갱신을 먼저 처리한다.
  assert.deepEqual(parse('ㅎㅅㄱㅊ'), { 갱신: null });
  assert.deepEqual(parse('ㅎㅅㄱㅊ 2'), { 페이지: 2, 갱신: null });
  assert.deepEqual(parse('ㅎㅅㄱㅊ 2 갱신'), { 페이지: 2, 갱신: '지금' });
  assert.deepEqual(parse('ㅎㅅㄱㅊ 갱신 2'), { 페이지: 2, 갱신: '지금' });
  assert.match(matchTextCommand('ㅎㅅㄱㅊ 0', map).usage, /ㅎㅅㄱㅊ 갱신$/);
});
