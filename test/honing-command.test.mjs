import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecute, adviceFor, boardLines, footerFor } from '../src/commands/honing.js';
import { planSegments } from '../src/honing-optimizer.js';
import { matchTextCommand } from '../src/text-commands.js';
import { KAKAO_MATCH_OPTIONS } from '../src/kakao/handler.js';
import { commands } from '../src/commands/index.js';

// `/강화` 표시 계층. 계산은 honing-optimizer 시험에서 검산하고 여기서는 문구와 입력만 본다.
const commandMap = new Map(commands.map(command => [command.data.name, command]));
// 구간은 계획에서 실제 코드로 만든다 — 손으로 적으면 둘이 어긋나도 시험이 통과한다.
const stage = (plan, extra = {}) => ({ from: 18, to: 19, successBps: 300, expectedGold: 100, plainGold: 150,
  expectedAttempts: 11.6, breathName: '용암의 숨결', bookName: '야금술 : 업화 [19-20]',
  plan, segments: planSegments(plan), ...extra });
const row = (attempt, breath, book, reach = 1) => ({ attempt, breath, book, gold: 1, successBps: 600,
  reachProbability: reach, guaranteed: false });

function interaction({ kind = 'weapon', from = 18, to = 20, platform = null } = {}) {
  const sent = [];
  return { sent, value: () => sent[sent.length - 1], api: { platform,
    options: { getString: () => kind, getInteger: name => (name === '현재' ? from : to) },
    reply: async value => { sent.push(value); },
    deferReply: async () => { sent.push('deferred'); },
    editReply: async value => { sent.push(value); } } };
}
const okPrices = { load: async () => ({ priceOf: () => 1, at: Date.now(), missing: [] }) };
const result = {
  status: 'ok', kind: 'weapon', from: 18, to: 19, expectedGold: 100, plainGold: 150, notes: [],
  stages: [stage([row(1, 0, true), row(2, 0, true)])],
};

test('조언은 같은 선택끼리 묶고, 닿기 어려운 뒷구간은 적지 않는다', () => {
  assert.equal(adviceFor(stage([row(1, 0, false), row(2, 0, false)])), '보조 재료 없이');
  assert.equal(adviceFor(stage([row(1, 5, true), row(2, 5, true)])), '책 1개 + 숨결 5개');
  // 뒷구간에 닿을 확률이 낮으면 첫 구간만 적는다.
  assert.equal(adviceFor(stage([row(1, 0, true), row(2, 0, true), row(3, 4, false, 0.001)])), '책 1개');
  // 실제로 닿는 구간이면 어느 회차가 어떤 선택인지 범위로 적는다.
  assert.equal(adviceFor(stage([row(1, 0, true), row(2, 0, true), row(3, 4, false, 0.4)])), '1-2회 책 1개 · 3회 숨결 4개');
  // 선택이 번갈아 바뀌면 그대로 다 적는다 — 「그 뒤 계속 같다」고 말하지 않는다(P2-3 회귀).
  assert.equal(
    adviceFor(stage([row(1, 0, false), row(2, 0, false), row(3, 1, false, 0.9), row(4, 0, false, 0.8), row(5, 1, false, 0.7)])),
    '1-2회 보조 재료 없이 · 3회 숨결 1개 · 4회 보조 재료 없이 · 5회 숨결 1개');
  // 닿는 구간이 다섯 개여도 자르지 않는다 — 펼쳐 볼 수단이 없는데 「그 뒤」로 감추면 안 된다.
  const many = adviceFor(stage([row(1, 0, false), row(2, 1, false, 0.9), row(3, 0, false, 0.8),
    row(4, 1, false, 0.7), row(5, 0, false, 0.6)]));
  assert.equal(many, '1회 보조 재료 없이 · 2회 숨결 1개 · 3회 보조 재료 없이 · 4회 숨결 1개 · 5회 보조 재료 없이');
  assert.equal(/전체 보기|그 뒤/.test(many), false, '없는 전체 보기를 약속하지 않는다');
  // 확정 성공 회차는 조언에서 뺀다.
  assert.equal(adviceFor(stage([{ ...row(1, 0, true) }, { ...row(2, 0, false), guaranteed: true }])), '책 1개');
});

test('본문에 단계별 금액과 아끼는 금액이 들어간다', () => {
  const lines = boardLines(result);
  const text = lines.join('\n');
  assert.ok(text.includes('무기 +18 → +19'));
  assert.ok(text.includes('+18→+19 · 기본 3% · 100 G'));
  assert.ok(text.includes('책 1개'));
  assert.ok(text.includes('합계 100 G'));
  assert.ok(text.includes('50 G 아낍니다 (33.3%)'));
});

test('푸터는 시세 나이와 빠진 자료를 알린다', () => {
  const at = Date.now();
  assert.ok(footerFor(result, at, at).includes('방금 조회한 시세'));
  assert.ok(footerFor(result, at, at + 3 * 60000).includes('3분 전 시세'));
  const noted = footerFor({ ...result, notes: ['book_none_for_stage', 'breath_price_unavailable'] }, at, at);
  assert.ok(noted.includes('+21 이상은 거래소에 재련 책이 없어'));
  assert.ok(noted.includes('숨결 시세를 받지 못해'));
  // 모르는 사유는 푸터에 글자로 새지 않는다.
  assert.equal(footerFor({ ...result, notes: ['무슨사유'] }, at, at).includes('무슨사유'), false);
});

test('목표가 현재보다 낮으면 계산하지 않고 사용법만 알린다', async () => {
  let asked = 0;
  const execute = createExecute({ prices: { load: async () => { asked += 1; return { priceOf: () => 1, at: 0, missing: [] }; } },
    optimize: () => result });
  const call = interaction({ from: 20, to: 18 });
  await execute(call.api);
  assert.equal(call.value(), '현재 단계보다 높은 목표 단계를 적어 주세요 (0~25)');
  assert.equal(asked, 0, '거래소를 조회하지 않는다');
});

test('시세를 받지 못하면 계산하지 않고 그대로 알린다', async () => {
  let optimized = 0;
  const execute = createExecute({ prices: { load: async () => ({ priceOf: () => null, at: 0, missing: ['운명의 파괴석'] }) },
    optimize: () => { optimized += 1; return result; } });
  const call = interaction();
  await execute(call.api);
  assert.ok(String(call.value()).includes('시세를 받지 못했어요'));
  assert.equal(optimized, 0);
});

test('양 플랫폼이 같은 본문을 쓰고 카톡은 평문으로 답한다', async () => {
  const execute = createExecute({ prices: okPrices, optimize: () => result });
  const discord = interaction();
  await execute(discord.api);
  const embed = discord.value().embeds[0].data;
  assert.equal(embed.title, '⚒️ 무기 재련 최저 비용');
  assert.ok(embed.description.includes('합계 100 G'));

  const kakao = interaction({ platform: 'kakao' });
  await execute(kakao.api);
  const content = kakao.value().content;
  assert.equal(typeof content, 'string');
  assert.ok(content.includes('❙ 무기 재련 최저 비용'));
  assert.ok(content.includes('합계 100 G'));
  assert.equal(content.includes('**'), false, '카톡에는 마크다운을 넣지 않는다');
});

test('채팅 별칭은 부위를 생략하면 무기로 보고, 어긋난 입력은 사용법을 준다', () => {
  const discord = text => matchTextCommand(text, commandMap);
  assert.deepEqual(discord('ㄱㅎ 무기 18 20').options, { 부위: 'weapon', 현재: 18, 목표: 20 });
  assert.deepEqual(discord('ㄱㅎ 18 20').options, { 부위: 'weapon', 현재: 18, 목표: 20 });
  assert.deepEqual(discord('.강화 방어구 20 23').options, { 부위: 'armor', 현재: 20, 목표: 23 });
  assert.deepEqual(discord('ㄱㅎ 방 18 21').options, { 부위: 'armor', 현재: 18, 목표: 21 });
  for (const bad of ['ㄱㅎ 무기', 'ㄱㅎ 무기 20 18', 'ㄱㅎ 18 26', 'ㄱㅎ 무기 방어구 18 20']) {
    assert.equal(typeof discord(bad).usage, 'string', bad);
  }
  // 카톡은 AGENTS.md 명령 입력 규칙대로 **접두사 없는 단독 초성도** 받는다.
  const kakao = text => matchTextCommand(text, commandMap, KAKAO_MATCH_OPTIONS);
  assert.deepEqual(kakao('ㄱㅎ 무기 18 20').options, { 부위: 'weapon', 현재: 18, 목표: 20 });
  assert.deepEqual(kakao('.ㄱㅎ 무기 18 20').options, { 부위: 'weapon', 현재: 18, 목표: 20 });
  assert.deepEqual(kakao('/ㄱㅎ 18 20').options, { 부위: 'weapon', 현재: 18, 목표: 20 });
  assert.ok(KAKAO_MATCH_OPTIONS.bareAliases.includes('ㄱㅎ'), '허용 목록에 들어 있어야 방에서 전달된다');
});

test('명령 정의가 등록돼 있고 옵션이 세 개다', () => {
  const definition = commandMap.get('강화').data.toJSON();
  assert.deepEqual(definition.options.map(option => option.name), ['부위', '현재', '목표']);
  assert.equal(definition.options.every(option => option.required), true);
  assert.ok(definition.description.length <= 100);
});

test('봇 시세는 0·null·음수 최저가를 공짜로 받지 않고 시세 없음으로 둔다', async () => {
  const { createHoningPrices } = await import('../src/honing-prices.js');
  const rows = {
    50010: [
      { Name: '운명의 파괴석', CurrentMinPrice: 0, BundleCount: 100 },
      { Name: '운명의 수호석', CurrentMinPrice: null, BundleCount: 100 },
      { Name: '운명의 돌파석', CurrentMinPrice: -3, BundleCount: 1 },
      { Name: '운명의 파편 주머니(대)', CurrentMinPrice: 143, BundleCount: 1 },
      { Name: '아비도스 융화 재료', CurrentMinPrice: 30, BundleCount: 1 },
    ],
    50020: [{ Name: '용암의 숨결', CurrentMinPrice: 439, BundleCount: 1 }],
  };
  let calls = 0;
  const prices = createHoningPrices({ search: async (category) => {
    calls += 1;
    const items = rows[category] ?? [];
    return { Items: items, TotalCount: items.length, PageSize: 10 };
  } });
  const first = await prices.load();
  assert.equal(first.priceOf('운명의 파괴석'), null, '0은 공짜가 아니다');
  assert.equal(first.priceOf('운명의 수호석'), null);
  assert.equal(first.priceOf('운명의 돌파석'), null);
  assert.ok(first.missing.includes('운명의 파괴석'), first.missing.join(','));
  // 불완전한 판은 캐시하지 않으므로 다음 요청에서 다시 조회한다.
  const before = calls;
  await prices.load();
  assert.ok(calls > before, '불완전한 판을 캐시하지 않는다');
});
