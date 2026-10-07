import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBraceletFactors, mapBraceletModelInput } from '../src/bracelet-model.js';

function input(options = []) {
  return { attack: { without: 100, with: 110 }, additionalDamage: { withoutPercent: 30, braceletPercent: 5 },
    stats: { without: { critical: 500, special: 1400, haste: 100 }, bracelet: { critical: 100, special: 0, haste: 0 } },
    critical: { withoutRate: 80, withoutDamage: 250, withoutCriticalFinal: 1.12, bluntThornLevel: 0 }, speed: { withoutAttackBonus: 35 }, direction: 'back', options };
}
function expectedCritical(c, h, q, level, dc, dh, multiplier) {
  const limit = level === 1 ? 116 : level >= 2 ? 120 : 100;
  const expected = (chance, damage) => {
    const actualChance = Math.min(chance, 100) / 100;
    const [base, conversion, maximum] = level === 1 ? [7.5, 1.25, 52.5] : [15, 1.5, 75];
    const extra = level ? Math.min(base + Math.max(0, Math.min(chance, 120) - 80) * conversion, maximum) : 0;
    return (1 - actualChance + actualChance * damage / 100 * q) * (1 + extra / 100);
  };
  c = Math.min(c, limit);
  const baseline = expected(c, h), x = expected(Math.min(c + 1, limit), h) / baseline - 1, y = expected(c, h + 1) / baseline - 1;
  const adjustment = Math.abs(x) + Math.abs(y) ? (x - y) / (Math.abs(x) + Math.abs(y)) : 0;
  return (1 + .007 * (1 + .024 * adjustment) * Math.max(0, Math.min(c + dc, limit) - c)) * (1 + .0035 * (1 - .024 * adjustment) * dh) * multiplier;
}
test('all eight named multipliers and badge truncation follow the declared arithmetic', () => {
  const actual = calculateBraceletFactors(input([
    { kind: 'primary' }, { critRate: 5, critDmg: 10, critFinalDmg: 1.015, specCritFinalDmg: 1.01 },
    { atkSpeed: 6 }, { finalDmg: 1.05, cdr: .02 }, { staggeredTargetDmg: 1.04 }, { backDmg: 1.03 },
  ]));
  const expected = { attackRatio: 1.1, addDamageRatio: 135 / 130, statRatio: (1.3 + .00041 * 2100) / (1.3 + .00041 * 2000),
    critRatio: expectedCritical(80, 250, 1.12, 0, 5, 10, 1.01), speedRatio: 1 + 6 * .017 / 6,
    finalDmgRatio: 1.05 / 1.014, staggeredTargetDmgRatio: 1 + .04 * .25, fallbackRatio: 1.03 };
  for (const key of Object.keys(expected)) assert.ok(Math.abs(actual.factors[key] - expected[key]) < 1e-12, key);
  assert.equal(actual.efficiency, Math.floor((Object.values(expected).reduce((a, b) => a * b) * 1.021 - 1) * 10000) / 100);
});
test('blunt thorn uses its actual baseline transformation in both sensitivity directions', () => {
  for (const level of [1, 2]) for (const chance of [79, 95, 115, 120, 140]) {
    const source = input([{ critRate: 5, critDmg: 8.4, critFinalDmg: 1.015, specCritFinalDmg: 1.01 }]);
    Object.assign(source.critical, { withoutRate: chance, bluntThornLevel: level });
    const actual = calculateBraceletFactors(source).factors.critRatio;
    assert.ok(Math.abs(actual - expectedCritical(chance, 250, 1.12, level, 5, 8.4, 1.01)) < 1e-12);
  }
});
test('directional selection, speed cap, devil switch and final-damage exclusion are independent', () => {
  const source = input([{ normalDmg: 1.03 }, { atkSpeed: 6 }, { addDmg: 3, devilDmg: 1.025, finalDmg: 1.09 }]);
  source.speed.withoutAttackBonus = 139;
  let actual = calculateBraceletFactors(source).factors;
  assert.equal(actual.fallbackRatio, 1); assert.equal(actual.finalDmgRatio, 1);
  assert.equal(actual.speedRatio, 1 + .017 / 6);
  source.direction = 'normal'; source.devilDamageEnabled = true;
  actual = calculateBraceletFactors(source).factors;
  assert.equal(actual.fallbackRatio, 1.03); assert.equal(actual.finalDmgRatio, 1.025);
});
const box = (title, body) => ({ type: 'ItemPartBox', value: { Element_000: title, Element_001: body } });
const marker = "<img src='emoticon_tooltip_bracelet_changeable'></img>";
function rawFixture(body) {
  return { ArmoryProfile: { CharacterClassName: '블레이드', Stats: [{ Type: '치명', Value: '659' }, { Type: '특화', Value: '1825' }, { Type: '신속', Value: '77' }] },
    ArmoryEquipment: [{ Type: '팔찌', Tooltip: JSON.stringify({ title: { type: 'ItemTitle', value: { leftStr2: '아이템 티어 4' } }, part: box('팔찌 효과', body) }) },
      { Type: '무기', Tooltip: JSON.stringify({ title: { type: 'ItemTitle', value: { qualityValue: 100 } } }) }],
    ArmoryEngraving: { ArkPassiveEffects: [{ Name: '아드레날린', Grade: '유물', Level: 4 }, { Name: '예리한 둔기', Grade: '유물', Level: 4 }] },
    ArmorySkills: [], ArkPassive: { Effects: [{ Description: '깨달음 2티어 잔재된 기운 Lv.3' }, { Description: '진화 3티어 일격 Lv.2' }] }, ArkGrid: { Slots: [], Effects: [] } };
}
test('whole option mapping preserves the badge-specific critical multiplier and neutral effects', () => {
  const raw = rawFixture(`${marker}치명타 피해가 8.4% 증가한다.<BR>공격이 치명타로 적중 시 적에게 주는 피해가 1.5% 증가한다.${marker}공격 적중 시 80초 동안 경직 및 피격 이상에 면역이 된다. (재사용 대기 시간 80초)<BR>해당 효과는 1회 피격 시 사라진다.`);
  const mapped = mapBraceletModelInput(raw, { without: 100, with: 100, missing: [] });
  assert.equal(mapped.options[0].critFinalDmg, 1.015); assert.equal(mapped.options[0].specCritFinalDmg, 1.01);
  assert.equal(mapped.options[1].unknown, undefined); assert.deepEqual(mapped.missing, []);
  assert.equal(mapped.critical.withoutDamage, 252);
});
test('unsupported suffix and malformed grouped number stay unresolved instead of acquiring supported prefixes', () => {
  const mapped = mapBraceletModelInput(rawFixture(`${marker}치명 +1,,00${marker}치명타 피해가 8.4% 증가한다.<BR>특정 대상에만 적용된다.`), { without: 100, with: 100, missing: [] });
  assert.equal(mapped.options.filter((o) => o.unknown).length, 2);
  assert.equal(mapped.options.some((o) => o.critDmg !== undefined), false);
});
test('unknown grades, unseen cores and missing skill arrays cannot be complete results', () => {
  const raw = rawFixture(`${marker}치명 +83`);
  raw.ArmoryEngraving.ArkPassiveEffects[1].Grade = '잘못된 등급';
  raw.ArkGrid.Slots = [{ Index: 0, Name: '질서의 해 코어 : 새 공격력', Point: 20, Grade: '고대' }];
  raw.ArmorySkills = null;
  const mapped = mapBraceletModelInput(raw, { without: 100, with: 100, missing: [] });
  assert.ok(mapped.missing.some((s) => s.includes('각인 등급')));
  assert.ok(mapped.missing.some((s) => s.includes('확인할 수 없는 코어')));
  assert.ok(mapped.missing.some((s) => s.includes('ArmorySkills')));
});

// Official input forms accepted on 2026-09-18 (roster scan of 221 characters).
test('legendary and heroic cores within their caps map through the relic column and the caps still fail closed', () => {
  const map = (Grade, Point) => { const raw = rawFixture(`${marker}치명 +83`); raw.ArkGrid.Slots = [{ Index: 0, Name: '혼돈의 해 코어 : 현란한 공격', Grade, Point }]; return mapBraceletModelInput(raw, { without: 100, with: 100, missing: [] }); };
  const legend = map('전설', 14), relic = map('유물', 14);
  assert.deepEqual(legend.missing, []); assert.equal(legend.critical.withoutCriticalFinal, 1.0055); assert.deepEqual(legend.diagnostics, relic.diagnostics);
  assert.deepEqual(map('영웅', 10).missing, []); assert.equal(map('영웅', 10).critical.withoutCriticalFinal, 1.0055);
  assert.deepEqual(map('전설', 12).missing, []); assert.deepEqual(map('전설', 12).critical, map('유물', 12).critical); assert.equal(map('전설', 12).critical.withoutCriticalFinal, 1);
  for (const [grade, point] of [['전설', 15], ['영웅', 11], ['희귀', 10]]) assert.ok(map(grade, point).missing.some((s) => s.includes('코어 등급 미확인')), `${grade} ${point}`);
});
test('the ability stone reduction line is skipped while a graded reduction name is still an unknown engraving', () => {
  const raw = rawFixture(`${marker}치명 +83`);
  raw.ArmoryEngraving.ArkPassiveEffects.push({ Name: '방어력 감소', Grade: '', Level: 0, AbilityStoneLevel: -1 });
  raw.ArmoryEngraving.ArkPassiveEffects.push({ Name: '이동 속도 감소', Grade: '', Level: 0, AbilityStoneLevel: null });
  const mapped = mapBraceletModelInput(raw, { without: 100, with: 100, missing: [] });
  assert.deepEqual(mapped.missing, []); assert.equal(mapped.critical.withoutDamage, mapBraceletModelInput(rawFixture(`${marker}치명 +83`), { without: 100, with: 100, missing: [] }).critical.withoutDamage);
  raw.ArmoryEngraving.ArkPassiveEffects.push({ Name: '방어력 감소', Grade: '유물', Level: 0, AbilityStoneLevel: -1 });
  assert.ok(mapBraceletModelInput(raw, { without: 100, with: 100, missing: [] }).missing.some((s) => s.includes('방어력 감소: 각인 등급/레벨 모형 미확인')));
});
test('official null grid collections map like an empty grid while a missing grid stays unresolved', () => {
  const expected = mapBraceletModelInput(rawFixture(`${marker}치명 +83`), { without: 100, with: 100, missing: [] });
  assert.deepEqual(expected.missing, []);
  for (const grid of [null, { Slots: null, Effects: null }]) {
    const raw = rawFixture(`${marker}치명 +83`); raw.ArkGrid = grid;
    assert.deepEqual(mapBraceletModelInput(raw, { without: 100, with: 100, missing: [] }), expected, JSON.stringify(grid));
  }
  const raw = rawFixture(`${marker}치명 +83`); delete raw.ArkGrid;
  assert.ok(mapBraceletModelInput(raw, { without: 100, with: 100, missing: [] }).missing.some((s) => s.includes('아크그리드 자료 누락')));
});

// Input forms accepted on 2026-09-18, second pass.
test('a class without any path node maps through its default path with jobDefaulted while ambiguous or support classes stay unresolved', () => {
  const attack = { without: 100, with: 100, missing: [] };
  const raw = rawFixture(`${marker}치명 +83`); raw.ArmoryProfile.CharacterClassName = '버서커'; raw.ArkPassive.Effects = [{ Description: '진화 3티어 일격 Lv.2' }];
  const mapped = mapBraceletModelInput(raw, attack);
  assert.deepEqual(mapped.missing, []); assert.equal(mapped.diagnostics.job, '광전사의 비기'); assert.equal(mapped.diagnostics.jobDefaulted, true);
  assert.ok(mapped.assumptions.includes('깨달음 직업 계열 노드가 없어 광전사의 비기 기준으로 계산했습니다.'));
  const explicit = rawFixture(`${marker}치명 +83`); explicit.ArmoryProfile.CharacterClassName = '버서커';
  explicit.ArkPassive.Effects = [{ Description: '깨달음 1티어 광전사의 비기 Lv.1' }, { Description: '진화 3티어 일격 Lv.2' }];
  const direct = mapBraceletModelInput(explicit, attack); assert.equal(direct.diagnostics.jobDefaulted, false); assert.deepEqual(direct.assumptions, []);
  assert.equal(direct.critical.withoutRate, mapped.critical.withoutRate); assert.equal(direct.speed.withoutAttackBonus, mapped.speed.withoutAttackBonus);
  raw.ArmoryProfile.CharacterClassName = '바드'; const bard = mapBraceletModelInput(raw, attack);
  assert.equal(bard.diagnostics.job, null); assert.equal(bard.diagnostics.jobDefaulted, false); assert.ok(bard.missing.includes('직업별 깨달음 계열 판별 불가'));
  raw.ArmoryProfile.CharacterClassName = '버서커'; raw.ArkPassive.Effects = [{ Description: '깨달음 1티어 광전사의 비기 Lv.1' }, { Description: '깨달음 1티어 광기 Lv.1' }];
  const ambiguous = mapBraceletModelInput(raw, attack); assert.equal(ambiguous.diagnostics.job, null); assert.equal(ambiguous.diagnostics.jobDefaulted, false);
  raw.ArkPassive.Effects = null; assert.equal(mapBraceletModelInput(raw, attack).diagnostics.job, null);
});
test('neutral bracelet lines keep their text without a coefficient while other unknown lines stay unresolved', () => {
  const attack = { without: 100, with: 100, missing: [] };
  const neutral = ['효과 부여 가능', '효과 부여 가능', '마법 방어력 +1200', '[긴급수혈] 생명력이 50% 이하일 경우 몬스터에게 피격 시 30% 확률로 생명력을 16000 회복한다. (재사용 대기시간 120초)', '[강타] 치명타 적중 후 4초 동안 제압이 65, 숙련이 65 증가한다.'];
  const mapped = mapBraceletModelInput(rawFixture(`${marker}치명 +83${neutral.map((text) => marker + text).join('')}`), attack);
  assert.deepEqual(mapped.missing, []); assert.deepEqual(mapped.options.filter((o) => o.neutral).map((o) => o.text), neutral);
  assert.deepEqual(mapped.options.filter((o) => o.neutral).map((o) => Object.keys(o).sort()), neutral.map(() => ['neutral', 'text']));
  assert.deepEqual(calculateBraceletFactors(mapped), calculateBraceletFactors(mapBraceletModelInput(rawFixture(`${marker}치명 +83`), attack)));
  const unknown = mapBraceletModelInput(rawFixture(`${marker}치명 +83${marker}[정체불명] 새 효과`), attack);
  assert.ok(unknown.missing.some((s) => s.includes('미확인 팔찌 옵션: [정체불명] 새 효과'))); assert.equal(unknown.options.at(-1).unknown, true);
});
test('a missing or null engraving block maps as no engravings while a block without an array stays unresolved', () => {
  const attack = { without: 100, with: 100, missing: [] };
  const raw = rawFixture(`${marker}치명 +83`); raw.ArmoryEngraving = { ArkPassiveEffects: [] };
  const expected = mapBraceletModelInput(raw, attack); assert.deepEqual(expected.missing, []);
  const nulled = rawFixture(`${marker}치명 +83`); nulled.ArmoryEngraving = null; assert.deepEqual(mapBraceletModelInput(nulled, attack), expected);
  const absent = rawFixture(`${marker}치명 +83`); delete absent.ArmoryEngraving; assert.deepEqual(mapBraceletModelInput(absent, attack), expected);
  for (const block of [{}, { ArkPassiveEffects: null }]) {
    const bad = rawFixture(`${marker}치명 +83`); bad.ArmoryEngraving = block;
    assert.ok(mapBraceletModelInput(bad, attack).missing.some((s) => s.includes('ArmoryEngraving.ArkPassiveEffects 배열 누락')), JSON.stringify(block));
  }
});
