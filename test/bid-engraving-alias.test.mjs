import { bridgeFixture, fixtureRoomIdentity, FIXTURE_ROOM_ID, createPhone } from './helpers/messengerbot-phone.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 분배금 각인서명 띄어쓰기 생략과 /경매금·ㄱㅁㄱ — 실제 진입점(디스코드 텍스트·카톡 브리지)을 고정 거래소 응답으로 검증한다.
for (const name of Object.keys(process.env)) {
  if (/(?:KEY|TOKEN|SECRET)/i.test(name)) delete process.env[name];
}

// 거래소 유물 각인서 품명 목록(2쪽 분량)과 정확 검색. 검색어는 실제 API처럼 문자열 포함으로만 맞춘다 — 띄어쓰기 없는 검색어는 0건.
const BOOKS = ['원한', '예리한 둔기', '기습의 대가', '돌격대장', '아드레날린', '저주받은 인형', '질량 증가', '타격의 대가',
  '안정된 상태', '정기 흡수', '슈퍼 차지', '바리케이드', '결투의 대가'].map((n) => `유물 ${n} 각인서`);
const PRICE = { '유물 질량 증가 각인서': 1200, '유물 저주받은 인형 각인서': 45000 };
const item = (Name) => ({ Name, Grade: '유물', CurrentMinPrice: PRICE[Name] ?? 777, BundleCount: 1, YDayAvgPrice: 0, RecentPrice: 0 });
const requests = [];
let failMarket = false;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  assert.equal(url.pathname, '/markets/items');
  const body = JSON.parse(options.body);
  requests.push(body);
  if (failMarket) return { ok: false, status: 503, json: async () => ({}) };
  assert.equal(body.CategoryCode, 40000);
  assert.equal(body.ItemGrade, '유물');
  if (body.ItemName === '') {
    const page = body.PageNo ?? 1;
    const Items = BOOKS.slice((page - 1) * 10, page * 10).map(item);
    return { ok: true, status: 200, json: async () => ({ PageNo: page, PageSize: 10, TotalCount: BOOKS.length, Items }) };
  }
  const Items = BOOKS.filter((b) => b.includes(body.ItemName)).map(item);
  return { ok: true, status: 200, json: async () => ({ PageNo: 1, PageSize: 10, TotalCount: Items.length, Items }) };
};

const { commands, kakaoCommands } = await import('../src/commands/index.js');
const { matchTextCommand, handleTextCommand } = await import('../src/text-commands.js');
const { handleBridgeMessage, KAKAO_MATCH_OPTIONS } = await import('../src/kakao/handler.js');
const bid = await import('../src/commands/bid.js');
const discordMap = new Map(commands.map((command) => [command.data.name, command]));
const kakaoMap = new Map(kakaoCommands.map((command) => [command.data.name, command]));

function message(content) {
  const payloads = [];
  return {
    content, payloads, author: { id: 'bid-fixture-user' },
    channelId: 'bid-fixture-channel', guildId: 'bid-fixture-guild',
    channel: { async sendTyping() {}, async send(payload) { payloads.push(payload); } },
    async reply(payload) { payloads.push(payload); },
  };
}
const embedOf = (payloads) => payloads.at(-1).embeds[0].toJSON();
let bridgeId = 0;
const bridge = (text) => handleBridgeMessage(bridgeFixture({ text, room: '검증방', sender: `검증사용자-${++bridgeId}` }),
  kakaoMap, { allowedRoomIds: [FIXTURE_ROOM_ID], baseUrl: 'https://example.test', budgetMs: 2000 });
const listPages = () => requests.filter((r) => r.ItemName === '').map((r) => r.PageNo);

test('띄어쓰기 없는 각인서명은 품명 목록으로 정식 품명을 찾아 현재 최저가로 계산한다', async () => {
  bid.resetBookListCache();
  requests.length = 0;
  const answer = await bridge('ㅂㅂㄱ 질량증가 8');
  assert.match(answer.text, /분배금 계산기 — 시세 1,200G\n유물 질량 증가 각인서 · 현재 최저가/);
  assert.match(answer.text, /8인: /);
  assert.doesNotMatch(answer.text, /4인: |16인: /);
  // 정확 조회(0건) → 목록 2쪽 → 정식 품명으로 정확 조회
  assert.deepEqual(requests.map((r) => r.ItemName), ['유물 질량증가 각인서', '', '', '유물 질량 증가 각인서']);
  assert.deepEqual(listPages(), [1, 2]);

  // 목록은 캐시되어 다음 붙여쓴 이름은 정확 조회 2회뿐
  requests.length = 0;
  const msg = message('.분배금 저주받은인형');
  assert.equal(await handleTextCommand(msg, discordMap), true);
  assert.equal(embedOf(msg.payloads).description, '유물 저주받은 인형 각인서 · 현재 최저가');
  assert.equal(embedOf(msg.payloads).title, '분배금 계산기 — 시세 45,000G');
  assert.deepEqual(listPages(), []);
});

test('정식 이름·줄임말은 목록 없이 한 번에 찾고, 없는 이름은 계산하지 않는다', async () => {
  bid.resetBookListCache();
  requests.length = 0;
  assert.match((await bridge('/분배금 질량 증가')).text, /유물 질량 증가 각인서 · 현재 최저가/);
  assert.match((await bridge('ㅂㅂㄱ 질증 4')).text, /유물 질량 증가 각인서 · 현재 최저가/);
  assert.deepEqual(listPages(), []);
  assert.equal((await bridge('ㅂㅂㄱ 질량의증가')).text, '유물 각인서를 찾지 못했어요. 정확한 각인서명을 입력해 주세요.');
  assert.deepEqual(listPages(), [1, 2]);

  bid.resetBookListCache();
  failMarket = true;
  try {
    assert.equal((await bridge('ㄱㅁㄱ 질량증가')).text, '유물 각인서 시세를 조회하지 못했어요. 잠시 후 다시 시도해 주세요.');
  } finally { failMarket = false; }
  requests.length = 0;
  assert.match((await bridge('ㄱㅁㄱ 8800 4')).text, /4인: 5,700G/); // 숫자 입력은 시세 조회 없음
  assert.equal(requests.length, 0);
});

test('/경매금은 /분배금과 같은 정의·실행의 기본 명령이고 별칭 ㄱㅁㄱ는 슬래시에 등록하지 않는다', () => {
  assert.equal(commands.length, 70);
  assert.equal(kakaoCommands.length, 73);
  const auction = discordMap.get('경매금');
  const share = discordMap.get('분배금');
  assert.ok(auction && share);
  assert.deepEqual(auction.data.toJSON().options, share.data.toJSON().options);
  assert.equal(auction.data.toJSON().description, share.data.toJSON().description);
  assert.equal(auction.execute, share.execute);
  assert.equal(discordMap.has('ㄱㅁㄱ'), false);
});

test('디스코드는 ㄱㅁㄱ 접두사 없이·.경매금은 점 필수, 카톡은 ㄱㅁㄱ·/경매금·.ㄱㅁㄱ 모두 받고 사용법은 친 접두사로 안내한다', async () => {
  for (const [input, options] of [
    ['ㄱㅁㄱ 4000', { 가격: 4000 }], ['ㄱㅁㄱ 질량증가 8', { 각인서: '질량증가', 인원: 8 }],
    ['.경매금 저주받은 인형', { 각인서: '저주받은 인형' }], ['!ㄱㅁㄱ 4000 16', { 가격: 4000, 인원: 16 }],
  ]) {
    const matched = matchTextCommand(input, discordMap);
    assert.equal(matched?.command.data.name, '경매금', input);
    assert.deepEqual(matched.options, options, input);
  }
  assert.equal(matchTextCommand('경매금 4000', discordMap), null);
  assert.equal(matchTextCommand('ㄱㅁㄱㅁ 4000', discordMap), null);
  assert.match(matchTextCommand('ㄱㅁㄱ', discordMap).usage, /^ㄱㅁㄱ 가격\|각인서명 \[인원\]/);
  const msg = message('ㄱㅁㄱ 8800');
  assert.equal(await handleTextCommand(msg, discordMap), true);
  assert.equal(embedOf(msg.payloads).fields[0].value, '4인: 5,700G\n8인: 6,650G\n16인: 7,125G');

  assert.ok(KAKAO_MATCH_OPTIONS.bareAliases.includes('ㄱㅁㄱ'));
  for (const input of ['ㄱㅁㄱ 8800', '/경매금 8800', '.ㄱㅁㄱ 8800', '/ㄱㅁㄱ 8800', '.경매금 8800']) {
    assert.equal(matchTextCommand(input, kakaoMap, KAKAO_MATCH_OPTIONS)?.command.data.name, '경매금', input);
    assert.match((await bridge(input)).text, /^분배금 계산기 — 시세 8,800G\n\n❙ 추천 입찰가 · 선점 기준\n4인: 5,700G/, input);
  }
  assert.equal((await bridge('경매금 8800')).text, null);
  assert.equal((await bridge('ㄱㅁㄱㅁ 8800')).text, null);
  assert.equal((await bridge('/ㄱㅁㄱ')).text, '사용법: /ㄱㅁㄱ 가격|각인서명 [인원] (예: /ㄱㅁㄱ 4000 · /ㄱㅁㄱ 원한 8, 각인서는 유물만)');
  assert.equal((await bridge('ㄱㅁㄱ')).text, '사용법: ㄱㅁㄱ 가격|각인서명 [인원] (예: ㄱㅁㄱ 4000 · ㄱㅁㄱ 원한 8, 각인서는 유물만)');
});

test('ㄱㅁ는 ㄱㅁㄱ의 더 짧은 초성으로 디스코드·카톡에서 똑같이 경매금이고 ㄱㅁㅈ는 그대로 경매장이다', async () => {
  for (const [input, options] of [
    ['ㄱㅁ 4000', { 가격: 4000 }], ['ㄱㅁ 원한 8', { 각인서: '원한', 인원: 8 }], ['ㄱㅁ 질량증가', { 각인서: '질량증가' }],
    ['.ㄱㅁ 4000 16', { 가격: 4000, 인원: 16 }],
  ]) {
    const matched = matchTextCommand(input, discordMap);
    assert.equal(matched?.command.data.name, '경매금', input);
    assert.deepEqual(matched.options, options, input);
  }
  assert.match(matchTextCommand('ㄱㅁ', discordMap).usage, /^ㄱㅁ 가격\|각인서명 \[인원\]/);
  assert.equal(matchTextCommand('ㄱㅁa 4000', discordMap), null);
  assert.equal(matchTextCommand('ㄱㅁㅈ 10겁', discordMap)?.command.data.name, '경매장');
  assert.equal(matchTextCommand('ㄱㅁㄱ 4000', discordMap)?.command.data.name, '경매금');
  const msg = message('ㄱㅁ 8800');
  assert.equal(await handleTextCommand(msg, discordMap), true);
  assert.equal(embedOf(msg.payloads).fields[0].value, '4인: 5,700G\n8인: 6,650G\n16인: 7,125G');

  assert.ok(KAKAO_MATCH_OPTIONS.bareAliases.includes('ㄱㅁ'));
  assert.equal(matchTextCommand('ㄱㅁㅈ 10겁', kakaoMap, KAKAO_MATCH_OPTIONS)?.command.data.name, '경매장');
  bid.resetBookListCache();
  requests.length = 0;
  const answer = await bridge('ㄱㅁ 질량증가 8');
  assert.match(answer.text, /분배금 계산기 — 시세 1,200G\n유물 질량 증가 각인서 · 현재 최저가/);
  assert.match(answer.text, /8인: /);
  assert.deepEqual(requests.map((r) => r.ItemName), ['유물 질량증가 각인서', '', '', '유물 질량 증가 각인서']);
  for (const input of ['ㄱㅁ 8800', '.ㄱㅁ 8800', '/ㄱㅁ 8800']) {
    assert.match((await bridge(input)).text, /^분배금 계산기 — 시세 8,800G\n\n❙ 추천 입찰가 · 선점 기준\n4인: 5,700G/, input);
  }
  assert.equal((await bridge('ㄱㅁ')).text, '사용법: ㄱㅁ 가격|각인서명 [인원] (예: ㄱㅁ 4000 · ㄱㅁ 원한 8, 각인서는 유물만)');
  assert.equal((await bridge('.ㄱㅁ')).text, '사용법: .ㄱㅁ 가격|각인서명 [인원] (예: .ㄱㅁ 4000 · .ㄱㅁ 원한 8, 각인서는 유물만)');
  assert.equal((await bridge('ㄱㅁa 4000')).text, null);
  assert.equal(discordMap.has('ㄱㅁ'), false);
  assert.equal(commands.length, 70);
});

test('폰 스크립트 입력 필터는 접두사 없는 ㄱㅁㄱ를 첫 단어가 정확히 일치할 때만 통과시킨다', () => {
  const source = readFileSync(new URL('../scripts/messengerbot-r.js', import.meta.url), 'utf8');
  const match = /var isBareAlias = (\/\^\\s\*\(\?:[^)]+\)\(\?:\\s\|\$\)\/)\.test\(msg\)/.exec(source);
  assert.ok(match, 'isBareAlias 정규식');
  const bare = new RegExp(match[1].slice(1, -1));
  for (const text of ['ㄱㅁㄱ 4000', 'ㄱㅁㄱ', ' ㄱㅁㄱ 원한 8', 'ㅂㅂㄱ 질량증가', 'ㄱㅁㅈ 10겁', 'ㄱㅁ 4000', 'ㄱㅁ', ' ㄱㅁ 원한 8']) assert.ok(bare.test(text), text);
  for (const text of ['ㄱㅁㄱㅁ 4000', '경매금 4000', '아 ㄱㅁㄱ', 'ㄱㅁa 4000', 'ㄱㅁ4000', 'ㄱㅁㅁ 4000']) assert.ok(!bare.test(text), text);
  // ㄱㅁ ㄱ 4000은 ㄱㅁ가 첫 단어라 폰에서는 통과하고 서버가 각인서명 "ㄱ"으로 처리한다(이전엔 차단)
  assert.ok(bare.test('ㄱㅁ ㄱ 4000'));
});
