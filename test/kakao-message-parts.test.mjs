import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createPhone, bridgeFixture, FIXTURE_ROOM_ID } from './helpers/messengerbot-phone.mjs';
import { toKakaoResponse, CHANNEL_LIMITS } from '../src/kakao/render.js';
import { handleBridgeMessage, handleSkillRequest, flattenResponse } from '../src/kakao/handler.js';
import { getResult, resultCount } from '../src/kakao/result-store.js';

const BASE = 'https://bot.example.invalid';
const SUMMARY = '캐릭터 요약\n공격력    123,456\n  세부 설명';
const EQUIPMENT = '장비 정보\n무기: +25\n투구: +20';
const payloads = () => [
  { content: SUMMARY, kakaoPreserveWhitespace: true, characterCard: '테스트캐릭터' },
  { content: EQUIPMENT, kakaoSeparateMessage: true },
];
let requestId = 0;
function commandMap(values, name = '정보') {
  return new Map([[name, {
    data: { name, toJSON: () => ({ name, options: [{ name: '닉네임', type: 3 }] }) },
    async execute(interaction) {
      await interaction.deferReply();
      await interaction.editReply(values[0]);
      for (const value of values.slice(1)) await interaction.followUp(value);
    },
  }]]);
}
async function bridge(values, name = '정보') {
  return handleBridgeMessage(bridgeFixture({ room: '테스트방', sender: `조회자${++requestId}`, text: `/${name} 테스트캐릭터` }),
    commandMap(values, name), { allowedRoomIds: [FIXTURE_ROOM_ID], baseUrl: BASE });
}
const fullResult = (text) => {
  const id = /\/p\/full\/([a-f0-9]{12})/.exec(text)?.[1];
  assert.ok(id, 'a truncated message retains a full-result link');
  const result = getResult(id);
  assert.ok(result);
  return result.text;
};

function phone(answer) {
  const device = createPhone({ answer });
  device.context.ROOMS = ['테스트방'];
  return {
    get sent() { return device.attempts.map(attempt => attempt.text); },
    requests: () => device.requests.length,
    deliver(message = '/정보 테스트캐릭터', room = '테스트방') {
      device.notify({ text: message, room });
      device.advance(60000);
    },
  };
}

test('only explicit bridge message boundaries are retained outside the skill JSON', () => {
  const response = toKakaoResponse(payloads(), { baseUrl: BASE, limits: CHANNEL_LIMITS.bridge });
  assert.deepEqual(response.bridgeMessages.map((part) => part.body), [SUMMARY, EQUIPMENT]);
  assert.equal(Object.getOwnPropertyDescriptor(response, 'bridgeMessages').enumerable, false);
  assert.equal(flattenResponse(response), `${SUMMARY}\n\n${EQUIPMENT}`);
  const json = JSON.parse(JSON.stringify(response));
  assert.deepEqual(Object.keys(json), ['version', 'template']);
  assert.equal('bridgeMessages' in json, false);
  assert.equal('messages' in json, false);
  assert.equal(JSON.stringify(json).includes('kakaoSeparateMessage'), false);
  const skill = toKakaoResponse(payloads(), { baseUrl: BASE });
  assert.equal('bridgeMessages' in skill, false);
  assert.equal(flattenResponse(skill), `${SUMMARY}\n\n${EQUIPMENT}`);
});

test('a card plus two ordered parts becomes a card and one combined body', async () => {
  const result = await bridge(payloads());
  assert.equal(result.link, `${BASE}/p/char/${encodeURIComponent('테스트캐릭터')}`);
  assert.equal(result.text, `${SUMMARY}\n\n${EQUIPMENT}`);
  assert.equal('messages' in result, false);
  const client = phone(result);
  client.deliver();
  assert.deepEqual(client.sent, [result.link, result.text]);
  assert.equal(client.requests(), 1);
});

test('part-specific link buttons stay with their text while a preview card suppresses duplicate image URLs', async () => {
  const result = await bridge([
    { content: '요약', files: [fileURLToPath(new URL('../assets/charts/parts-fixture.png', import.meta.url))],
      components: [{ components: [{ label: '원문', url: 'https://example.invalid/detail' }] }] },
    { content: EQUIPMENT, kakaoSeparateMessage: true },
  ]);
  assert.equal(result.link, `${BASE}/p/chart/parts-fixture`);
  assert.equal(result.text, `요약\n\n🔗 원문: https://example.invalid/detail\n\n${EQUIPMENT}`);
  assert.equal(result.text.includes('/assets/charts/'), false);
});

test('long parts retain a line-truncated body without publishing omitted equipment', async () => {
  const before = resultCount();
  const summary = '요약 시작\n' + '공격력    123456\n'.repeat(180) + '요약 마지막';
  const equipment = '장비 시작\n' + '장비 세부 설명 +25\n'.repeat(180) + '장비 마지막';
  const result = await bridge([
    { content: summary, kakaoPreserveWhitespace: true },
    { content: equipment, kakaoSeparateMessage: true },
  ]);
  assert.equal('messages' in result, false);
  assert.ok(result.text.length <= 2600);
  assert.ok(result.text.startsWith('요약 시작\n'));
  assert.ok(result.text.endsWith('…'));
  assert.ok(`${summary}\n\n${equipment}`.startsWith(result.text.slice(0, -1)));
  assert.equal(resultCount(), before);
});

test('a summary and short equipment message that fit 2600 characters retain both bodies', async () => {
  const summary = '캐릭터 요약\n' + '긴 설명\n'.repeat(450);
  const result = await bridge([{ content: summary }, { content: EQUIPMENT, kakaoSeparateMessage: true }]);
  assert.deepEqual(result.messages, [summary.trim(), EQUIPMENT]);
  assert.equal(result.text, `${summary.trim()}\n\n${EQUIPMENT}`);
});

test('two short parts keep their explicit full texts and the combined text retains both bodies', async () => {
  const summaryFull = `${SUMMARY}\n요약의 추가 상세`;
  const equipmentFull = `${EQUIPMENT}\n장비의 추가 상세`;
  const result = await bridge([
    { content: SUMMARY, kakaoPreserveWhitespace: true, kakaoFull: summaryFull },
    { content: EQUIPMENT, kakaoSeparateMessage: true, kakaoFull: equipmentFull },
  ]);
  assert.equal(fullResult(result.messages[0]), summaryFull);
  assert.equal(fullResult(result.messages[1]), equipmentFull);
  assert.ok(result.text.includes(SUMMARY));
  assert.ok(result.text.includes(EQUIPMENT));
});

test('unmarked followUps remain in their current message and opt-in requires true', async () => {
  const result = await bridge([
    { content: '요약' }, { content: '요약 안내' },
    { content: EQUIPMENT, kakaoSeparateMessage: true }, { content: '장비 안내' },
  ]);
  assert.deepEqual(result.messages, ['요약\n\n요약 안내', `${EQUIPMENT}\n\n장비 안내`]);
  for (const optIn of [undefined, false, 'true', 1]) {
    const ordinary = await bridge([{ content: '요약' }, { content: EQUIPMENT, kakaoSeparateMessage: optIn }]);
    assert.equal('messages' in ordinary, false);
    assert.equal(ordinary.text, `요약\n\n${EQUIPMENT}`);
  }
});

test('empty boundaries and a single flagged payload do not create empty chat messages', async () => {
  for (const values of [
    [{ content: SUMMARY, kakaoPreserveWhitespace: true, kakaoSeparateMessage: true }],
    [{ content: SUMMARY, kakaoPreserveWhitespace: true }, { content: '   ', kakaoSeparateMessage: true }],
  ]) {
    const result = await bridge(values);
    assert.equal('messages' in result, false);
    assert.equal(result.text, SUMMARY);
  }
});

test('oversized battle-power bridgeText keeps its precedence and ends with one ellipsis', async () => {
  const before = resultCount();
  const battle = '전투력 전문\n' + '분석 상세\n'.repeat(500);
  const result = await bridge([
    { content: '짧은 표시', kakaoBridgeText: battle, characterCard: '테스트캐릭터' },
    { content: EQUIPMENT, kakaoSeparateMessage: true },
  ], '전투력');
  assert.equal(result.link, null);
  assert.equal('messages' in result, false);
  assert.ok(result.text.length <= 2600);
  assert.match(result.text, /^전투력 전문\n/);
  assert.ok(result.text.endsWith('분석 상세…'));
  assert.equal(resultCount(), before);
});

test('the actual skill handler never exposes bridge arrays or opt-in fields', async () => {
  const result = await handleSkillRequest({ userRequest: { utterance: '/정보 테스트캐릭터', user: { id: 'skill-message-parts' } } },
    commandMap(payloads()), { baseUrl: BASE });
  assert.equal(result.version, '2.0');
  assert.equal('bridgeMessages' in result, false);
  assert.equal('messages' in result, false);
  assert.equal(JSON.stringify(result).includes('kakaoSeparateMessage'), false);
  assert.equal(flattenResponse(result), `${SUMMARY}\n\n${EQUIPMENT}`);
});

test('phone sends a valid array exactly once in order without trimming or duplicate legacy text', () => {
  const messages = ['  요약    값\n    다음 줄  ', '\n장비\n  무기 +25\n'];
  const client = phone({ text: '중복되면 안 되는 기존 본문', messages });
  client.deliver();
  assert.deepEqual(client.sent, messages);
  const single = phone({ text: '중복 금지', messages: ['한 메시지'] });
  single.deliver();
  assert.deepEqual(single.sent, ['한 메시지']);
});

test('phone validates every part before sending and falls back to legacy text for malformed arrays', () => {
  for (const messages of [undefined, null, [], '잘못된 배열', {}, { 0: '문자열', length: 1 },
    ['요약', ''], ['요약', ' \n\t'], ['요약', null], ['요약', 5], ['요약', {}]]) {
    const client = phone({ link: 'https://example.invalid/card', text: '요약\n\n장비 전체 본문', messages });
    client.deliver();
    assert.deepEqual(client.sent, ['https://example.invalid/card', '요약\n\n장비 전체 본문']);
  }
});

test('phone retains ordinary text, card-only and silent responses plus the existing room filter', () => {
  for (const [answer, expected] of [
    [{ text: '기존 단일 응답', link: null }, ['기존 단일 응답']],
    [{ text: null, link: 'https://example.invalid/card' }, ['https://example.invalid/card']],
    [{ text: null, messages: [] }, []],
  ]) {
    const client = phone(answer);
    client.deliver('.정보 테스트캐릭터');
    assert.deepEqual(client.sent, expected);
    client.deliver('/정보 테스트캐릭터', '허용되지 않은 방');
    assert.deepEqual(client.sent, expected);
    assert.equal(client.requests(), 1);
  }
});
