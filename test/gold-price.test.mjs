import test from 'node:test';
import assert from 'node:assert/strict';
import { GOLD_SERVERS, normalizeDayRows, pickCurrent, boardLine, boardLines, createGoldPriceBoard, BOARD_TITLE } from '../src/gold-price.js';
import { createExecute, UNAVAILABLE } from '../src/commands/gold-price.js';

// 2026-09-19 22:30 KST — 게임비트 일봉의 마지막 봉이 오늘 진행 중인 가격이다. 그 값을 적고 전일 종가와 견준다.
const NOW = Date.UTC(2026, 8, 19, 13, 30);
const midnight = (y, m, d) => Math.floor((Date.UTC(y, m - 1, d) - 9 * 3600 * 1000) / 1000);
const candle = (time, close) => ({ time, open: close, high: close, low: close, close, volume: 1 });
const days = (closes) => closes.map((close, i) => candle(midnight(2026, 9, 16 + i), close));
// 마지막 두 값이 전일 종가와 오늘 가격 — 사용자가 보여 준 예시와 같은 여덟 줄이 나오게 잡았다.
const closesBySid = {
  1845: [700, 720, 757.6, 755.4], // 실리안 755 (📉 3) — 반올림 뒤 뺀다
  1848: [700, 720, 765, 754], //     카마인 754 (📉 11)
  1850: [700, 720, 760, 760], //     카단 760 (📉 0)
  1849: [700, 720, 764, 764], //     카제로스 764 (📉 0)
  1844: [700, 720, 768, 761], //     루페온 761 (📉 7)
  2072: [700, 720, 757, 759], //     니나브 759 (📈 2)
  1846: [700, 720, 759, 773], //     아만 773 (📈 14)
  1847: [700, 720, 777, 772], //     아브렐슈드 772 (📉 5)
};
const EXPECTED = [
  '• 실리안: 755원 (📉 3)', '• 카마인: 754원 (📉 11)', '• 카단: 760원 (📉 0)', '• 카제로스: 764원 (📉 0)',
  '• 루페온: 761원 (📉 7)', '• 니나브: 759원 (📈 2)', '• 아만: 773원 (📈 14)', '• 아브렐슈드: 772원 (📉 5)',
];
function fakeFetch({ fail = new Set(), calls = [] } = {}) {
  return async (url) => {
    const sid = Number(new URL(url).searchParams.get('sid'));
    calls.push(sid);
    if (fail.has(sid)) return { ok: false, status: 502, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify(days(closesBySid[sid])) };
  };
}
function interaction(platform) {
  const replies = [];
  return { platform, replies, async deferReply() {}, async reply(value) { replies.push(value); }, async editReply(value) { replies.push(value); } };
}

test('the running day is the shown price, the change is against the previous day and the arrow follows its sign', () => {
  const rows = normalizeDayRows(days(closesBySid[1845]), NOW);
  assert.deepEqual(rows.map((row) => row.date), ['2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19']);
  assert.deepEqual(pickCurrent(rows), { date: '2026-09-19', price: 755, diff: -3 });
  assert.equal(boardLine({ name: '실리안', price: 755, diff: -3 }), '• 실리안: 755원 (📉 3)');
  assert.equal(boardLine({ name: '니나브', price: 759, diff: 2 }), '• 니나브: 759원 (📈 2)');
  assert.equal(boardLine({ name: '카단', price: 760, diff: 0 }), '• 카단: 760원 (📉 0)');
  assert.equal(boardLine({ name: '아만', price: 1234, diff: null }), '• 아만: 1,234원');
  assert.equal(boardLine({ name: '카마인', error: true }), '• 카마인: 조회 실패');
  // 전날 봉이 없거나 하루 건너뛴 자료면 변동을 비운다. 봉이 하나도 없으면 null.
  assert.deepEqual(pickCurrent(normalizeDayRows([candle(midnight(2026, 9, 19), 800)], NOW)), { date: '2026-09-19', price: 800, diff: null });
  assert.deepEqual(pickCurrent(normalizeDayRows([candle(midnight(2026, 9, 16), 700), candle(midnight(2026, 9, 19), 800)], NOW)),
    { date: '2026-09-19', price: 800, diff: null });
  assert.equal(pickCurrent([]), null);
  for (const bad of [[], [{ time: 1, close: 1 }], [candle(midnight(2026, 9, 18), 0)], [candle(midnight(2026, 9, 18) + 60, 700)]]) {
    assert.throws(() => normalizeDayRows(bad, NOW));
  }
});

test('the board reads eight servers in the given order, caches a complete board and retries a partial one', async () => {
  const calls = [];
  const board = createGoldPriceBoard({ fetchImpl: fakeFetch({ calls }), now: () => NOW });
  const first = await board.get();
  assert.deepEqual(first.servers.map((row) => row.name), GOLD_SERVERS.map((row) => row.name));
  assert.deepEqual(boardLines(first), EXPECTED);
  assert.equal(first.date, '2026-09-19'); assert.equal(first.complete, true);
  await board.get();
  assert.equal(calls.length, 8, 'a complete board is served from the cache');
  const failing = [];
  const partial = createGoldPriceBoard({ fetchImpl: fakeFetch({ calls: failing, fail: new Set([1850]) }), now: () => NOW });
  const one = await partial.get();
  assert.equal(one.complete, false);
  assert.equal(boardLines(one)[2], '• 카단: 조회 실패');
  await partial.get();
  assert.equal(failing.length, 16, 'a partial board is read again on the next request');
});

test('the command prints the requested layout on KakaoTalk and an embed with a source footer on Discord', async () => {
  const board = createGoldPriceBoard({ fetchImpl: fakeFetch(), now: () => NOW });
  const execute = createExecute({ board });
  const kakao = interaction('kakao');
  await execute(kakao);
  assert.equal(kakao.replies[0], [`❙ ${BOARD_TITLE}`, ...EXPECTED].join('\n'));
  const discord = interaction('discord');
  await execute(discord);
  const embed = discord.replies[0].embeds[0].toJSON();
  assert.equal(embed.title, '💰 골드 시세');
  assert.match(embed.description, /^\*\*중개 사이트 기준 \(전일기준\/10,000당\)\*\*\n• 실리안: 755원 \(📉 3\)\n/);
  assert.equal(embed.footer.text, '게임비트 · 9/19 현재가 · 전일 대비 변동 · 조회 9/19 22:30');
  // 모든 서버가 실패하면 안내 한 줄.
  const down = createExecute({ board: createGoldPriceBoard({ fetchImpl: fakeFetch({ fail: new Set(GOLD_SERVERS.map((row) => Number(row.sid))) }), now: () => NOW }) });
  const failed = interaction('kakao');
  await down(failed);
  assert.equal(failed.replies[0], UNAVAILABLE);
});
