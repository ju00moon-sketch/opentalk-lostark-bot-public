import test from 'node:test';
import assert from 'node:assert/strict';
import { handleBridgeMessage } from '../src/kakao/handler.js';
import { toKakaoResponse } from '../src/kakao/render.js';
import { getResult, resultCount } from '../src/kakao/result-store.js';
import { bridgeReadableLength, DEFAULT_DELIVERY_POLICY, parseDeliveryPolicy, readBridgePolicy } from '../src/kakao/bridge-policy.js';
import { bridgeFixture, FIXTURE_ROOM_ID, createPhone } from './helpers/messengerbot-phone.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'https://example.invalid';
const answer = (payloads, deliveryPolicy = {}) => handleBridgeMessage(bridgeFixture(), new Map([['fixture', {
  data: { name: 'fixture', toJSON: () => ({ name: 'fixture', options: [] }) },
  async execute(i) { for (const payload of payloads) await i.followUp(payload); },
}]]), { baseUrl: BASE, allowedRoomIds: [FIXTURE_ROOM_ID], deliveryPolicy });

test('small budgets retain body text and never create an unreferenced public entry', async () => {
  const before = resultCount();
  assert.deepEqual(await answer([{ content: 'x'.repeat(100) }], { requestChars: 20 }), { text: 'x'.repeat(19) + '…', link: null });
  assert.deepEqual(await answer([{ content: 'x'.repeat(100), kakaoFull: 'complete' }], { requestChars: 20 }),
    { text: 'x'.repeat(19) + '…', link: null });
  assert.equal(resultCount(), before);
});

test('overflowing supplemental links retain a clipped body and store only the selected referenced full text', async () => {
  const before = resultCount();
  const result = await answer([
    { content: 'a'.repeat(1280), kakaoFull: 'complete first part' },
    { content: 'b'.repeat(1280), kakaoFull: 'complete second part', kakaoSeparateMessage: true },
  ]);
  assert.ok(result.text.startsWith('a'.repeat(1280)));
  assert.ok(bridgeReadableLength(result.text) <= 2600);
  assert.ok(result.text.includes('…'));
  assert.equal(resultCount(), before + 1);
  const id = /\/p\/full\/([a-f0-9]{12})/.exec(result.text)?.[1];
  assert.equal(getResult(id).text, 'complete first part\n\ncomplete second part');
});

test('the real help command keeps its first screen and supplemental full link', async () => {
  const help = await import('../src/commands/help.js');
  const before = resultCount();
  const result = await handleBridgeMessage(bridgeFixture({ text: '/도움말' }), new Map([['도움말', help]]),
    { baseUrl: BASE, allowedRoomIds: [FIXTURE_ROOM_ID] });
  assert.ok(result.text.includes('카카오'));
  assert.ok(bridgeReadableLength(result.text) <= 1500);
  assert.ok(!result.text.startsWith('https://'));
  const id = /\/p\/full\/([a-f0-9]{12})/.exec(result.text)?.[1];
  assert.ok(id);
  assert.ok(getResult(id).text.length > 2600);
  assert.equal(resultCount(), before + 1);
});

test('a preview card shares the readable budget and yields to the body under a one-send policy', async () => {
  const before = resultCount();
  const payloads = [{ content: '😀'.repeat(2000), characterCard: 'fixture' }];
  for (const deliveryPolicy of [{}, { requestMessages: 1 }, { requestChars: 10 }]) {
    const result = await answer(payloads, deliveryPolicy);
    const texts = [result.link, result.text].filter(Boolean);
    assert.ok(texts.length <= (deliveryPolicy.requestMessages ?? 2));
    assert.ok(texts.reduce((sum, text) => sum + bridgeReadableLength(text), 0) <= (deliveryPolicy.requestChars ?? 2600));
    assert.ok(result.text.endsWith('…'));
    assert.doesNotMatch(result.text, /[\uD800-\uDBFF]…$/u);
    const phone = createPhone({ answer: result, policy: deliveryPolicy });
    phone.notify();
    assert.deepEqual(phone.attempts.map(attempt => attempt.text), texts);
  }
  assert.equal(resultCount(), before);
});

test('a payload privacy flag forbids public storage for all budget sizes, inline text and follow-ups', async () => {
  for (const requestChars of [1, 200, 2000, 4000]) {
    for (const payloads of [
      [{ content: 'private '.repeat(800), kakaoNoPublicStore: true, kakaoFull: 'extra private detail' }],
      [{ content: 'preview', kakaoBridgeText: '😀'.repeat(2500), kakaoNoPublicStore: true }],
      [{ content: 'a'.repeat(1500), kakaoNoPublicStore: true },
        { content: 'b'.repeat(1500), kakaoSeparateMessage: true }, { content: 'c'.repeat(1500), kakaoSeparateMessage: true }],
    ]) {
      const before = resultCount();
      const result = await answer(payloads, { requestChars });
      assert.equal(resultCount(), before);
      assert.equal(result.link, null);
      assert.ok(result.text);
      assert.ok(bridgeReadableLength(result.text) <= requestChars);
      assert.ok(result.text.endsWith('…'));
      assert.doesNotMatch(result.text, /\/p\/full\/|[\uD800-\uDBFF]…$/u);
    }
  }
  const before = resultCount();
  const response = toKakaoResponse([{ content: 'private '.repeat(1000), kakaoNoPublicStore: true }], { baseUrl: BASE });
  assert.equal(resultCount(), before);
  assert.equal(JSON.stringify(response).includes('kakaoNoPublicStore'), false);
  assert.ok(response.template.outputs.every(output => output.simpleText.text.length <= 1000));
});

test('server and phone reject excessive message and character settings at the same key-specific bounds', () => {
  const phone = createPhone();
  const bounds = { requestMessages: 5, requestChars: 4000, roomMessages: 60, roomChars: 30000, userMessages: 30, userChars: 15000 };
  for (const [key, max] of Object.entries(bounds)) {
    assert.ok(parseDeliveryPolicy({ [key]: max }));
    assert.equal(phone.context.deliveryPolicyValid({ ...DEFAULT_DELIVERY_POLICY, [key]: max }), true);
    assert.equal(parseDeliveryPolicy({ [key]: max + 1 }), null, key);
    assert.equal(phone.context.deliveryPolicyValid({ ...DEFAULT_DELIVERY_POLICY, [key]: max + 1 }), false, key);
  }
});

test('invalid private configuration emits a bounded stage diagnostic without its values or full path', t => {
  const dir = mkdtempSync(join(tmpdir(), 'opentalk-private-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'PRIVATE-CONFIG-NAME.json');
  const logs = [];
  t.mock.method(console, 'warn', (...values) => logs.push(values.join(' ')));
  const env = { KAKAO_BRIDGE_POLICY_FILE: file };
  for (const content of ['{PRIVATE-CONTENT', JSON.stringify({ delivery: { requestMessages: 1200 } }),
    JSON.stringify({ allowedRoomIds: [123] }), JSON.stringify({ privateTypo: 'PRIVATE-CONTENT' })]) {
    writeFileSync(file, content);
    const before = logs.length;
    assert.deepEqual(readBridgePolicy(env).allowedRoomIds, []);
    assert.equal(logs.length, before + 1);
    readBridgePolicy(env);
    assert.equal(logs.length, before + 1, 'unchanged rejection must not fill logs on each request');
  }
  for (const line of logs) {
    assert.ok(line.length < 150);
    assert.doesNotMatch(line, /PRIVATE|1200|123|[\r\n]/);
  }
});

// 카톡 /도움말 첫 발신(helpNote)이 실제 입력 규칙과 같은지 고정한다. 전문(help.js)만 고치고 첫 화면은 옛 목록으로
// 남았던 적이 있다(2026-09-23 검토 P2). 목록은 서버 규칙에서 읽어 대조하므로 규칙이 바뀌면 이 시험이 먼저 알린다.
test('카톡 도움말 첫 발신은 접두사 없이 되는 입력을 서버 규칙과 같게 안내한다', async () => {
  const help = await import('../src/commands/help.js');
  const { KAKAO_MATCH_OPTIONS } = await import('../src/kakao/handler.js');
  const { isBareVersusInput } = await import('../src/versus-input.js');
  const result = await handleBridgeMessage(bridgeFixture({ text: '/도움말' }), new Map([['도움말', help]]),
    { baseUrl: BASE, allowedRoomIds: [FIXTURE_ROOM_ID] });
  const sends = [result.link, result.text].filter(Boolean);
  assert.equal(sends.length, 1, '첫 발신은 한 번');
  assert.ok(bridgeReadableLength(result.text) <= 1500);
  const note = result.text.split('\n')[0];
  for (const alias of KAKAO_MATCH_OPTIONS.bareAliases) assert.ok(note.includes(`(${alias}`) || note.includes(`·${alias}`), `접두사 없는 ${alias}`);
  assert.match(note, /단독으로 보내는 한마디·ㅎㅁㄷ·ㅈㅁㅊ/);
  assert.ok(note.includes('낮잠vs버텨') && isBareVersusInput('낮잠vs버텨'), '접두사 없는 VS 비교');
  assert.match(note, /다른 초성은 \/ 또는 \.을 붙여 주세요/);
});
