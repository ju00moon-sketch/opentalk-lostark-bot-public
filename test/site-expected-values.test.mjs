import test from 'node:test';
import assert from 'node:assert/strict';
import { expectationText, followSiteValuation, DEVELOPMENT_NOTE } from '../src/site-valuation.js';
import { createExecute as createBraceletExecute, createShowCharacter } from '../src/commands/bracelet.js';
import { createExecute as createGemExecute } from '../src/commands/gem-efficiency.js';

const makeInteraction = (platform, options = {}) => {
  const payloads = [];
  return { payloads, platform, user: { id: 'expected-fixture', username: '기본캐릭터' },
    options: { getString: (name) => options[name] ?? null },
    async deferReply() {}, async reply(value) { payloads.push(value); }, async editReply(value) { payloads.push(value); } };
};
const textOf = (payloads) => JSON.stringify(payloads.map((value) => typeof value === 'string' ? value
  : { ...value, embeds: value.embeds?.map((embed) => embed.toJSON()) }));

const done = { status: 'done', bracelet: { gold: 30443366.4, reason: null }, gems: { gold: 812345, knownGold: 812345, items: 6, known: 6, reason: null } };
const stone = { Type: '어빌리티 스톤', Grade: '고대', Name: '위대한 비상의 돌', Tooltip: '{}' };
const bracelet = { Type: '팔찌', Grade: '고대', Name: '팔찌', Tooltip: '{}', Icon: 'https://example.invalid/bracelet.png' };

test('expected value rows read as gold, partial, pending or unavailable', () => {
  assert.equal(expectationText(done, 'bracelet'), '30,443,366 G');
  assert.equal(expectationText({ status: 'done', bracelet: { gold: 30443366.4, record: true } }, 'bracelet'), '30,443,366 G · 최고 기록');
  assert.equal(expectationText(done, 'gems'), '812,345 G');
  assert.equal(expectationText({ status: 'running', bracelet: { gold: null }, gems: { gold: null } }, 'gems'), '계산 중 · 잠시 후 다시 조회해 주세요');
  assert.equal(expectationText({ status: 'running', bracelet: { gold: null }, gems: { gold: null } }, 'gems', { live: true }), '계산 중 · 끝나면 이 메시지를 갱신해요');
  assert.equal(expectationText({ status: 'timeout', bracelet: { gold: null }, gems: { gold: null } }, 'bracelet'), '계산이 오래 걸려요 · 잠시 후 다시 조회해 주세요');
  assert.equal(expectationText({ status: 'done', gems: { gold: null, knownGold: 500000, items: 6, known: 4, reason: 'partial' } }, 'gems'), '500,000 G (6개 중 4개만 계산)');
  assert.equal(expectationText({ status: 'done', bracelet: { gold: null, reason: 'no_bracelet' } }, 'bracelet'), '팔찌 없음');
  assert.equal(expectationText({ status: 'unavailable', bracelet: { gold: null, reason: 'unavailable' }, gems: { gold: null } }, 'bracelet'), '확인 불가');
  assert.equal(expectationText({ status: 'done', bracelet: { gold: null, reason: 'no_matching_listings' } }, 'bracelet'), '경매장에 비슷한 매물 없음');
  assert.equal(expectationText({ status: 'done', bracelet: { gold: null, reason: 'rate_limited' }, gems: { gold: null, knownGold: 0, items: 24, known: 0, reason: 'rate_limited' } }, 'gems'), '조회가 많아요 · 잠시 후 다시 조회해 주세요');
  assert.equal(expectationText({ status: 'done', gems: { gold: null, reason: 'calculation_unavailable' } }, 'gems'), '확인 불가');
  assert.match(DEVELOPMENT_NOTE, /개발 버전이라 정확하지 않을 수 있으며 결과가 나오지 않을 수 있습니다/);
});

test('/팔찌 uses the site efficiency and adds the expected value under it with the development note on both platforms', async () => {
  const execute = createBraceletExecute({ character: createShowCharacter({
    armory: async () => [stone, bracelet], siteEfficiency: async () => ({ bracelet: { status: 'ok', efficiency: 15.62 } }),
    banglePercent: async () => { throw new Error('fallback must not run'); }, braceletEfficiency: async () => null, siteValuation: async () => done }) });
  const kakao = makeInteraction('kakao', { 닉네임: '합성캐릭터4' });
  await execute(kakao);
  const content = kakao.payloads.at(-1).content;
  assert.match(content, /▸ 팔찌 효율 15\.62%\n▸ 팔찌 기댓값 30,443,366 G/);
  assert.ok(content.indexOf('팔찌 기댓값') < content.indexOf('어빌리티 스톤'));
  assert.match(content, /※ 포근해용 계산 기준 · 현재 장착한 팔찌로 계산했어요\./);
  assert.doesNotMatch(content, /로펙/);
  assert.match(content, new RegExp(`※ ${DEVELOPMENT_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  const discord = makeInteraction('discord', { 닉네임: '합성캐릭터4' });
  await execute(discord);
  const text = textOf(discord.payloads);
  assert.match(text, /팔찌 효율: \*\*15\.62%\*\*\\n  팔찌 기댓값: \*\*30,443,366 G\*\*/);
  assert.ok(text.includes(DEVELOPMENT_NOTE));
  assert.doesNotMatch(text, /로펙 기준/);
});

test('/팔찌 falls back to the lopec badge, then the table, when the site cannot calculate', async () => {
  const badge = createBraceletExecute({ character: createShowCharacter({
    armory: async () => [stone, bracelet], siteEfficiency: async () => ({ bracelet: { status: 'unavailable', efficiency: null } }),
    banglePercent: async () => 15.62, braceletEfficiency: async () => null, siteValuation: async () => done }) });
  const first = makeInteraction('kakao', { 닉네임: '합성캐릭터4' });
  await badge(first);
  assert.match(first.payloads.at(-1).content, /▸ 팔찌 효율 15\.62%[\s\S]*※ 로펙 갱신 기준이라 현재 착용 팔찌와 다를 수 있습니다\./);
  const table = createBraceletExecute({ character: createShowCharacter({
    armory: async () => [stone, bracelet], siteEfficiency: async () => null, banglePercent: async () => null, braceletEfficiency: async () => 14.9,
    siteValuation: async () => ({ status: 'unavailable', bracelet: { gold: null, reason: 'unavailable' }, gems: { gold: null } }) }) });
  const second = makeInteraction('kakao', { 닉네임: '합성캐릭터4' });
  await table(second);
  assert.match(second.payloads.at(-1).content, /▸ 팔찌 효율 14\.90%\n▸ 팔찌 기댓값 확인 불가[\s\S]*※ 로펙 효율표 값이에요/);
});

test('/팔찌 without a bracelet shows no expected value row and never asks the site for one', async () => {
  let asked = 0;
  const execute = createBraceletExecute({ character: createShowCharacter({
    armory: async () => [stone], siteEfficiency: async () => { asked++; return null; }, banglePercent: async () => { throw new Error('must not run'); },
    braceletEfficiency: async () => null, siteValuation: async () => { asked++; return done; } }) });
  const kakao = makeInteraction('kakao', { 닉네임: '합성캐릭터4' });
  await execute(kakao);
  assert.equal(asked, 0);
  assert.doesNotMatch(kakao.payloads.at(-1).content, /기댓값/);
});

test('/젬효율 prefers the site calculation, adds the gem expected value and drops the external address', async () => {
  const siteGem = { status: 'ok', efficiency: 9.41, optionEfficiency: 6.71, pointEfficiency: 2.52,
    effectEfficiencies: [{ name: '추가 피해', level: 52, effect: 4.2, efficiency: 3.23 }, { name: '낙인력', level: 14, effect: 2.33, efficiency: 0 }] };
  const execute = createGemExecute({ siteEfficiency: async () => ({ gem: siteGem }), siteValuation: async () => done,
    arkgridEfficiency: async () => { throw new Error('fallback must not run'); }, lopecScore: async () => ({ name: '합성캐릭터4', gemMedian: 8.52 }) });
  const interaction = makeInteraction('discord', { 닉네임: '합성캐릭터4' });
  await execute(interaction);
  const embed = interaction.payloads.at(-1).embeds[0].toJSON();
  assert.match(embed.description, /^젬 효율 \*\*9\.41%\*\*\n└ 옵션 6\.71% · 포인트 2\.52%\n└ 레벨 중앙값 8\.52% 대비 \*\*\+0\.89%\*\*\n젬 기댓값 \*\*812,345 G\*\*$/);
  assert.match(embed.fields[0].value, /추가 피해.*3\.23%[\s\S]*낙인력/);
  assert.doesNotMatch(JSON.stringify(embed), /lopec\.kr/);
  assert.match(embed.footer.text, /^포근해용 계산 기준 · 실효율 0%는 이 직업이 쓰지 않는 옵션이에요/);
  assert.ok(embed.footer.text.includes(DEVELOPMENT_NOTE));
});

test('/젬효율 falls back to the efficiency table when the site cannot calculate, still without the address', async () => {
  const execute = createGemExecute({ siteEfficiency: async () => ({ gem: { status: 'unavailable', efficiency: null } }),
    siteValuation: async () => ({ status: 'running', bracelet: { gold: null }, gems: { gold: null } }),
    arkgridEfficiency: async () => ({ efficiency: 7.5, optionEfficiency: null, pointEfficiency: null, effectEfficiencies: [] }), lopecScore: async () => null,
    followValuation: () => new Promise(() => {}) });
  const interaction = makeInteraction('discord', { 닉네임: '합성캐릭터3' });
  await execute(interaction);
  const embed = interaction.payloads.at(-1).embeds[0].toJSON();
  assert.equal(embed.description, '젬 효율 **7.50%**\n젬 기댓값 계산 중 · 끝나면 이 메시지를 갱신해요');
  assert.doesNotMatch(JSON.stringify(embed), /lopec\.kr/);
  assert.match(embed.footer.text, /^효율표 기준/);

  const none = createGemExecute({ siteEfficiency: async () => null, siteValuation: async () => done, arkgridEfficiency: async () => null, lopecScore: async () => null });
  const missing = makeInteraction('discord', { 닉네임: '합성원정대' });
  await none(missing);
  assert.match(missing.payloads.at(-1), /젬 효율을 계산하지 못했어요/);
  assert.doesNotMatch(missing.payloads.at(-1), /로펙/);
});

const running = { status: 'running', bracelet: { gold: null, record: false, reason: 'unavailable' }, gems: { gold: null, knownGold: null, items: 0, known: 0, reason: 'unavailable' } };
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('a running valuation answers at once and the Discord message is updated when the site finishes', async () => {
  const gemExecute = createGemExecute({ siteEfficiency: async () => ({ gem: { status: 'ok', efficiency: 9.41, optionEfficiency: 6.71, pointEfficiency: 2.7, effectEfficiencies: [] } }),
    siteValuation: async () => running, arkgridEfficiency: async () => { throw new Error('fallback must not run'); }, lopecScore: async () => null,
    followValuation: async () => done });
  const discord = makeInteraction('discord', { 닉네임: '합성캐릭터4' });
  await gemExecute(discord);
  assert.match(textOf(discord.payloads), /젬 기댓값 계산 중 · 끝나면 이 메시지를 갱신해요/);
  await settle();
  assert.equal(discord.payloads.length, 2);
  assert.match(textOf([discord.payloads.at(-1)]), /젬 기댓값 \*\*812,345 G\*\*/);

  const kakao = makeInteraction('kakao', { 닉네임: '합성캐릭터4' });
  await gemExecute(kakao); await settle();
  assert.equal(kakao.payloads.length, 1);
  assert.match(textOf(kakao.payloads), /계산 중 · 잠시 후 다시 조회해 주세요/);

  const braceletExecute = createBraceletExecute({ character: createShowCharacter({
    armory: async () => [stone, bracelet], siteEfficiency: async () => ({ bracelet: { status: 'ok', efficiency: 15.62 } }),
    banglePercent: async () => null, braceletEfficiency: async () => null, siteValuation: async () => running,
    followValuation: async () => ({ ...running, status: 'timeout' }) }) });
  const slow = makeInteraction('discord', { 닉네임: '합성캐릭터4' });
  await braceletExecute(slow);
  assert.match(textOf(slow.payloads), /팔찌 기댓값: 계산 중 · 끝나면 이 메시지를 갱신해요/);
  await settle();
  assert.equal(slow.payloads.length, 2);
  assert.match(textOf([slow.payloads.at(-1)]), /팔찌 기댓값: 계산이 오래 걸려요 · 잠시 후 다시 조회해 주세요/);
  const kakaoBracelet = makeInteraction('kakao', { 닉네임: '합성캐릭터4' });
  await braceletExecute(kakaoBracelet); await settle();
  assert.equal(kakaoBracelet.payloads.length, 1);
  assert.match(kakaoBracelet.payloads.at(-1).content, /▸ 팔찌 기댓값 계산 중 · 잠시 후 다시 조회해 주세요/);
});

test('followSiteValuation polls with the short timeout until the site finishes or the deadline passes', async () => {
  const seen = [];
  let clock = 0;
  const timers = [];
  const setTimer = (fn, ms) => { timers.push(ms); clock += ms; fn(); };
  const answers = [running, running, done];
  const value = await followSiteValuation('합성캐릭터4', { getValuation: async (name, options) => { seen.push([name, options.timeoutMs]); return answers.shift(); },
    intervalMs: 4000, deadlineMs: 90000, pollTimeoutMs: 3000, setTimer, now: () => clock });
  assert.equal(value, done); assert.deepEqual(timers, [4000, 4000, 4000]); assert.deepEqual(seen, [['합성캐릭터4', 3000], ['합성캐릭터4', 3000], ['합성캐릭터4', 3000]]);
  clock = 0;
  const late = await followSiteValuation('합성캐릭터4', { getValuation: async () => running, intervalMs: 4000, deadlineMs: 9000, setTimer, now: () => clock });
  assert.equal(late.status, 'timeout'); assert.equal(late.bracelet.gold, null);
});
