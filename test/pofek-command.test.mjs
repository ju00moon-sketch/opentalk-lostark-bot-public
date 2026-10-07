import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecute, tierBasisText, recordText, scoreText, nextTierText, TIER_DISTRIBUTION, tierCardUrl } from '../src/commands/pofek.js';
import { cardLinkFor } from '../src/kakao/render.js';
import { renderPreview } from '../src/kakao/preview.js';

const makeInteraction = (platform, options = {}) => {
  const payloads = [], followUps = [];
  return { payloads, followUps, platform, user: { id: 'pofek-fixture', username: '기본캐릭터' },
    options: { getString: (name) => options[name] ?? null },
    async deferReply() {}, async reply(value) { payloads.push(value); }, async editReply(value) { payloads.push(value); }, async followUp(value) { followUps.push(value); } };
};
const embedsOf = (payload) => (payload.embeds ?? []).map((embed) => embed.toJSON());

const spec = {
  status: 'ok',
  profile: { characterName: '합성예제', serverName: '루페온', characterClass: '소울이터', itemLevel: 1805, combatPower: 12345.67, title: null, guildName: '포근해', characterImage: 'https://cdn-lostark.game.onstove.com/armory/x.png' },
  score: { score: 9737.466802251844, role: 'dealer', modelVersion: '2026-09-16.1' }, omitted: [],
  tier: { key: 'esther', name: '에스더', status: 'ok', basis: 'lopec', percentile: 0.001, source: '로펙 DB', reason: null, next: null, reference: null },
  record: { score: 9737.47, recordedAt: Date.UTC(2026, 8, 16, 20, 0), current: true },
  bracelet: { status: 'ok', efficiency: 16.16 }, gem: { status: 'ok', efficiency: 14.25 },
};

test('tier wording and record line mirror the character page', () => {
  assert.equal(tierBasisText(spec.tier), '로펙 DB 기준 상위 0.01% 미만');
  assert.equal(tierBasisText({ status: 'ok', percentile: 6.92, source: '로펙 DB' }), '로펙 DB 기준 상위 6.92%');
  assert.equal(tierBasisText({ status: 'unavailable', reason: 'lopec_record_mismatch', reference: { score: 8428.22, percentile: 0.19 } }), '현재 장착 점수 구간 기준 · 로펙 최고 기록 8,428점 기준 상위 0.19%');
  assert.equal(tierBasisText({ status: 'unavailable', reason: 'lopec_unavailable', reference: null }), '점수 구간 기준 · 순위 자료 없음');
  assert.equal(recordText(spec.record), '9,737.47점 · 2026.9.17 · 현재 점수');
  assert.equal(recordText({ score: 8428.22, recordedAt: Date.UTC(2026, 8, 16, 10, 0), current: false }), '8,428.22점 · 2026.9.16');
  assert.equal(recordText(null), null);
  assert.equal(scoreText(4238.59, { score: 8428.22, recordedAt: 5, current: false }), '8,428.22점 (현재 4,238.59점)');
  assert.equal(scoreText(9737.466802251844, { score: 9737.47, recordedAt: 5, current: true }), '9,737.47점');
  assert.equal(scoreText(4238.59, null), '4,238.59점');
  assert.equal(nextTierText({ next: { name: '다이아몬드', percentile: 12 } }), '다이아몬드 · 상위 12.00% 이내');
  assert.equal(nextTierText({ next: { name: '챌린저', percentile: 0.5 } }), '챌린저 · 상위 0.50% 이내');
  assert.equal(nextTierText({ next: null }), '최고 티어');
  assert.equal(TIER_DISTRIBUTION, '에스더 0.1% · 챌린저 0.5% · 그랜드마스터 1.5% · 마스터 5% · 다이아몬드 12% · 플래티넘 25% · 골드 45% · 실버 70% · 브론즈 90% · 아이언 그 외');
  assert.equal(tierCardUrl('esther'), 'https://opentalk.example.invalid/assets/tiers/esther-card.png');
});

test('discord sends the tier image alone first and the spec summary as a second message', async () => {
  const execute = createExecute({ siteSpec: async (name) => (name === '합성예제' ? spec : null) });
  const discord = makeInteraction('discord', { 닉네임: '합성예제' });
  await execute(discord);
  assert.equal(discord.payloads.length, 1); assert.equal(discord.followUps.length, 1);
  const [tierEmbed] = embedsOf(discord.payloads[0]);
  assert.equal(tierEmbed.image.url, tierCardUrl('esther')); assert.equal(tierEmbed.title, undefined); assert.equal(tierEmbed.description, undefined);
  const [specEmbed] = embedsOf(discord.followUps[0]);
  assert.match(specEmbed.title, /합성예제 — 포근해용 환산 점수/);
  assert.match(specEmbed.description, /환산 점수 \*\*9,737\.47점\*\* · 에스더 · 딜러\n로펙 DB 기준 상위 0\.01% 미만\n다음 티어 최고 티어\n팔찌 효율 16\.16% · 젬 효율 14\.25%\n공식 전투력 12,345\.67 · 소울이터 · 루페온 · Lv\.1,805\.00$/);
  assert.equal(specEmbed.fields[0].name, '티어 기준 (상위 %)'); assert.equal(specEmbed.fields[0].value, TIER_DISTRIBUTION);
  assert.ok(!/https?:\/\//.test(specEmbed.description));
  assert.equal(specEmbed.thumbnail.url, spec.profile.characterImage);
});

test('kakao gets the tier card link first and the spec rows as the text', async () => {
  const execute = createExecute({ siteSpec: async () => spec });
  const kakao = makeInteraction('kakao', { 닉네임: '합성예제' });
  await execute(kakao);
  assert.equal(kakao.followUps.length, 0);
  const payload = kakao.payloads.at(-1);
  assert.deepEqual(payload.tierCard, { key: 'esther', name: '합성예제' });
  assert.match(payload.content, /❙ 합성예제 · 포근해용 스펙/);
  assert.match(payload.content, /▸ 환산 점수 9,737\.47점\n▸ 티어 에스더 · 딜러\n▸ 기준 로펙 DB 기준 상위 0\.01% 미만\n▸ 다음 티어 최고 티어/);
  assert.match(payload.content, /※ 티어 기준\(상위 %\) 에스더 0\.1% · 챌린저 0\.5%/);
  assert.match(payload.content, /▸ 팔찌 효율 16\.16%\n▸ 젬 효율 14\.25%\n▸ 공식 전투력 12,345\.67/);
  assert.match(payload.content, /※ 포근해용 계산 기준/); assert.ok(!/https?:\/\//.test(payload.content));
  assert.equal(cardLinkFor([payload], { baseUrl: 'https://opentalk.example.invalid' }), 'https://opentalk.example.invalid/p/tier/esther%3A%ED%95%A9%EC%84%B1%EC%98%88%EC%A0%9C?v=3');
  assert.equal(cardLinkFor([{ content: 'x', tierCard: { key: 'not a key', name: '합성예제' } }], { baseUrl: 'https://b' }), null);
});

test('custom tier art swaps only the card picture; the tier wording stays the real tier', async () => {
  const dream = { ...spec, profile: { ...spec.profile, characterName: '합성원정대둘' },
    tier: { key: 'diamond', name: '다이아몬드', status: 'ok', basis: 'lopec', percentile: 8.4, source: '로펙 DB', reason: null, reference: null,
      next: { name: '마스터', percentile: 5 }, art: { key: 'dream', name: '합성원정대', label: '합성원정대 전용 티어' } } };
  const kakao = makeInteraction('kakao', { 닉네임: '합성원정대둘' });
  await createExecute({ siteSpec: async () => dream })(kakao);
  const payload = kakao.payloads.at(-1);
  assert.deepEqual(payload.tierCard, { key: 'dream', name: '합성원정대둘' });
  assert.match(payload.content, /▸ 티어 다이아몬드 · 딜러\n▸ 기준 로펙 DB 기준 상위 8\.40%\n▸ 다음 티어 마스터 · 상위 5\.00% 이내/);
  assert.ok(!payload.content.includes('합성원정대 전용'));
  assert.equal(cardLinkFor([payload], { baseUrl: 'https://opentalk.example.invalid' }), 'https://opentalk.example.invalid/p/tier/dream%3A%ED%95%A9%EC%84%B1%EC%9B%90%EC%A0%95%EB%8C%80%EB%91%98?v=3');
  const discord = makeInteraction('discord', { 닉네임: '합성원정대둘' });
  await createExecute({ siteSpec: async () => dream })(discord);
  assert.equal(embedsOf(discord.payloads[0])[0].image.url, 'https://opentalk.example.invalid/assets/tiers/dream-card.png');
  assert.match(embedsOf(discord.followUps[0])[0].description, /· 다이아몬드 · 딜러\n로펙 DB 기준 상위 8\.40%/);
  // An art key the bot does not know falls back to the real tier's card.
  for (const art of [{ key: 'nope', name: 'x', label: 'y' }, { key: 'esther' }, 'dream', null]) {
    const odd = makeInteraction('kakao', { 닉네임: '합성원정대둘' });
    await createExecute({ siteSpec: async () => ({ ...dream, tier: { ...dream.tier, art } }) })(odd);
    assert.deepEqual(odd.payloads.at(-1).tierCard, { key: 'diamond', name: '합성원정대둘' });
  }
});

test('pending, missing and uncomputed site answers read as plain guidance', async () => {
  for (const [value, pattern] of [[{ status: 'running' }, /계산 중 · 잠시 후 다시 조회해 주세요/], [null, /홈페이지에서 환산 점수를 가져오지 못했어요/],
    [{ status: 'unavailable', omitted: ['각인 이름·등급·레벨·중복 오류'] }, /계산하지 못했어요/]]) {
    const execute = createExecute({ siteSpec: async () => value });
    const discord = makeInteraction('discord', { 닉네임: '합성예제' });
    await execute(discord);
    assert.equal(discord.followUps.length, 0); assert.match(discord.payloads.at(-1), pattern);
  }
});

test('the tier card page carries the site image and rejects unknown tiers or odd names', async () => {
  const page = await renderPreview('tier', encodeURIComponent('esther:합성예제'), { baseUrl: 'https://opentalk.example.invalid' });
  assert.equal(page.status, 200);
  assert.match(page.html, /og:image" content="https:\/\/opentalk.example.invalid\/assets\/tiers\/esther-card\.png\?v=3"/);
  assert.match(page.html, /합성예제 · 에스더 티어/);
  assert.match(page.html, /og:image:width" content="1200"/); assert.match(page.html, /og:image:height" content="630"/);
  for (const id of ['legend:합성예제', 'esther', 'esther:', 'esther:<b>', 'esther:' + '가'.repeat(13)]) {
    assert.equal((await renderPreview('tier', encodeURIComponent(id), { baseUrl: 'https://b' })).status, 404);
  }
  const custom = await renderPreview('tier', encodeURIComponent('dream:합성원정대'), { baseUrl: 'https://opentalk.example.invalid' });
  assert.equal(custom.status, 200);
  assert.match(custom.html, /og:image" content="https:\/\/opentalk.example.invalid\/assets\/tiers\/dream-card\.png\?v=3"/);
  assert.match(custom.html, /og:title" content="합성원정대 · 합성원정대 전용 티어"/);
  assert.match(custom.html, /og:url" content="https:\/\/opentalk.example.invalid\/p\/tier\/dream%3A%ED%95%A9%EC%84%B1%EC%9B%90%EC%A0%95%EB%8C%80\?v=3"/);
  for (const id of ['nope:합성원정대', 'dream:', 'dream:<b>', 'dream:' + '가'.repeat(13)]) {
    assert.equal((await renderPreview('tier', encodeURIComponent(id), { baseUrl: 'https://b' })).status, 404);
  }
});
