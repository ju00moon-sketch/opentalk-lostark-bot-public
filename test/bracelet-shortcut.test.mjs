import { bridgeFixture, fixtureRoomIdentity, FIXTURE_ROOM_ID, createPhone } from './helpers/messengerbot-phone.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// 실제 명령·플랫폼 어댑터를 실행하되 외부 요청과 사용자 저장소는 고정 자료로 격리한다.
for (const name of Object.keys(process.env)) if (/(?:KEY|TOKEN|SECRET)/i.test(name)) delete process.env[name];
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/src/json-store.js')) return {
      format: 'module', shortCircuit: true,
      source: `export class CorruptStoreError extends Error {}
        export const readJson = (path, fallback) => structuredClone(fallback);
        export const readJsonLenient = readJson;
        export const writeJsonAtomic = () => { throw new Error('Unexpected state write'); };`,
    };
    return nextLoad(url, context);
  },
});
const requests = [];
let mode = 'items';
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  assert.equal(url.origin, 'https://developer-lostark.game.onstove.com');
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({ path: decodeURIComponent(url.pathname), body });
  if (url.pathname === '/auctions/items') {
    assert.equal(options.method, 'POST');
    if (mode === 'failure') return { ok: false, status: 503 };
    const Items = mode === 'empty' ? [] : [{
      AuctionInfo: { BuyPrice: 12345, EndDate: '2026-09-17T12:00:00' },
      Options: [{ Type: 'STAT', OptionName: '치명', Value: 91 },
        { Type: 'STAT', OptionName: '특화', Value: 92 },
        { Type: 'BRACELET_RANDOM_SLOT', Value: 3 }],
    }];
    return { ok: true, status: 200, json: async () => ({ TotalCount: Items.length, Items }) };
  }
  assert.match(url.pathname, /^\/armories\/characters\/[^/]+\/equipment$/);
  return { ok: true, status: 200, json: async () => [] };
};

const { parseBraceletShortcut, parseBraceletQuery, toEtcOptions, __test } = await import('../src/bracelet-search.js');
const bracelet = await import('../src/commands/bracelet.js');
const search = await import('../src/commands/bracelet-search.js');
const { commands, kakaoCommands } = await import('../src/commands/index.js');
const { handleTextCommand, matchTextCommand } = await import('../src/text-commands.js');
const { handleBridgeMessage, KAKAO_MATCH_OPTIONS } = await import('../src/kakao/handler.js');
const help = await import('../src/commands/help.js');
const discordMap = new Map(commands.map((command) => [command.data.name, command]));
const kakaoMap = new Map(kakaoCommands.map((command) => [command.data.name, command]));
const expected = [
  { FirstOption: 2, SecondOption: 15, MinValue: 90, MaxValue: 999 },
  { FirstOption: 2, SecondOption: 16, MinValue: 90, MaxValue: 999 },
  { FirstOption: 4, SecondOption: 2, MinValue: 3, MaxValue: 3 },
];
const makeInteraction = (options = {}) => {
  const payloads = [];
  return { payloads, user: { id: 'bracelet-fixture', username: '기본캐릭터' },
    options: { getString: (name) => options[name] ?? null },
    async deferReply() {}, async reply(value) { payloads.push(value); },
    async editReply(value) { payloads.push(value); } };
};
const makeMessage = (content) => {
  const interaction = makeInteraction();
  return { content, author: interaction.user, channelId: 'bracelet-fixture-channel',
    channel: { async sendTyping() {}, async send(value) { interaction.payloads.push(value); } },
    reply: interaction.reply, payloads: interaction.payloads };
};
const textOf = (payloads) => JSON.stringify(payloads.map((value) => typeof value === 'string' ? value
  : { ...value, embeds: value.embeds?.map((embed) => embed.toJSON()) }));
test.beforeEach(() => { requests.length = 0; mode = 'items'; __test.resetCache(); });

test('paired stat order maps distinct minimum values to three random slots', () => {
  assert.deepEqual(toEtcOptions(parseBraceletShortcut('치특 90 90')), expected);
  assert.deepEqual(parseBraceletShortcut(' 특신 100 90 '), {
    stats: [{ name: '특화', min: 100 }, { name: '신속', min: 90 }],
    randomSlots: 3, fixedSlots: null, specials: [],
  });
  assert.deepEqual(parseBraceletShortcut('특치 100 90').stats, [{ name: '특화', min: 100 }, { name: '치명', min: 90 }]);
  for (const input of ['치특 90', '치치 90 90', '치특 0 90', '치특 90 1000', '치특 -1 90',
    '치특 90.5 90', '치특 90 x', '치특 90 90 추가', '치특 90 90 2줄']) assert.equal(parseBraceletShortcut(input), null, input);
  for (const input of [undefined, '', '합성캐릭터4', '치특', '치특90']) assert.equal(parseBraceletShortcut(input), undefined, input);
});

test('Discord text and real slash execution use the complete auction request contract', async () => {
  const message = makeMessage('.팔찌 치특 90 90');
  assert.equal(await handleTextCommand(message, discordMap), true);
  assert.deepEqual(requests.map((request) => request.path), ['/auctions/items']);
  const body = requests[0].body;
  assert.deepEqual(body.EtcOptions, expected);
  assert.equal(body.CategoryCode, 200040);
  assert.equal(body.ItemTier, 4);
  assert.equal(body.ItemGrade, '고대');
  assert.equal(body.Sort, 'BUY_PRICE');
  assert.equal(body.SortCondition, 'ASC');
  assert.equal(body.PageNo, 1);
  assert.match(textOf(message.payloads), /치명 90↑ 특화 90↑ · 부여 3/);
  assert.match(textOf(message.payloads), /12,345/);
  const slash = makeInteraction({ 닉네임: '치특 90 90' });
  await bracelet.execute(slash);
  assert.match(textOf(slash.payloads), /부여 3/);
  assert.equal(requests.length, 1, 'text and slash share the existing query cache');
});

test('both Kakao prefixes run the same search through the actual bridge', async () => {
  for (const prefix of ['/', '.']) {
    const result = await handleBridgeMessage(bridgeFixture({ text: `${prefix}팔찌 치특 90 90`, room: '검증방', sender: `검증-${prefix}` }),
      kakaoMap, { allowedRoomIds: [FIXTURE_ROOM_ID], baseUrl: 'https://example.test' });
    assert.match(result.text, /치명 90↑ 특화 90↑ · 부여 3/);
    assert.match(result.text, /12,345/);
  }
  assert.deepEqual(requests[0].body.EtcOptions, expected);
  assert.equal(requests.length, 1);
  assert.equal(matchTextCommand('팔찌 치특 90 90', discordMap), null);
  assert.equal(matchTextCommand('팔찌 치특 90 90', kakaoMap, KAKAO_MATCH_OPTIONS), null);
});

test('malformed searches show usage without character or auction requests', async () => {
  for (const input of ['치특 90', '치치 90 90', '치특 90.5 90', '치특 90 x', '치특 90 90 추가']) {
    const message = makeMessage(`.팔찌 ${input}`);
    await handleTextCommand(message, discordMap);
    assert.match(textOf(message.payloads), /사용법/);
  }
  assert.equal(requests.length, 0);
});

test('character names and no-argument profile fallback keep the original equipment route', async () => {
  for (const input of ['합성캐릭터4', '치특', null]) {
    const interaction = makeInteraction({ 닉네임: input });
    await bracelet.execute(interaction);
    assert.equal(requests.at(-1).path, `/armories/characters/${input ?? '기본캐릭터'}/equipment`);
    assert.match(textOf(interaction.payloads), /조회|찾|없/);
  }
  const message = makeMessage('.팔찌 합성캐릭터4');
  await handleTextCommand(message, discordMap);
  assert.equal(requests.at(-1).path, '/armories/characters/합성캐릭터4/equipment');
  assert.ok(requests.every((request) => request.body === null));
});

test('named nickname options keep the existing generic parsing on both platforms', async () => {
  for (const prefix of ['/', '.']) {
    const matched = matchTextCommand(`${prefix}팔찌 닉네임:합성캐릭터4`, kakaoMap, KAKAO_MATCH_OPTIONS);
    assert.deepEqual(matched.options, { 닉네임: '합성캐릭터4' });
    const result = await handleBridgeMessage(bridgeFixture({ text: `${prefix}팔찌 닉네임:합성캐릭터4`, room: '검증방', sender: `이름형식-${prefix}` }),
      kakaoMap, { allowedRoomIds: [FIXTURE_ROOM_ID], baseUrl: 'https://example.test' });
    assert.ok(result.text.includes('합성캐릭터4'));
    assert.equal(requests.at(-1).path, '/armories/characters/합성캐릭터4/equipment');
  }
  assert.deepEqual(matchTextCommand('.팔찌 닉네임:합성캐릭터4', discordMap).options, { 닉네임: '합성캐릭터4' });
});

test('the existing search retains unrestricted slots and explicit slot selection', async () => {
  assert.equal(parseBraceletQuery('특90치90').randomSlots, null);
  for (const input of ['특90치90', '특90치90 부여2', '특90치90 부여3']) {
    await search.execute(makeInteraction({ 옵션: input }));
    const slot = requests.at(-1).body.EtcOptions.find((option) => option.FirstOption === 4);
    if (input.endsWith('부여2')) assert.deepEqual(slot, { FirstOption: 4, SecondOption: 2, MinValue: 2, MaxValue: 2 });
    else if (input.endsWith('부여3')) assert.deepEqual(slot, expected[2]);
    else assert.equal(slot, undefined);
  }
});

test('empty results and API failures keep the shared user-facing responses', async () => {
  mode = 'empty';
  const empty = makeInteraction({ 닉네임: '치특 90 90' });
  await bracelet.execute(empty);
  assert.match(textOf(empty.payloads), /조건에 맞는 팔찌 매물이 없어요/);
  __test.resetCache();
  mode = 'failure';
  const failed = makeInteraction({ 닉네임: '치특 90 90' });
  await bracelet.execute(failed);
  assert.match(textOf(failed.payloads), /경매장에서 팔찌 매물을 가져오지 못했어요/);
});

test('the canonical slash name and optional string stay compatible and help fits Discord limits', async () => {
  const definition = bracelet.data.toJSON();
  assert.equal(definition.name, '팔찌');
  assert.equal(commands.filter((command) => command.data.name === '팔찌').length, 1);
  assert.equal(definition.options.length, 1);
  assert.equal(definition.options[0].name, '닉네임');
  assert.equal(definition.options[0].type, 3);
  assert.ok(!definition.options[0].required);
  const interaction = makeInteraction();
  await help.execute(interaction);
  const embed = interaction.payloads[0].embeds[0].toJSON();
  assert.ok(embed.fields.every((field) => field.value.length <= 1024));
  assert.match(JSON.stringify(embed), /팔찌 치특 90 90/);
});
