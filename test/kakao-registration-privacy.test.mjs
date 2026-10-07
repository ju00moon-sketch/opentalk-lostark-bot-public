import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { bridgeFixture, FIXTURE_ROOM_ID } from './helpers/messengerbot-phone.mjs';

globalThis.__registrationPrivacy = { links: {}, writes: 0 };
registerHooks({ load(url, context, next) {
  if (url.endsWith('/src/json-store.js')) return { format: 'module', shortCircuit: true, source: `
    export class CorruptStoreError extends Error {}
    export const readJson = (path, fallback) => String(path).endsWith('user-links.json') ? structuredClone(globalThis.__registrationPrivacy.links) : structuredClone(fallback);
    export const readJsonLenient = readJson;
    export const writeJsonAtomic = (path, value) => {
      if (!String(path).endsWith('user-links.json')) throw Error('Unexpected write');
      globalThis.__registrationPrivacy.links = structuredClone(value);
      globalThis.__registrationPrivacy.writes++;
    };
  ` };
  return next(url, context);
} });
process.env.BOT_INTERNAL_TOKEN = '';
globalThis.fetch = async input => {
  const url = new URL(String(input));
  assert.equal(url.hostname, 'developer-lostark.game.onstove.com');
  assert.ok(url.pathname.endsWith('/profiles'));
  return { ok: true, status: 200, json: async () => ({ CharacterName: '합성등록캐릭터', ServerName: '루페온',
    CharacterClassName: '블레이드', ItemAvgLevel: '1,740.00' }) };
};
const { handleBridgeMessage } = await import('../src/kakao/handler.js');
const { resultCount } = await import('../src/kakao/result-store.js');
const register = await import('../src/commands/register.js');

test('registration still updates the isolated link but a short answer budget never publishes that connection', async () => {
  const before = resultCount();
  const result = await handleBridgeMessage(bridgeFixture({ text: '/등록 합성등록캐릭터' }), new Map([[register.data.name, register]]),
    { baseUrl: 'https://example.invalid', allowedRoomIds: [FIXTURE_ROOM_ID], deliveryPolicy: { requestChars: 20 } });
  assert.equal(globalThis.__registrationPrivacy.writes, 1);
  assert.equal(resultCount(), before);
  assert.ok(result.text.length <= 20);
  assert.ok(result.text.endsWith('…'));
});
