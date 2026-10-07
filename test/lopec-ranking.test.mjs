import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Exercise production readers and commands with fixture transport and isolated registrations.
for (const key of Object.keys(process.env)) {
  if (/(?:KEY|TOKEN|SECRET)/i.test(key)) delete process.env[key];
}
globalThis.__rankingFixtureLinks = {};
let stateWrites = 0;
globalThis.__rankingUnexpectedWrite = () => { stateWrites += 1; throw new Error('Unexpected state write'); };
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/src/json-store.js')) {
      return {
        format: 'module', shortCircuit: true,
        source: `
          export class CorruptStoreError extends Error {}
          export function readJson(path) {
            if (!String(path).endsWith('user-links.json')) throw new Error('Unexpected state read');
            return structuredClone(globalThis.__rankingFixtureLinks);
          }
          export const readJsonLenient = readJson;
          export const writeJsonAtomic = globalThis.__rankingUnexpectedWrite;
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const routes = new Map();
const requests = [];
let unexpectedRequests = 0;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  assert.equal(url.origin, 'https://lopec.kr');
  assert.match(url.pathname, /^\/character\/specPoint\/[^/]+$/);
  assert.ok(options.signal instanceof AbortSignal);
  const name = decodeURIComponent(url.pathname.split('/').at(-1));
  requests.push(name);
  if (!routes.has(name)) {
    unexpectedRequests += 1;
    throw new Error('Unexpected fixture request');
  }
  const route = routes.get(name);
  const response = typeof route === 'function' ? await route() : route;
  if (response instanceof Error) throw response;
  if (response instanceof Response) return response;
  if (typeof response === 'object') return new Response(null, { status: response.status });
  return new Response(response);
};

const { parseLopecScoreHtml, getLopecScore, getSpecPointHtml, flightPayload } = await import('../src/lopec.js');
const { specBoard, execute } = await import('../src/commands/ranking.js');

function flight(records) {
  const payload = records.map((record, i) => `${i.toString(16)}:${JSON.stringify(record)}\n`).join('');
  return flightHtml(payload);
}

function flightHtml(payload) {
  const cut = Math.floor(payload.length / 2);
  return '<html>' + [payload.slice(0, cut), payload.slice(cut)]
    .map((part) => `<script>self.__next_f.push([1,${JSON.stringify(part)}])</script>`).join('') + '</html>';
}

function currentPage(name, {
  current = 5100.25, peak = 5200.5, support = false, unrelatedWidget = false,
  median = 4950.25, gemMedian = 8.5,
} = {}) {
  const records = [
    ['$', '$Lmain', null, {
      lostarkParser: {
        profile: {
          nickName: name, class: support ? '바드' : '블레이드', secondClass: support ? '절실한 구원' : '잔재된 기운',
          supportCheck: support, itemLevel: 1775, server: '루페온', guild: '테스트길드',
          image: 'https://example.invalid/profile.png',
        },
        stats: { combatPower: 5000.75 },
      },
      dbScore: peak, cardData: null, nowMedian: null, supplementRequestId: 'fixture-request',
    }],
  ];
  if (unrelatedWidget) records.push(['$', '$Lwidget', null, { encodedName: encodeURIComponent('다른캐릭터'), specPoint: 99999 }]);
  records.push(['$', '$Lwidget', null, { encodedName: encodeURIComponent(name), specPoint: current }]);
  records.push(['$', '$Lsupplement', null, {
    requestId: 'fixture-request', result: {
      cardData: { dealer: [30, 30, 30, 0, 30, 30], support: [0, 0, 0, 0, 0, 0] },
      nowMedian: median, arkgridGemMedian: gemMedian,
      profileSupplement: { totalRank: 120, totalPercent: 5.5, classRank: 12, classPercent: 4.5 },
    },
  }]);
  return flight(records);
}

test('current streamed profile, widget and delayed supplement preserve score fields', () => {
  const score = parseLopecScoreHtml(currentPage('분리자료'), '분리자료');
  assert.ok(score);
  assert.deepEqual({
    name: score.name, firstClass: score.firstClass, secondClass: score.secondClass,
    itemLevel: score.itemLevel, support: score.supportCheck,
    specPoint: score.specPoint, dbScore: score.dbScore, combatPower: score.combatPower,
    median: score.median, gemMedian: score.gemMedian,
    classRank: score.classRank, classPercent: score.classPercent,
    totalRank: score.totalRank, totalPercent: score.totalPercent,
    server: score.server, guild: score.guild, profileImage: score.profileImage,
  }, {
    name: '분리자료', firstClass: '블레이드', secondClass: '잔재된 기운',
    itemLevel: 1775, support: false,
    specPoint: 5100.25, dbScore: 5200.5, combatPower: 5000.75,
    median: 4950.25, gemMedian: 8.5, classRank: 12, classPercent: 4.5,
    totalRank: 120, totalPercent: 5.5,
    server: '루페온', guild: '테스트길드', profileImage: 'https://example.invalid/profile.png',
  });
  assert.deepEqual(score.cardData.dealer, [30, 30, 30, 0, 30, 30]);
});

test('legacy summary accepts reordered fields and zero current score with a stored peak', () => {
  const html = flight([{
    summary: { specPoint: 0, firstClass: '바드', itemLevel: 1750, supportCheck: true, name: '구자료' },
    dbScore: 6400, stats: { combatPower: 4000 }, nowMedian: 6100,
  }]);
  const score = parseLopecScoreHtml(html, '구자료');
  assert.ok(score);
  assert.equal(score.name, '구자료');
  assert.equal(score.specPoint, 0);
  assert.equal(score.dbScore, 6400);
  assert.equal(score.supportCheck, true);
  assert.equal(score.median, 6100);
});

test('UTF-8 length text frames cannot hide the immediately following profile record', () => {
  const text = '설명 🌸\n9:{"name":"텍스트자료","specPoint":99999}\n줄바꿈과 \\"따옴표\\" 끝';
  const payload = `ff:T${Buffer.byteLength(text, 'utf8').toString(16)},${text}`
    + flightPayload(currentPage('텍스트자료'));
  const score = parseLopecScoreHtml(flightHtml(payload), '텍스트자료');
  assert.ok(score);
  assert.equal(score.name, '텍스트자료');
  assert.equal(score.specPoint, 5100.25);
  assert.equal(score.dbScore, 5200.5);
  assert.equal(score.median, 4950.25);
});

test('matching encoded nickname selects its current score without replacing stored peak', () => {
  const score = parseLopecScoreHtml(currentPage('이름검증', { current: 0, peak: 1234.5, unrelatedWidget: true }), '이름검증');
  assert.equal(score.specPoint, 0);
  assert.equal(score.dbScore, 1234.5);
  const noPeak = parseLopecScoreHtml(currentPage('최고없음', { current: 5555, peak: null }), '최고없음');
  assert.ok(noPeak);
  assert.equal(noPeak.specPoint, 5555);
  assert.equal(noPeak.dbScore, null);
});

test('profile identity matches normalized nicknames and rejects another character page', () => {
  assert.ok(parseLopecScoreHtml(currentPage('Jack검증'), 'jack검증'.normalize('NFD')));
  assert.equal(parseLopecScoreHtml(currentPage('다른프로필'), '요청프로필'), null);
});

test('broken pages and unrelated profile data do not produce a character score', () => {
  for (const html of [
    '<html>Temporary service failure</html>',
    '<script>self.__next_f.push([1,"broken\\q"])</script>',
    flight([{ unrelated: { name: '무관', value: 123 }, dbScore: 123 }]),
  ]) assert.equal(parseLopecScoreHtml(html, '대상'), null);
});

test('HTTP 200 parse failure is refetched and a successful page stays cached', async (t) => {
  t.mock.method(console, 'error', () => {});
  const name = '파싱회복';
  routes.set(name, '<html>Temporary failure</html>');
  assert.equal(await getLopecScore(name), null);
  routes.set(name, currentPage(name));
  assert.equal((await getLopecScore(name)).dbScore, 5200.5);
  assert.equal((await getLopecScore(name)).dbScore, 5200.5);
  assert.equal(requests.filter((entry) => entry === name).length, 2);
});

test('HTTP and network failures allow the next request to recover', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const [name, failure] of [
    ['HTTP회복', { ok: false, status: 503 }],
    ['네트워크회복', new Error('fixture network failure')],
  ]) {
    routes.set(name, failure);
    assert.equal(await getLopecScore(name), null);
    routes.set(name, currentPage(name));
    assert.equal((await getLopecScore(name)).name, name);
    assert.equal(requests.filter((entry) => entry === name).length, 2);
  }
});

test('concurrent score and raw-page readers share one request', async () => {
  const name = '동시조회';
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const html = currentPage(name);
  routes.set(name, async () => { await gate; return html; });
  const pending = [getLopecScore(name), getLopecScore(name), getSpecPointHtml(name)];
  release();
  const [one, two, raw] = await Promise.all(pending);
  assert.equal(one.dbScore, 5200.5);
  assert.deepEqual(two, one);
  assert.equal(raw, html);
  assert.equal(requests.filter((entry) => entry === name).length, 1);
});

function boardEntries(prefix = '') {
  const entries = [
    { userId: '12345678901234567', character: `${prefix}낮은최고` },
    { userId: 'kakao:high', character: `${prefix}높은최고` },
    { userId: 'kakao:support', character: `${prefix}서포터` },
    { userId: 'kakao:failed', character: `${prefix}조회실패` },
    { userId: 'kakao:missing', character: `${prefix}최고없음` },
  ];
  routes.set(entries[0].character, currentPage(entries[0].character, { current: 9000, peak: 4000 }));
  routes.set(entries[1].character, currentPage(entries[1].character, { current: 0, peak: 6000 }));
  routes.set(entries[2].character, currentPage(entries[2].character, { current: 5000, peak: 7000, support: true }));
  routes.set(entries[3].character, '<html>Unavailable</html>');
  routes.set(entries[4].character, currentPage(entries[4].character, { current: 8000, peak: null }));
  return entries;
}

test('spec board sorts stored peaks, separates supports and retains partial failures', async (t) => {
  t.mock.method(console, 'error', () => {});
  const entries = boardEntries('집계');
  const board = await specBoard(entries);
  assert.deepEqual(board.sections[0].ranked.map((entry) => entry.character), ['집계높은최고', '집계낮은최고']);
  assert.deepEqual(board.sections[1].ranked.map((entry) => entry.character), ['집계서포터']);
  assert.deepEqual(board.failed, ['집계조회실패', '집계최고없음']);
  assert.match(board.sections[0].lines[0], /6,000\.00/);
  assert.match(board.sections[0].lines[0], /중앙값 \+1,049\.8/);
  assert.doesNotMatch(board.failedHint, /검색\(갱신\)하면 다음부터 집계/);
});

function makeInteraction(platform, entries) {
  globalThis.__rankingFixtureLinks = Object.fromEntries(entries.map((entry) => [entry.userId, entry.character]));
  const replies = [];
  return {
    platform, replies, user: { id: entries[0].userId },
    guild: { members: { fetch: async ({ user }) => new Map(user.map((id) => [id, {}])) } },
    options: { getInteger: () => null },
    async deferReply() {},
    async reply(value) { replies.push(value); },
    async editReply(value) { replies.push(value); },
  };
}

test('production execute emits correct Discord and Kakao ranking payloads', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const platform of ['discord', 'kakao']) {
    const entries = boardEntries(`${platform}실행`);
    const interaction = makeInteraction(platform, entries);
    await execute(interaction);
    assert.equal(interaction.replies.length, 1);
    const reply = interaction.replies[0];
    if (platform === 'discord') {
      const embed = reply.embeds[0].toJSON();
      assert.match(embed.footer.text, /^3명 · 로펙 달성 최고 점수 순/);
      assert.match(embed.description, /높은최고[\s\S]*낮은최고/);
      assert.match(embed.description, /← 나/);
      assert.ok(embed.fields.some((field) => field.name.includes('서포터') && field.value.includes('서포터')));
      assert.ok(embed.fields.some((field) => field.name === '조회 안 됨' && field.value.includes('조회실패') && field.value.includes('최고없음')));
      assert.ok(JSON.stringify(embed).length < 6000);
    } else {
      assert.match(reply.content, /▸ 집계 3명/);
      assert.match(reply.content, /높은최고[\s\S]*낮은최고/);
      assert.match(reply.content, /조회 안 됨/);
      assert.match(reply.content, /조회실패/);
      assert.match(reply.content, /← 나/);
      assert.doesNotMatch(reply.content, /undefined|NaN/);
    }
    assert.equal(reply.components.length, 1);
  }
});

test('all-failure production replies keep every name without promising search fixes an outage', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const platform of ['discord', 'kakao']) {
    const entries = Array.from({ length: 18 }, (_, i) => ({ userId: `kakao:${i}`, character: `${platform}실패${i}` }));
    for (const entry of entries) routes.set(entry.character, '<html>Service unavailable</html>');
    const interaction = makeInteraction(platform, entries);
    await execute(interaction);
    const reply = interaction.replies[0];
    const text = platform === 'discord' ? JSON.stringify(reply.embeds[0].toJSON()) : reply.content;
    assert.match(text, /0명/);
    for (const entry of entries) assert.ok(text.includes(entry.character));
    assert.doesNotMatch(text, /검색\(갱신\)하면 다음부터 집계/);
    assert.doesNotMatch(text, /undefined|NaN/);
  }
  assert.equal(unexpectedRequests, 0);
  assert.equal(stateWrites, 0);
});
