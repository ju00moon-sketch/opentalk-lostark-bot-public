import { bridgeFixture, fixtureRoomIdentity, FIXTURE_ROOM_ID, createPhone } from './helpers/messengerbot-phone.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

// Import the real command maps with no credentials, persistent writes, or network access.
for (const name of Object.keys(process.env)) {
  if (/(?:KEY|TOKEN|SECRET)/i.test(name)) delete process.env[name];
}
process.env.OPENAI_API_KEY = 'chat-fixture-key';
let stateWrites = 0;
globalThis.__chatCommandWrite = () => { stateWrites += 1; throw new Error('Unexpected state write'); };
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/src/json-store.js')) return {
      format: 'module', shortCircuit: true,
      source: `
        export class CorruptStoreError extends Error {}
        export const readJson = (path, fallback) => structuredClone(fallback);
        export const readJsonLenient = readJson;
        export const writeJsonAtomic = (...args) => globalThis.__chatCommandWrite(...args);
      `,
    };
    return nextLoad(url, context);
  },
});

const requests = [];
let answerText = '검증 답변입니다.';
let responseDelayMs = 0;
let responseError = null;
globalThis.fetch = async (input, options = {}) => {
  assert.equal(String(input), 'https://api.openai.com/v1/responses');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer chat-fixture-key');
  const body = JSON.parse(options.body);
  requests.push(body);
  if (responseDelayMs) await delay(responseDelayMs);
  if (responseError) throw responseError;
  let text = answerText;
  if (body.text?.format?.name === 'versus_result') text = JSON.stringify({
    comparable: true, winner: body.text.format.schema.properties.winner.enum[0], comment: '오늘은 이쪽이에요.',
  });
  return { ok: true, status: 200, json: async () => ({ status: 'completed', output: [
    { type: 'message', status: 'completed', content: [{ type: 'output_text', text }] },
  ] }) };
};

const { commands, kakaoCommands } = await import('../src/commands/index.js');
const { matchTextCommand, handleTextCommand } = await import('../src/text-commands.js');
const { handleBridgeMessage, handleSkillRequest, KAKAO_MATCH_OPTIONS } = await import('../src/kakao/handler.js');
const { resultCount } = await import('../src/kakao/result-store.js');
const { createClient, generateQuip } = await import('../src/quip.js');
const discordMap = new Map(commands.map((command) => [command.data.name, command]));
const kakaoMap = new Map(kakaoCommands.map((command) => [command.data.name, command]));

let userId = 0;
function interaction(question) {
  const payloads = [];
  return {
    payloads, user: { id: `chat-slash-${++userId}` },
    options: { getString: (name) => name === '질문' ? question : null },
    async deferReply() {},
    async reply(payload) { payloads.push(payload); },
    async editReply(payload) { payloads.push(payload); },
  };
}

function message(content) {
  const payloads = [];
  return {
    content, payloads, author: { id: `chat-text-${++userId}` },
    channelId: 'chat-fixture-channel', guildId: 'chat-fixture-guild',
    channel: { async sendTyping() {}, async send(payload) { payloads.push(payload); } },
    async reply(payload) { payloads.push(payload); },
  };
}

const bridgeBody = (text) => bridgeFixture({ text, room: '검증방', sender: `검증사용자-${++userId}` });
const bridge = (text, map = kakaoMap) => handleBridgeMessage(bridgeBody(text), map,
  { allowedRoomIds: [FIXTURE_ROOM_ID], baseUrl: 'https://example.test', budgetMs: 1000 });
const skill = (utterance) => handleSkillRequest({
  userRequest: { utterance, user: { id: `chat-skill-${++userId}` } },
}, kakaoMap, { allowedRoomIds: [FIXTURE_ROOM_ID], baseUrl: 'https://example.test', budgetMs: 1000 });
const contentOf = (payload) => typeof payload === 'string' ? payload : payload.content;
const skillText = (response) => response.template.outputs.map((item) => item.simpleText?.text ?? '').join('\n');

test('only the official 챗 slash command is registered with one required question', () => {
  for (const list of [commands, kakaoCommands]) {
    const names = list.map((command) => command.data.toJSON().name);
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual(names.filter((name) => /^(?:챗|채팅|chat|ㅊ)$/u.test(name)), ['챗']);
  }
  const definition = discordMap.get('챗').data.toJSON();
  assert.equal(definition.options.length, 1);
  assert.equal(definition.options[0].name, '질문');
  assert.equal(definition.options[0].type, 3);
  assert.equal(definition.options[0].required, true);
  assert.equal(definition.options[0].min_length, 1);
  assert.equal(definition.options[0].max_length, 2000);
});

test('real slash and Discord text execution preserve questions and suppress mentions', async () => {
  const questions = ['무지개는 왜 생겨?', '질문:첫부분 뒤 문장', 'A vs B를 비교해 줘',
    '"따옴표"  두 칸\n다음 줄\t들여쓰기', '가'.repeat(501), '나'.repeat(2000)];
  for (const question of questions) {
    const slash = interaction(question);
    const typed = message(`.챗 ${question}`);
    const before = requests.length;
    await discordMap.get('챗').execute(slash);
    assert.equal(await handleTextCommand(typed, discordMap), true);
    assert.equal(requests.length, before + 2);
    for (const request of requests.slice(before)) {
      assert.equal(request.input, question);
      assert.equal(request.model, 'gpt-6-sol');
      assert.equal(request.store, false);
    }
    for (const target of [slash, typed]) {
      assert.equal(contentOf(target.payloads[0]), answerText);
      assert.deepEqual(target.payloads[0].allowedMentions, { parse: [], repliedUser: false });
    }
  }
});

test('Kakao bridge and skill preserve multiline and long questions without logging them', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const questions = ['질문:비공개첫부분 나머지', '"원문"  두 칸\n  다음 줄\tA vs B',
    '다'.repeat(501), '라'.repeat(2000)];
  for (const question of questions) {
    for (const prefix of ['/', '.']) {
      const before = requests.length;
      assert.equal((await bridge(`${prefix}챗 ${question}`)).text, answerText);
      assert.equal(skillText(await skill(`${prefix}챗 ${question}`)), answerText);
      assert.equal(requests.length, before + 2);
      for (const request of requests.slice(before)) assert.equal(request.input, question);
    }
  }
  assert.equal(logs.length, questions.length * 4);
  for (const entry of logs) assert.match(entry, /\/챗 \[질문 생략\]/u);
  for (const question of questions) assert.ok(!logs.join('\n').includes(question));
});

test('empty and oversized questions never reach the API through any adapter', async () => {
  for (const question of ['', ' \n\t ', '마'.repeat(2001)]) {
    const before = requests.length;
    const slash = interaction(question);
    const typed = message(`.챗 ${question}`);
    await discordMap.get('챗').execute(slash);
    await handleTextCommand(typed, discordMap);
    assert.match(contentOf(slash.payloads[0]), /1~2,000자/u);
    assert.match(contentOf(typed.payloads[0]), /1~2,000자/u);
    assert.match((await bridge(`/챗 ${question}`)).text, /1~2,000자/u);
    assert.match(skillText(await skill(`.챗 ${question}`)), /1~2,000자/u);
    assert.equal(requests.length, before);
  }
});

test('unsupported spellings and an unregistered 챗 command do not call chat or vs', async (t) => {
  t.mock.method(console, 'log', () => {});
  const before = requests.length;
  for (const input of ['!챗 질문', '챗 질문', 'ㅊ 질문', '.ㅊ 질문', '.챗봇 질문', '/챗 질문']) {
    assert.equal(matchTextCommand(input, discordMap), null, input);
    const typed = message(input);
    assert.equal(await handleTextCommand(typed, discordMap), false, input);
    assert.equal(typed.payloads.length, 0);
  }
  for (const input of ['!챗 질문', '챗 질문', 'ㅊ 질문', '.ㅊ 질문', '.챗봇 질문']) {
    assert.equal(matchTextCommand(input, kakaoMap, KAKAO_MATCH_OPTIONS), null, input);
    assert.equal((await bridge(input)).text, null, input);
  }
  const unregistered = new Map(kakaoMap);
  unregistered.delete('챗');
  assert.equal((await bridge('.챗 A vs B', unregistered)).text, null);
  assert.match((await bridge('/챗 A vs B', unregistered)).text, /명령은/u);
  assert.equal(requests.length, before);
});

test('long answers stay inside platform limits and create no public result link', async () => {
  const previous = answerText;
  answerText = '답'.repeat(2000);
  try {
    const saved = resultCount();
    const slash = interaction('긴 답변 검증');
    const typed = message('.챗 긴 답변 검증');
    await discordMap.get('챗').execute(slash);
    await handleTextCommand(typed, discordMap);
    const result = await bridge('/챗 긴 답변 검증');
    const response = await skill('.챗 긴 답변 검증');
    for (const text of [contentOf(slash.payloads[0]), contentOf(typed.payloads[0]), result.text]) {
      assert.ok(text.length <= 1400);
      assert.match(text, /답변이 길어/u);
      assert.doesNotMatch(text, /\/p\/full\//u);
    }
    assert.equal(result.link, null);
    for (const item of response.template.outputs) assert.ok(item.simpleText.text.length <= 1000);
    assert.doesNotMatch(skillText(response), /\/p\/full\//u);
    assert.equal(resultCount(), saved);
  } finally { answerText = previous; }
});

test('a smaller room budget truncates chat with an ellipsis and never publishes the private answer', async () => {
  const previous = answerText;
  answerText = '비공개 답변 '.repeat(100);
  try {
    const before = resultCount();
    const result = await handleBridgeMessage(bridgeBody('/챗 비공개 질문'), kakaoMap,
      { allowedRoomIds: [FIXTURE_ROOM_ID], baseUrl: 'https://example.test', deliveryPolicy: { requestChars: 200 } });
    assert.equal(result.text.length, 200);
    assert.ok(result.text.endsWith('…'));
    assert.equal(result.link, null);
    assert.equal(resultCount(), before);
  } finally { answerText = previous; }
});

test('pending Kakao retries share one execution and keep the question out of logs', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const body = bridgeBody('/챗 비공개 보류 질문\nA vs B');
  const before = requests.length;
  responseDelayMs = 20;
  try {
    const pending = await handleBridgeMessage(body, kakaoMap, { allowedRoomIds: [FIXTURE_ROOM_ID], baseUrl: 'https://example.test', budgetMs: 1 });
    assert.match(pending.text, /같은 명령을 다시/u);
    const result = await handleBridgeMessage(body, kakaoMap, { allowedRoomIds: [FIXTURE_ROOM_ID], baseUrl: 'https://example.test', budgetMs: 1000 });
    assert.equal(result.text, answerText);
    assert.equal(requests.length, before + 1);
    assert.ok(logs.some((entry) => entry.includes('(보류)')));
    assert.ok(logs.every((entry) => entry.includes('/챗 [질문 생략]')));
    assert.ok(logs.every((entry) => !entry.includes('비공개 보류 질문')));
  } finally { responseDelayMs = 0; }
});

test('concurrent Kakao questions stay separate across rooms and stable user identities', async (t) => {
  t.mock.method(console, 'log', () => {});
  const identity = (roomId, userId) => ({ source: 'android-person-key-v1', roomId, userId });
  const sender = `동명이인-${++userId}`;
  const bodies = [
    { room: '첫 번째 방', attendanceIdentity: identity('room-a', 'user-a') },
    { room: '다른 제목 방', attendanceIdentity: identity('room-b', 'user-a') },
    { room: '첫 번째 방', attendanceIdentity: identity('room-a', 'user-b') },
    { room: '첫 번째 방', attendanceIdentity: identity('room-c', 'user-a') },
  ].map((body, index) => bridgeFixture({ ...body, sender, text: `/챗 독립 질문 ${index}`, roomIdentity: fixtureRoomIdentity(body.attendanceIdentity.roomId) }));
  const before = requests.length;
  responseDelayMs = 20;
  try {
    const results = await Promise.all(bodies.map((body) => handleBridgeMessage(body, kakaoMap,
      { allowedRoomIds: ['room-a', 'room-b', 'room-c'], baseUrl: 'https://example.test', budgetMs: 1000 })));
    for (const result of results) assert.equal(result.text, answerText);
    assert.equal(requests.length, before + bodies.length);
    assert.deepEqual(requests.slice(before).map((request) => request.input), bodies.map((body) => body.text.slice(3)));
  } finally { responseDelayMs = 0; }
});

test('API error details and generated mentions do not become notifications or logs', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  responseError = new Error('비공개 오류 질문 chat-fixture-key');
  try {
    const result = await bridge('/챗 비공개 오류 질문');
    assert.match(result.text, /답변을 준비하지 못/u);
    assert.doesNotMatch(logs.join('\n'), /비공개 오류 질문|chat-fixture-key/u);
  } finally { responseError = null; }
  const previous = answerText;
  answerText = '@everyone <@123456789012345678> <@&123456789012345678>';
  try {
    const typed = message('.챗 멘션 응답 검증');
    await handleTextCommand(typed, discordMap);
    assert.equal(contentOf(typed.payloads[0]), answerText);
    assert.deepEqual(typed.payloads[0].allowedMentions, { parse: [], repliedUser: false });
  } finally { answerText = previous; }
});

test('the existing 한마디 and vs generators retain their own model selections', async (t) => {
  t.mock.method(console, 'log', () => {});
  const before = requests.length;
  assert.equal(await generateQuip({ client: createClient({ env: { OPENAI_API_KEY: 'chat-fixture-key' } }) }), answerText);
  const typed = message('.vs A vs B');
  await handleTextCommand(typed, discordMap);
  assert.match(contentOf(typed.payloads[0]), /^[AB]\n오늘은 이쪽이에요\.$/u);
  assert.deepEqual(requests.slice(before).map((request) => [request.model, request.reasoning?.effort]), [['gpt-6-luna', 'none'], ['gpt-6-luna', 'low']]);
});

test('the phone filter and JSON transport forward /챗 and .챗 question bytes unchanged', async (t) => {
  t.mock.method(console, 'log', () => {});
  const phone = createPhone({ answer: { text: answerText, link: null } });
  const run = text => { phone.notify({ text, personKey: null }); phone.advance(60000); };
  const accepted = ['/챗 질문:첫부분 뒤 문장\n"A"  vs B', '.챗 다음\n  줄 질문', `/챗 ${'바'.repeat(2000)}`];
  accepted.forEach(run);
  for (const text of ['!챗 질문', '챗 질문', 'ㅊ 질문', '오늘 챗 질문']) run(text);
  const sent = phone.requests.map(request => request.body);
  assert.deepEqual(sent.map((body) => body.text), accepted);
  assert.equal(phone.attempts.length, accepted.length);
  for (const body of sent) {
    assert.equal(body.attendanceIdentity, null);
    const before = requests.length;
    assert.equal((await handleBridgeMessage(body, kakaoMap, { allowedRoomIds: [FIXTURE_ROOM_ID], baseUrl: 'https://example.test', budgetMs: 1000 })).text, answerText);
    assert.equal(requests.length, before + 1);
    assert.equal(requests.at(-1).input, body.text.slice(3).trim());
  }
  assert.equal(stateWrites, 0);
});
