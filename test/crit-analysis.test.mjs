import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { analyzeCrit } from '../src/crit-analysis.js';

// Exercise the command adapter without account state, credentials, or network access.
for (const key of Object.keys(process.env)) {
  if (/(?:KEY|TOKEN|SECRET)/i.test(key)) delete process.env[key];
}
globalThis.fetch = () => { throw new Error('Unexpected network request'); };
registerHooks({
  load(url, context, next) {
    if (url.endsWith('/src/lostark.js')) return {
      format: 'module', shortCircuit: true,
      source: 'export const getFullArmory = async () => globalThis.__critArmoryFixture;',
    };
    if (url.endsWith('/src/user-store.js')) return {
      format: 'module', shortCircuit: true,
      source: 'export const NO_CHARACTER_HINT = "fixture-name-required"; export const resolveCharacter = i => i.name;',
    };
    return next(url, context);
  },
});
const command = await import('../src/commands/crit.js');
const { records } = JSON.parse(readFileSync(new URL('./fixtures/crit-armory.json', import.meta.url)));
const snapshot = (value) => JSON.parse(JSON.stringify(value));
const tooltip = (value) => JSON.stringify({ Element_002: { type: 'MultiTextBox', value } });
const node = (description, text) => ({ Description: description, ToolTip: tooltip(text) });
const effectSentences = [
  '진화형 피해가 15.0% 증가합니다.',
  '치명타가 발생할 확률이 최대 80.0% 로 제한됩니다.',
  '공격 시, 초과한 모든 치명타가 발생할 확률의 150.0%가 진화형 피해로 전환됩니다.',
  '이 노드에 의한 진화형 피해는 최대 75.0%까지 적용됩니다.',
];
function fixture(total = 10) {
  return {
    ArmoryProfile: {
      CharacterName: '고정치적', CharacterClassName: '검증', ItemAvgLevel: '1,000.00',
      Stats: [{ Type: '치명', Value: '100', Tooltip: [`치명타 적중률이 <font color="#fff">${total}%</font> 증가합니다.`] }],
    },
    ArmoryEquipment: [], ArmoryEngraving: { ArkPassiveEffects: [] },
    ArkPassive: { Effects: [] }, ArmorySkills: [],
  };
}
async function render(armory, platform = 'discord', name = armory?.ArmoryProfile?.CharacterName) {
  globalThis.__critArmoryFixture = armory;
  const replies = [];
  await command.execute({
    name, platform, deferReply: async () => {},
    reply: async (value) => replies.push(value), editReply: async (value) => replies.push(value),
  });
  return typeof replies[0] === 'string' ? replies[0] : snapshot(replies[0]?.embeds[0].toJSON());
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test('synthetic armories preserve hand-calculated totals and complete bot payloads on both platforms', async () => {
  for (const { name, total, armory, expectedEmbed } of records) {
    const immutable = freeze(structuredClone(armory));
    const result = analyzeCrit(immutable);
    assert.equal(Number(result.total.toFixed(2)), total, name);
    assert.ok(Math.abs(result.sources.reduce((sum, source) => sum + source.value, 0) - result.total) < 1e-10);
    assert.deepEqual(await render(immutable), expectedEmbed, name);
    const kakao = structuredClone(expectedEmbed);
    delete kakao.thumbnail;
    assert.deepEqual(await render(immutable, 'kakao'), kakao, name);
    assert.deepEqual(analyzeCrit(immutable), result, `${name}: repeat does not mutate state`);
  }
});

test('synthetic blunt thorn exposes its invented node contribution as structured numbers', () => {
  const result = analyzeCrit(records.find((record) => record.id === 'blunt-thorn').armory);
  assert.deepEqual(result.bluntThorn.effect, { base: 7, cap: 80, rate: 50, max: 30 });
  const calculation = result.bluntThorn.calculation;
  assert.equal(calculation.excess.toFixed(2), '20.00');
  assert.equal(calculation.converted.toFixed(2), '10.00');
  assert.equal(calculation.evolutionDamage.toFixed(2), '17.00');
  assert.equal(calculation.capped, false);
  assert.equal(analyzeCrit(records.find((record) => record.id === 'baseline').armory).bluntThorn, null);
});

test('blunt thorn boundaries apply the cap to the combined node effect', async () => {
  for (const total of [70, 80, 120, 130]) {
    const armory = fixture(total);
    armory.ArkPassive.Effects = [node('진화 5티어 뭉툭한 가시 Lv.2', effectSentences.join(' '))];
    const { calculation } = analyzeCrit(armory).bluntThorn;
    assert.equal(calculation.evolutionDamage, total <= 80 ? 15 : 75);
    assert.equal(calculation.capped, total >= 120);
    assert.match((await render(armory)).description, total <= 80 ? /기본, 초과 치적 없음/ : /상한 도달/);
  }
});

test('missing or invalid current-node numbers never use a default or the next-level tooltip', async () => {
  const variants = effectSentences.map((_, index) => effectSentences.filter((_, i) => i !== index).join(' '));
  for (const value of ['15..0', '-15.0', 'NaN', 'Infinity']) variants.push(effectSentences.join(' ').replace('15.0', value));
  for (const value of variants) {
    const armory = fixture(109.04);
    armory.ArkPassive.Effects = [{
      Description: '진화 5티어 뭉툭한 가시 Lv.2',
      ToolTip: JSON.stringify({
        Element_002: { type: 'MultiTextBox', value },
        Element_003: { type: 'MultiTextBox', value: effectSentences.join(' ') },
      }),
    }];
    const result = analyzeCrit(armory).bluntThorn;
    assert.equal(result.effect, null);
    assert.equal(result.calculation, null);
    assert.match((await render(armory)).description, /효과 수치를 읽지 못해 계산 생략/);
  }
});

test('different node levels use their own four tooltip values', () => {
  const armory = fixture(80);
  armory.ArkPassive.Effects = [node('진화 5티어 뭉툭한 가시 Lv.1',
    effectSentences.join(' ').replace('15.0', '9.0').replace('80.0', '70.0').replace('150.0', '100.0').replace('75.0', '30.0'))];
  const result = analyzeCrit(armory).bluntThorn;
  assert.equal(result.level, '1');
  assert.deepEqual(result.effect, { base: 9, cap: 70, rate: 100, max: 30 });
  assert.equal(result.calculation.evolutionDamage, 19);
});

test('full stacks, source details, replacement values and conditional nodes keep separate meanings', async () => {
  const armory = fixture();
  armory.ArkPassive.Effects = [
    node('진화 1티어 예리한 감각 Lv.2', '치명타 적중률이 8.0% 증가합니다.'),
    node('진화 4티어 일격 Lv.2', '치명타 적중률이 20.0% 증가합니다.'),
    node('깨달음 1티어 조건부 Lv.1', '강화 상태에서는 치명타 적중률이 13.0% 증가합니다.'),
    node('깨달음 1티어 대체 Lv.1', '강화 상태에서는 치명타 적중률이 100%로 적용됩니다.'),
  ];
  armory.ArmoryEngraving.ArkPassiveEffects = [
    { Name: '중첩각인', Level: 1, Description: '치명타 적중률 +1.4% 증가합니다. 최대 5중첩' },
    { Name: '추가각인', Level: 2, Description: '치명타 적중률 +3.0% 증가합니다.' },
    { Name: '선수필승', Level: 1, Description: '치명타 적중률이 100%로 적용됩니다.' },
    { Name: '미채용', Level: 0, Description: '치명타 적중률 +90% 증가합니다.' },
  ];
  const result = analyzeCrit(armory);
  assert.equal(result.total, 48);
  const engraving = result.sources.find((source) => source.source === '각인');
  assert.equal(engraving.value, 10);
  assert.deepEqual(engraving.details[0], { detail: '중첩각인 Lv.1', value: 7, baseValue: 1.4, stacks: 5 });
  assert.equal(result.conditional.nodes[0].totalValue, 13);
  assert.equal(result.conditional.nodes[1].additive, false);
  assert.deepEqual(result.conditional.replacements, [{ detail: '선수필승 Lv.1', clause: '치명타 적중률이 100%로 적용됩니다' }]);
  assert.match((await render(armory)).description, /• 각인: 10\.00% \(중첩각인 Lv\.1 \(1\.4% ×5중첩\) 7\.00% · 추가각인 Lv\.2 3\.00%\)/);
});

test('only a learned back-attack engraving adds the base 10 percent', () => {
  for (const [name, level, expected] of [['기습의 대가', 1, 20], ['기습의 대가', 0, 10], ['결투의 대가', 1, 10]]) {
    const armory = fixture();
    armory.ArmoryEngraving.ArkPassiveEffects = [{ Name: name, Level: level, Description: '' }];
    assert.equal(analyzeCrit(armory).total, expected);
  }
});

test('skill scope, speed conversion and resistance synergy stay out of the total', () => {
  const armory = fixture();
  armory.ArkPassive.Effects = [
    node('깨달음 1티어 범위 Lv.1', '충격 스킬의 치명타 적중률이 20% 증가합니다.'),
    node('깨달음 1티어 전체 Lv.1', '모든 스킬의 치명타 적중률이 4% 증가합니다.'),
    node('깨달음 1티어 기민함 Lv.3', '기본 이동 속도 증가량 %의 30.0% 만큼 치명타 적중률이 증가합니다.'),
    node('깨달음 1티어 환산 Lv.1', '치명타 발생 확률 1.0%당 피해량이 증가합니다.'),
  ];
  armory.ArmorySkills = [{
    Name: '검증 스킬', Level: 10, Tooltip: tooltip('치명타 적중률이 17% 증가합니다.'),
    Tripods: [
      { Name: '급소 노출', IsSelected: true, Tooltip: '치명타 저항률이 12.0초간 10.0% 감소합니다.' },
      { Name: '미선택', IsSelected: false, Tooltip: '치명타 적중률이 99% 증가합니다.' },
    ],
  }, { Name: '미습득', Level: 1, Tooltip: tooltip('치명타 적중률이 98% 증가합니다.') }];
  const result = analyzeCrit(armory);
  assert.equal(result.total, 14);
  assert.equal(result.conditional.nodes.length, 1);
  assert.equal(result.conditional.nodes[0].totalValue, 20);
  assert.deepEqual(result.conditional.derived, [{ detail: '기민함 Lv.3 (이속 40% × 30%)', value: 12 }]);
  assert.deepEqual(result.conditional.synergies, [{ detail: '검증 스킬 · 급소 노출', value: 10 }]);
  assert.deepEqual(result.conditional.skills, [{ detail: '검증 스킬', clause: '치명타 적중률이 17% 증가합니다' }]);
});

test('an identity table entry is excluded once its own node tooltip provides the value', () => {
  const armory = fixture();
  armory.ArmoryProfile.CharacterClassName = '슬레이어';
  armory.ArkPassive.Effects = [node('깨달음 1티어 포식자 Lv.1', '폭주 시간이 증가합니다.')];
  assert.equal(analyzeCrit(armory).conditional.identities[0].crit, 30);
  armory.ArkPassive.Effects[0] = node('깨달음 1티어 포식자 Lv.1', '폭주 상태에서는 치명타 적중률이 30% 증가합니다.');
  const result = analyzeCrit(armory);
  assert.deepEqual(result.conditional.identities, []);
  assert.equal(result.conditional.nodes[0].totalValue, 30);
  assert.equal(result.total, 10);
});

test('absent optional sections and malformed tooltip JSON keep the existing zero-contribution behavior', () => {
  const armory = fixture();
  armory.ArmoryEquipment = [{ Type: '반지', Tooltip: '{not-json' }];
  delete armory.ArmoryEngraving;
  delete armory.ArkPassive;
  delete armory.ArmorySkills;
  const result = analyzeCrit(armory);
  assert.equal(result.total, 10);
  assert.equal(result.bluntThorn, null);
  assert.deepEqual(Object.values(result.conditional).flat(), []);
});

test('missing character and unresolved armory still use the command guard messages', async () => {
  assert.equal(await render(null), 'fixture-name-required');
  assert.match(await render(null, 'discord', '없는캐릭터'), /없는캐릭터/);
  assert.equal(command.data.toJSON().name, '치적');
  assert.equal(command.critFooter(), '파티 시너지는 제외');
});
