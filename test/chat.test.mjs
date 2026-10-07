import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatResponder, buildChatRequest, CHAT_MODEL, CHAT_FAILED, CHAT_TIMEOUT, CHAT_MAX_ANSWER_LENGTH } from '../src/chat.js';
import { createClient } from '../src/quip.js';

const completed = (text) => ({ status: 'completed', output: [
  { type: 'reasoning', summary: [{ text: 'internal reasoning' }] },
  { type: 'message', status: 'completed', content: [{ type: 'output_text', text }] },
] });
const client = (create) => ({ responses: { create } });

test('request uses Sol, only the current question, bounded output and no response storage', async () => {
  const question = '질문: 앞 문장\n  다음 문장 "A vs B"';
  const calls = [];
  const api = createClient({ env: { OPENAI_API_KEY: 'fixture', QUIP_PROVIDER: 'openai', QUIP_MODEL: CHAT_MODEL },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.headers.Authorization, 'Bearer fixture');
      assert.ok(options.signal instanceof AbortSignal);
      calls.push(JSON.parse(options.body));
      return { ok: true, json: async () => completed('답변입니다.') };
    } });
  assert.equal(await createChatResponder({ client: api })(question, 'person'), '답변입니다.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'gpt-6-sol');
  assert.equal(calls[0].input, question);
  assert.equal(calls[0].store, false);
  assert.equal(calls[0].max_output_tokens, 4096);
  assert.ok(!('reasoning' in calls[0]));
  for (const key of ['previous_response_id', 'conversation', 'tools', 'user', 'temperature']) assert.ok(!(key in calls[0]));
});

test('instructions carry today in Korean time with the weekday and season: September is autumn', async () => {
  const calls = [];
  const now = () => Date.parse('2026-09-17T00:30:00+09:00'); // 2026-09-16T15:30Z — UTC date is still the 16th
  const ask = createChatResponder({ now, client: client(async (body) => { calls.push(body); return completed('답변'); }) });
  assert.equal(await ask('점심 추천해줘 계절 고려해서'), '답변');
  const lines = calls[0].instructions.split('\n');
  assert.equal(lines.at(-1), '오늘은 한국 시간 2026년 9월 17일 (목요일)이고 계절은 가을입니다. 날짜·계절·시기가 관련된 질문은 이 기준으로 답하세요.');
  assert.ok(lines.length > 1 && lines.slice(0, -1).every((line) => !/오늘은 한국 시간/.test(line)));
  assert.deepEqual(buildChatRequest('질문', { now }).instructions, calls[0].instructions);
  assert.match(buildChatRequest('질문').instructions, /\n오늘은 한국 시간 \d{4}년 \d{1,2}월 \d{1,2}일 \([월화수목금토일]요일\)이고 계절은 (?:봄|여름|가을|겨울)입니다\./);
});

test('January is winter and the Korean date turns over at midnight KST, not UTC', async () => {
  const calls = [];
  const now = () => Date.parse('2027-01-31T23:59:59+09:00'); // 2027-01-31T14:59:59Z
  const ask = createChatResponder({ now, client: client(async (body) => { calls.push(body); return completed('답변'); }) });
  await ask('질문');
  assert.match(calls[0].instructions, /\n오늘은 한국 시간 2027년 1월 31일 \(일요일\)이고 계절은 겨울입니다\./);
  assert.match(buildChatRequest('질문', { now: () => Date.parse('2026-12-31T15:00:00Z') }).instructions, /2027년 1월 1일 \(금요일\)이고 계절은 겨울/);
  assert.match(buildChatRequest('질문', { now: () => Date.parse('2026-05-31T14:59:59Z') }).instructions, /2026년 5월 31일 \(일요일\)이고 계절은 봄/);
  assert.match(buildChatRequest('질문', { now: () => Date.parse('2026-05-31T15:00:00Z') }).instructions, /2026년 6월 1일 \(월요일\)이고 계절은 여름/);
});

test('refusal is returned, while incomplete or malformed replies are not presented as answers', async () => {
  const response = { status: 'completed', output: [{ type: 'message', status: 'completed', content: [
    { type: 'refusal', refusal: '그 요청은 도와드릴 수 없어요.' },
  ] }] };
  assert.equal(await createChatResponder({ client: client(async () => response) })('질문'), '그 요청은 도와드릴 수 없어요.');
  for (const bad of [null, {}, { ...completed('미완성'), status: 'incomplete' },
    { status: 'completed', output: [] }, completed(''),
    { status: 'completed', output: [{ type: 'message', status: 'in_progress', content: [] }] },
    { status: 'completed', output: [{ type: 'message', status: 'completed', content: [{ type: 'unknown' }] }] },
  ]) assert.equal(await createChatResponder({ client: client(async () => bad) })('질문'), CHAT_FAILED);
});

test('answer length is bounded without cutting a surrogate pair, with an explicit notice', async () => {
  const answer = await createChatResponder({ client: client(async () => completed('🙂'.repeat(2000))) })('질문');
  assert.ok(answer.length <= CHAT_MAX_ANSWER_LENGTH);
  assert.ok(answer.isWellFormed());
  assert.match(answer, /답변이 길어/);
});

test('missing key or invalid question does not make an API call', async () => {
  assert.match(await createChatResponder({ client: null })('질문'), /아직 연결되지/);
  let calls = 0;
  const ask = createChatResponder({ client: client(async () => { calls += 1; return completed('답변'); }) });
  for (const question of ['', '   ', null, '가'.repeat(2001)]) assert.match(await ask(question), /1~2,000자/);
  assert.equal(calls, 0);
});

test('duplicates share one pending request and a different question waits, then clears', async () => {
  let release;
  let calls = 0;
  const waiting = new Promise((resolve) => { release = resolve; });
  const ask = createChatResponder({ client: client(async () => { calls += 1; await waiting; return completed('답변'); }) });
  const first = ask('첫 질문', 'person');
  const duplicate = ask('첫 질문', 'person');
  assert.match(await ask('다른 질문', 'person'), /이전 질문/);
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([first, duplicate]), ['답변', '답변']);
  await ask('다음 질문', 'person');
  assert.equal(calls, 2);
});

test('HTTP failures do not retry or log question, key, or provider error body', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  let calls = 0;
  const ask = createChatResponder({ client: client(async () => { calls += 1; throw Object.assign(new Error('private question key'), { status: 429 }); }) });
  assert.equal(await ask('private question'), CHAT_FAILED);
  assert.equal(calls, 1);
  assert.deepEqual(log.mock.calls[0].arguments, ['질문 답변 실패:', 'HTTP 429']);
});

test('timeout aborts the transport and permits a later request', async (t) => {
  t.mock.method(console, 'error', () => {});
  let calls = 0;
  const ask = createChatResponder({ timeoutMs: 10, client: client(async (_body, options) => {
    assert.equal(options.maxRetries, 0);
    if (++calls > 1) return completed('다시 답변');
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  }) });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    assert.equal(await ask('질문', 'person'), CHAT_TIMEOUT);
    assert.equal(await ask('다음 질문', 'person'), '다시 답변');
  } finally { clearTimeout(keepAlive); }
});
