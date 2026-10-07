import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeNativeEfficiency } from '../src/native-character-efficiency.js';
import { fixture, withGrid, setBracelet, icon } from './helpers/native-efficiency-fixture.mjs';
const analyze = (raw) => analyzeNativeEfficiency(raw, { now: 0 });
test('complete entry exposes eight factors, exact truncation and an epoch timestamp', () => {
  const result = analyze(fixture());
  assert.equal(result.bracelet.status, 'ok'); assert.deepEqual(result.bracelet.omitted, []);
  const ratio = (1.3 + .00041 * 2600) / (1.3 + .00041 * 2500);
  assert.equal(result.bracelet.efficiency, Math.floor((ratio * 1.021 - 1) * 10000) / 100);
  assert.equal(result.bracelet.formulas.length, 8); assert.equal(result.calculatedAt, 0);
  assert.equal(result.source, 'official-api'); assert.ok(result.bracelet.assumptions.some((s) => s.includes('1.021')));
});
test('unresolved whole groups never fall back to a lower partial number', () => {
  for (const suffix of ['특정 대상에만 적용된다.', '다음 공격에 적용된다.', '조건 충족 시 적용된다.']) {
    const result = analyze(fixture(`${icon}추가 피해가 3% 증가한다.<BR>${suffix}${icon}치명 +100`)).bracelet;
    assert.equal(result.status, 'unavailable'); assert.equal(result.efficiency, null);
    assert.ok(result.omitted.some((s) => s.includes(suffix))); assert.deepEqual(result.formulas, []);
  }
});
test('strict stat syntax and inconsistent totals cannot become zero contributions', () => {
  for (const value of ['1,,00', '10,00', ',100', '100,', '1,000,00', 'NaN']) {
    assert.equal(analyze(fixture(`${icon}치명 +${value}`)).bracelet.efficiency, null);
    const raw = fixture(); raw.ArmoryProfile.Stats[0].Value = value;
    assert.equal(analyze(raw).bracelet.efficiency, null);
  }
  assert.equal(analyze(fixture(`${icon}치명 +1,000`)).bracelet.status, 'ok');
  assert.equal(analyze(fixture(`${icon}치명 +1,001`)).bracelet.status, 'unavailable');
});
test('absent, malformed, duplicate and incomplete bracelets remain distinct', () => {
  const absent = fixture(); absent.ArmoryEquipment.pop(); assert.equal(analyze(absent).bracelet.status, 'absent');
  const malformed = fixture(); malformed.ArmoryEquipment.at(-1).Tooltip = '{'; assert.equal(analyze(malformed).bracelet.status, 'unavailable');
  const duplicate = fixture(); duplicate.ArmoryEquipment.push(duplicate.ArmoryEquipment.at(-1)); assert.equal(analyze(duplicate).bracelet.status, 'unavailable');
  const missing = fixture(); missing.ArmorySkills = null; assert.equal(analyze(missing).bracelet.efficiency, null);
  // A support-capable class has no default path, so a class node that names no path stays unresolved (2026-09-18).
  const unknown = fixture(); unknown.ArmoryProfile.CharacterClassName = '바드'; unknown.ArkPassive.Effects = [{ Description: '깨달음 2티어 아직 없는 계열 Lv.1' }]; assert.equal(analyze(unknown).bracelet.efficiency, null);
});
test('attack-affecting effects require full reconstruction inputs', () => {
  // A null or absent avatar block is the official no-avatar form (2026-09-18); any other non-array shape is unresolved.
  const raw = fixture(`${icon}민첩 +6000`); raw.ArmoryAvatars = {};
  const result = analyze(raw).bracelet;
  assert.equal(result.status, 'unavailable'); assert.equal(result.efficiency, null); assert.ok(result.omitted.includes('ArmoryAvatars'));
});
test('gem complete response exposes numeric effects without mutating input', () => {
  const raw = withGrid(), before = JSON.stringify(raw), result = analyze(raw);
  assert.equal(result.gem.status, 'ok'); assert.equal(result.gem.effectEfficiencies[0].effect, 3);
  assert.equal(typeof result.gem.effectEfficiencies[0].description, 'string'); assert.equal(JSON.stringify(raw), before);
});
test('malformed public inputs are bounded and safely isolated', () => {
  for (const raw of [null, {}, [], { ArmoryProfile: {} }, { ArmoryProfile: {}, ArmoryEquipment: Array(31).fill(null) }]) assert.doesNotThrow(() => analyze(raw));
  const raw = fixture(); raw.ArmoryProfile.CharacterName = '<img src=x onerror=x>시험캐릭터';
  setBracelet(raw, '<script>globalThis.fail=1</script>NaN');
  assert.equal(analyze(raw).characterName, '시험캐릭터'); assert.equal(analyze(raw).bracelet.efficiency, null); assert.equal(globalThis.fail, undefined);
  raw.ArmoryEquipment.at(-1).Tooltip = ' '.repeat(262145); assert.equal(analyze(raw).bracelet.status, 'unavailable');
  assert.doesNotThrow(() => analyzeNativeEfficiency(raw, { now: Symbol('invalid') }));
  assert.equal(analyzeNativeEfficiency(raw, null).bracelet.status, 'unavailable');
});
