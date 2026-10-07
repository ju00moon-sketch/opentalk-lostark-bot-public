import { bridgeFixture, fixtureRoomIdentity, FIXTURE_ROOM_ID, createPhone } from './helpers/messengerbot-phone.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// Production entry points run with in-memory state and a closed fixture transport.
for (const name of Object.keys(process.env)) {
  if (/(?:KEY|TOKEN|SECRET)/i.test(name)) delete process.env[name];
}
globalThis.__gemTestStores = new Map();
globalThis.__gemTestWrites = [];
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/src/json-store.js')) {
      return {
        format: 'module', shortCircuit: true,
        source: `
          export class CorruptStoreError extends Error {}
          export const readJson = (path, fallback) => structuredClone(globalThis.__gemTestStores.get(path) ?? fallback);
          export const readJsonLenient = readJson;
          export const writeJsonAtomic = (path, data) => {
            if (!String(path).endsWith('price-history.json')) throw new Error('Unexpected state write');
            globalThis.__gemTestStores.set(path, structuredClone(data));
            globalThis.__gemTestWrites.push(String(path));
          };
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const requests = [];
let noListings = false;
let unexpectedRequests = 0;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  assert.equal(url.origin, 'https://developer-lostark.game.onstove.com');
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({ pathname: url.pathname, body, method: options.method });
  if (url.pathname === '/auctions/items') {
    assert.equal(options.method, 'POST');
    assert.equal(body.CategoryCode, 210000);
    assert.equal(body.Sort, 'BUY_PRICE');
    assert.equal(body.SortCondition, 'ASC');
    assert.equal(body.PageNo, 1);
    const Items = noListings ? [] : [
      { Name: body.ItemName, AuctionInfo: { BuyPrice: 0 } },
      { Name: body.ItemName, AuctionInfo: { BuyPrice: 12345 } },
      { Name: body.ItemName, AuctionInfo: { BuyPrice: 16000 } },
    ];
    return { ok: true, status: 200, json: async () => ({ Items, TotalCount: Items.length }) };
  }
  if (/^\/armories\/characters\/[^/]+\/gems$/.test(url.pathname)) {
    return { ok: true, status: 200, json: async () => ({
      Gems: [{ Slot: 0, Name: '10레벨 겁화의 보석' }],
      Effects: { Skills: [{ GemSlot: 0, Name: '검증 스킬', Description: ['피해량 증가'] }] },
    }) };
  }
  unexpectedRequests += 1;
  throw new Error(`Unexpected fixture request: ${url.pathname}`);
};

const { commands, kakaoCommands } = await import('../src/commands/index.js');
const { parseGemSearch } = await import('../src/gem-search.js');
const { matchTextCommand, handleTextCommand } = await import('../src/text-commands.js');
const { handleBridgeMessage, KAKAO_MATCH_OPTIONS } = await import('../src/kakao/handler.js');
const discordMap = new Map(commands.map((command) => [command.data.name, command]));
const kakaoMap = new Map(kakaoCommands.map((command) => [command.data.name, command]));

function interaction(options = {}, platform = 'discord') {
  const payloads = [];
  return {
    platform, payloads, user: { id: 'gem-fixture-user' },
    options: {
      getString: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
    },
    async deferReply() {},
    async reply(payload) { payloads.push(payload); },
    async editReply(payload) { payloads.push(payload); },
  };
}

function message(content) {
  const payloads = [];
  return {
    content, payloads, author: { id: 'gem-fixture-user' },
    channelId: 'gem-fixture-channel', guildId: 'gem-fixture-guild',
    channel: { async sendTyping() {}, async send(payload) { payloads.push(payload); } },
    async reply(payload) { payloads.push(payload); },
  };
}

const payloadText = (payloads) => JSON.stringify(payloads.map((payload) => {
  if (typeof payload === 'string') return payload;
  return { ...payload, embeds: payload.embeds?.map((embed) => embed.toJSON?.() ?? embed) };
}));
let bridgeId = 0;
const bridge = (text) => handleBridgeMessage(bridgeFixture({
  text, room: '검증방', sender: `검증사용자-${++bridgeId}`,
}), kakaoMap, { allowedRoomIds: [FIXTURE_ROOM_ID], baseUrl: 'https://example.test', budgetMs: 2000 });

test('gem search accepts specified forms and rejects malformed or unsupported queries', () => {
  for (const [input, type, level] of [
    ['10겁', '겁화', 10], ['10작', '작열', 10], ['1겁', '겁화', 1],
    ['9작', '작열', 9], ['겁화 10', '겁화', 10], ['작열 10', '작열', 10],
    ['10레벨 겁화의 보석', '겁화', 10], ['10레벨 작열의 보석', '작열', 10],
    ['  10작  ', '작열', 10], ['10겁'.normalize('NFD'), '겁화', 10],
  ]) assert.deepEqual(parseGemSearch(input), { 종류: type, 레벨: level }, input);
  for (const input of [
    null, undefined, 10, '', '10', '겁화', '0겁', '11작', '-1겁', '1.5작', '10.0겁', '1e1겁',
    '멸화 10', '10홍', '10광', '합성캐릭터4', '10겁 9작', '겁화 10 추가',
    '10레벨 겁화의 보석 추가', '10겁화염',
  ]) assert.equal(parseGemSearch(input), null, input);
});

test('slash registration includes two official commands and no alias command', () => {
  assert.equal(commands.length, 70);
  assert.equal(kakaoCommands.length, 73);
  for (const list of [commands, kakaoCommands]) {
    const names = list.map((command) => command.data.toJSON().name);
    assert.equal(new Set(names).size, names.length);
    assert.equal(names.filter((name) => name === '경매장').length, 1);
    assert.equal(names.filter((name) => name === '보석최저가').length, 1);
    assert.equal(names.includes('ㄱㅁㅈ'), false);
  }
  const auction = discordMap.get('경매장').data.toJSON();
  assert.equal(auction.options.length, 1);
  assert.equal(auction.options[0].type, 3);
  assert.equal(auction.options[0].required, true);
  assert.equal((discordMap.get('보석최저가').data.toJSON().options ?? []).length, 0);
});

test('Discord and Kakao route official, dot alias, slash alias, and bare initial forms', async () => {
  for (const input of ['.경매장 10겁', '.ㄱㅁㅈ 10겁', 'ㄱㅁㅈ 10겁']) {
    const matched = matchTextCommand(input, discordMap);
    assert.equal(matched?.command.data.name, '경매장', input);
    const msg = message(input);
    const before = requests.length;
    assert.equal(await handleTextCommand(msg, discordMap), true);
    assert.equal(requests.length, before + 1);
    assert.equal(requests.at(-1).body.ItemName, '10레벨 겁화의 보석');
    assert.match(payloadText(msg.payloads), /10레벨 겁화의 보석/);
    assert.match(payloadText(msg.payloads), /12,345/);
  }
  for (const input of ['/경매장 10작', '/ㄱㅁㅈ 10작', '.경매장 10작', '.ㄱㅁㅈ 10작', 'ㄱㅁㅈ 10작']) {
    assert.equal(matchTextCommand(input, kakaoMap, KAKAO_MATCH_OPTIONS)?.command.data.name, '경매장', input);
    const before = requests.length;
    const result = await bridge(input);
    assert.equal(requests.length, before + 1, input);
    assert.equal(requests.at(-1).body.ItemName, '10레벨 작열의 보석');
    assert.match(result.text, /10레벨 작열의 보석/);
    assert.match(result.text, /12,345/);
  }
  for (const input of ['경매장 10겁', 'ㄱㅁㅈ가 10겁', '오늘 ㄱㅁㅈ 10겁']) {
    assert.equal(matchTextCommand(input, discordMap), null, input);
    assert.equal((await bridge(input)).text, null, input);
  }
});

test('invalid auction queries give usage without an auction or character request', async () => {
  for (const suffix of ['', '11겁', '0작', '멸화 10', '10겁 9작', '합성캐릭터4']) {
    const before = requests.length;
    const msg = message(`.경매장 ${suffix}`.trim());
    assert.equal(await handleTextCommand(msg, discordMap), true);
    assert.ok(msg.payloads.length > 0);
    const result = await bridge(`ㄱㅁㅈ ${suffix}`.trim());
    assert.ok(result.text);
    assert.equal(requests.length, before, suffix);
  }
  const command = discordMap.get('경매장');
  const option = command.data.toJSON().options[0].name;
  const before = requests.length;
  const invalid = interaction({ [option]: '11겁' });
  await command.execute(invalid);
  assert.ok(invalid.payloads.length);
  assert.equal(requests.length, before);
  const boardWithArguments = message('.보석최저가 10겁');
  await handleTextCommand(boardWithArguments, discordMap);
  assert.match(payloadText(boardWithArguments.payloads), /사용법/);
  assert.match((await bridge('/보석최저가 10겁')).text, /사용법/);
  assert.equal(requests.length, before);
});

test('direct slash execution uses canonical item names and handles missing listings', async () => {
  const command = discordMap.get('경매장');
  const option = command.data.toJSON().options[0].name;
  const request = interaction({ [option]: '10레벨 작열의 보석' });
  await command.execute(request);
  assert.equal(requests.at(-1).body.ItemName, '10레벨 작열의 보석');
  assert.match(payloadText(request.payloads), /12,345/);
  noListings = true;
  try {
    const result = await bridge('/경매장 1겁');
    assert.match(result.text, /즉시 구매 가능한 매물이 없/);
    assert.match(result.text, /1레벨 겁화의 보석/);
  } finally { noListings = false; }
});

test('보석 and 보석최저가 share the board and concurrent cache across platforms', async () => {
  const before = requests.length;
  const old = message('.보석');
  const named = message('.보석최저가');
  const [, , result] = await Promise.all([
    handleTextCommand(old, discordMap), handleTextCommand(named, discordMap), bridge('/보석최저가'),
  ]);
  assert.equal(requests.length, before + 8);
  assert.deepEqual(requests.slice(before).map((entry) => entry.body.ItemName), [
    '10레벨 겁화의 보석', '9레벨 겁화의 보석', '8레벨 겁화의 보석', '7레벨 겁화의 보석',
    '10레벨 작열의 보석', '9레벨 작열의 보석', '8레벨 작열의 보석', '7레벨 작열의 보석',
  ]);
  assert.equal(payloadText(old.payloads), payloadText(named.payloads));
  for (const key of ['10겁', '9겁', '8겁', '7겁', '10작', '9작', '8작', '7작']) assert.ok(result.text.includes(key));
  await bridge('.보석');
  await bridge('.보석최저가');
  assert.equal(requests.length, before + 8);
  assert.ok(globalThis.__gemTestWrites.length > 0);
});

test('legacy character and single gem routes preserve their distinct API paths', async () => {
  const typed = message('.보석 합성캐릭터4');
  const before = requests.length;
  await handleTextCommand(typed, discordMap);
  assert.equal(requests.length, before + 1);
  assert.equal(decodeURIComponent(requests.at(-1).pathname), '/armories/characters/합성캐릭터4/gems');
  assert.match(payloadText(typed.payloads), /합성캐릭터4 — 장착 보석/);
  const result = await bridge('/보석 합성캐릭터4');
  assert.match(result.text, /합성캐릭터4 — 장착 보석/);
  const oldSingle = message('.보석 겁화 10');
  await handleTextCommand(oldSingle, discordMap);
  assert.equal(requests.at(-1).body.ItemName, '10레벨 겁화의 보석');
  assert.match(payloadText(oldSingle.payloads), /최저 즉시 구매가/);
  const tierThree = message('.보석 멸화 10');
  await handleTextCommand(tierThree, discordMap);
  assert.equal(requests.at(-1).body.ItemName, '10레벨 멸화의 보석');
});

test('phone VM forwards bare ㄱㅁㅈ with word boundaries and preserves existing filters', () => {
  const phone = createPhone({ answer: { text: 'fixture', link: null } });
  const run = text => { phone.notify({ text }); phone.advance(60000); };
  const accepted = ['ㄱㅁㅈ 10겁', 'ㄱㅁㅈ', '  ㄱㅁㅈ 10작', '.ㄱㅁㅈ 10겁', '/ㄱㅁㅈ 10작',
    '/경매장 10겁', '.경매장 10작', '/보석최저가', '.보석최저가', 'ㅂㅂㄱ 4000', 'ㄱㄹㄷ 닉네임', '한마디'];
  accepted.forEach(run);
  assert.deepEqual(phone.requests.map(request => request.body.text), accepted);
  for (const input of ['ㄱㅁㅈ가 10겁', 'ㄱㅁㅈ10겁', '경매장 10겁', '오늘 ㄱㅁㅈ 10겁', '한마디 더']) run(input);
  assert.deepEqual(phone.requests.map(request => request.body.text), accepted);
  assert.equal(phone.attempts.length, accepted.length);
});

test('help documents the new commands within Discord field limits', async () => {
  const help = discordMap.get('도움말');
  for (const platform of ['discord', 'kakao']) {
    const target = interaction({}, platform);
    await help.execute(target);
    const embed = target.payloads[0].embeds[0].toJSON();
    for (const field of embed.fields) assert.ok(field.value.length <= 1024, `${platform}: ${field.name} (${field.value.length})`);
    const text = payloadText(target.payloads);
    assert.match(text, /보석최저가/);
    assert.match(text, /경매장/);
    assert.match(text, /ㄱㅁㅈ/);
  }
  assert.equal(unexpectedRequests, 0);
});
