import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createPhone, bridgeFixture, FIXTURE_ROOM_ID } from './helpers/messengerbot-phone.mjs';

// Only synthetic characters and injected service reads are used; never load registrations or call an API.
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/src/json-store.js')) return { format: 'module', shortCircuit: true, source: `
    export class CorruptStoreError extends Error {}
    export const readJson = (path, fallback) => structuredClone(fallback);
    export const readJsonLenient = readJson;
    export const writeJsonAtomic = () => { throw new Error('Unexpected state write'); };
  ` };
  return nextLoad(url, context);
} });
globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
const { handleBridgeMessage } = await import('../src/kakao/handler.js');
const { resultCount } = await import('../src/kakao/result-store.js');
const { bridgeReadableLength } = await import('../src/kakao/bridge-policy.js');
const { createArkgridRosterService } = await import('../src/arkgrid-roster.js');
const arkgrid = await import('../src/commands/arkgrid-status.js');
const power = await import('../src/commands/power.js');
const BASE = 'https://example.invalid';

async function commandReply(module, execute, name) {
  const before = resultCount();
  let original;
  const map = new Map([[module.data.name, { data: module.data, async execute(interaction) {
    const edit = interaction.editReply.bind(interaction);
    interaction.editReply = payload => { original = payload.kakaoBridgeText; return edit(payload); };
    await execute(interaction);
  } }]]);
  const answer = await handleBridgeMessage(bridgeFixture({ text: `/${module.data.name} ${name}` }), map,
    { baseUrl: BASE, allowedRoomIds: [FIXTURE_ROOM_ID] });
  const phone = createPhone({ answer });
  phone.notify({ text: `/${module.data.name} ${name}` });
  assert.equal(phone.attempts.length, 1);
  assert.equal(phone.attempts[0].text, answer.text);
  const truncated = bridgeReadableLength(original) > 2600;
  if (truncated) {
    assert.ok(answer.text.endsWith('…'));
    assert.ok(original.startsWith(answer.text.slice(0, -1)));
    assert.ok(bridgeReadableLength(answer.text) <= 2600);
  } else assert.equal(answer.text, original);
  assert.equal(resultCount(), before);
  assert.doesNotMatch(answer.text, /\/p\/full\//);
  return { original, sent: answer.text, truncated };
}

test('the real arkgrid status command retains 6/24/40-character rosters and clips a 60-character roster inline', async t => {
  for (const count of [6, 24, 40, 60]) {
    const siblings = Array.from({ length: count }, (_, i) => ({ CharacterName: `합성원정대검사${String(i).padStart(2, '0')}`,
      ServerName: '루페온', ItemAvgLevel: '1,740.00' }));
    const getRoster = createArkgridRosterService({ readSiblings: async () => siblings,
      readGrid: async () => ({ Slots: Array.from({ length: 6 }, (_, Index) => ({ Index, Grade: '고대', Point: 20 })) }) });
    const result = await commandReply(arkgrid, arkgrid.createExecute({ getRoster }), siblings[0].CharacterName);
    const readable = bridgeReadableLength(result.original);
    for (const row of siblings) assert.ok(result.original.includes(row.CharacterName));
    t.diagnostic(`synthetic /앜그현황 ${count} characters: raw=${result.original.length}, readable=${readable}, sends=1, truncated=${result.truncated}`);
  }
});

test('the real power command preserves folding markers and keeps oversized rosters as clipped body text', async t => {
  const profile = { CharacterName: '합성전투력검사', ServerName: '루페온', ItemAvgLevel: '1,740.00', CombatPower: '5,000.0',
    Stats: [{ Type: '공격력', Value: '123456' }, { Type: '최대 생명력', Value: '345678' }, { Type: '특화', Value: '1800' }] };
  for (const count of [6, 60, 80, 100]) {
    const getRoster = async () => ({ total: count, failed: 0, characters: Array.from({ length: count }, (_, i) => ({
      name: `합성부캐검사${String(i).padStart(2, '0')}`, className: '블레이드', state: 'ok', combatPower: 4000,
      serverName: '루페온',
    })) });
    const result = await commandReply(power, power.createExecute({ getCharacterProfile: async () => profile, getRoster }), profile.CharacterName);
    assert.ok(result.original.includes('\u200b'.repeat(500)));
    const readable = bridgeReadableLength(result.original);
    t.diagnostic(`synthetic /전투력 ${count} alts: raw=${result.original.length}, readable=${readable}, sends=1, truncated=${result.truncated}`);
  }
});

test('personal quips, free-form comparisons and room attendance replies do not become public results under a smaller budget', async () => {
  const quip = await import('../src/commands/quip.js');
  const versus = await import('../src/commands/versus.js');
  const attendance = await import('../src/commands/attendance.js');
  const status = await import('../src/commands/attendance-status.js');
  const cases = [
    [quip, '', quip.createExecute({ getQuip: async () => ({ status: 'new', text: '개인 응원 문장 '.repeat(12) }) })],
    [versus, 'A vs B', versus.createVersusExecute({ compare: async () => ({ text: '개인 비교 결과 '.repeat(12) }) })],
    [attendance, '', attendance.createExecute({ checkIn: () => ({ status: 'checked', gained: 2, total: 18, count: 9 }) })],
    [status, '', status.createExecute({ getStatus: () => ({ members: Array.from({ length: 10 }, (_, i) => ({ name: `합성회원${i}`, points: 20 })) }) })],
  ];
  for (const [module, args, execute] of cases) {
    const before = resultCount();
    const answer = await handleBridgeMessage(bridgeFixture({ text: `/${module.data.name} ${args}` }),
      new Map([[module.data.name, { data: module.data, execute }]]),
      { baseUrl: BASE, allowedRoomIds: [FIXTURE_ROOM_ID], deliveryPolicy: { requestChars: 20 } });
    assert.equal(resultCount(), before, module.data.name);
    assert.ok(bridgeReadableLength(answer.text) <= 20, module.data.name);
    assert.ok(answer.text.endsWith('…'), module.data.name);
  }
});
