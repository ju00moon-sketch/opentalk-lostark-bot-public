// 디스코드 채팅 명령의 응답 지연 — "입력 중" 표시를 기다리지 않고, 공지 목록은 60초 캐시로 API 왕복을 줄인다.
// 디스코드 채팅에서 공지 목록을 쓰는 명령은 `.업뎃`(/업데이트)이다 — `.공지`는 카톡 전용 입력이라 여기서는 쓰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';

for (const name of Object.keys(process.env)) {
  if (/(?:KEY|TOKEN|SECRET)/i.test(name)) delete process.env[name];
}

const NOTICES = [
  { Type: '공지', Title: '9월 16일(수) 업데이트 내역 안내', Link: 'https://lostark.game.onstove.com/News/Notice/Views/13545', Date: '2026-09-16T10:00:00' },
  { Type: '점검', Title: '9월 16일(수) 정기 점검 안내', Link: 'https://lostark.game.onstove.com/News/Notice/Views/13543', Date: '2026-09-15T18:00:00' },
];
let fetchCalls = 0;
globalThis.fetch = async (input) => {
  const url = new URL(input);
  assert.equal(url.pathname, '/news/notices');
  fetchCalls++;
  return { ok: true, status: 200, json: async () => NOTICES };
};

const { commands } = await import('../src/commands/index.js');
const { handleTextCommand } = await import('../src/text-commands.js');
const { getNotices } = await import('../src/lostark.js');
const discordMap = new Map(commands.map((command) => [command.data.name, command]));

function message(content, { typingDelayMs = 0, typingCalls = { count: 0 } } = {}) {
  const payloads = [];
  return {
    content, payloads, typingCalls,
    author: { id: 'latency-fixture-user' },
    channelId: 'latency-fixture-channel', guildId: 'latency-fixture-guild',
    channel: {
      sendTyping() { typingCalls.count++; return new Promise((resolve) => setTimeout(resolve, typingDelayMs)); },
      async send(payload) { payloads.push(payload); },
    },
    async reply(payload) { payloads.push(payload); },
  };
}

test('deferReply는 "입력 중" 요청을 보내되 그 응답을 기다리지 않는다', async () => {
  const typingCalls = { count: 0 };
  const msg = message('.업뎃', { typingDelayMs: 400, typingCalls });
  const started = Date.now();
  assert.equal(await handleTextCommand(msg, discordMap), true);
  const elapsed = Date.now() - started;
  assert.equal(typingCalls.count, 1, '입력 중 표시는 한 번 요청한다');
  assert.ok(elapsed < 300, `입력 중 응답(400ms)을 기다리지 않아야 한다: ${elapsed}ms`);
  assert.ok(msg.payloads.at(-1).embeds?.length >= 1, '업데이트 내역 임베드가 답장된다');
});

test('입력 중 요청이 실패해도 명령은 정상 실행된다', async () => {
  const msg = message('.업뎃');
  msg.channel.sendTyping = () => Promise.reject(new Error('Missing Access'));
  assert.equal(await handleTextCommand(msg, discordMap), true);
  assert.ok(msg.payloads.at(-1).embeds?.length >= 1);
});

test('공지 목록은 60초 캐시로 연달아 물어도 API를 한 번만 부른다', async () => {
  getNotices.clear();
  fetchCalls = 0;
  const first = message('.업뎃');
  const second = message('.업뎃');
  assert.equal(await handleTextCommand(first, discordMap), true);
  assert.equal(fetchCalls, 1, '캐시가 비어 있으면 한 번 조회한다');
  assert.equal(await handleTextCommand(second, discordMap), true);
  assert.equal(fetchCalls, 1, '60초 안의 두 번째 요청은 API를 부르지 않는다');
  assert.deepEqual(first.payloads.at(-1).embeds[0].toJSON(), second.payloads.at(-1).embeds[0].toJSON());
});
