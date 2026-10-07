import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeNativeGemEfficiency as analyze } from '../src/native-gem-efficiency.js';
import { fixture, withGrid, gridGem, gridEffect } from './helpers/native-efficiency-fixture.mjs';
const truncate = (n) => Math.floor((n - 1) * 10000) / 100;
test('three whole-score comparisons preserve multiplicative totals and intermediate floors', () => {
  const r = analyze(withGrid()); assert.equal(r.status, 'ok');
  // Independent synthetic arithmetic: floor(sqrt(30300*100000/6))=22472;
  // attack flat2700, percentages2.13/1.65 and optional3 yield rounded attacks.
  const normal = (percent) => Math.round((22472 + 2700) * (1 + percent / 100));
  const U = normal(5.13) * 1.32 * 1.01, O = normal(2.13) * 1.30, B = normal(1.65) * 1.30;
  assert.equal(r.optionEfficiency, truncate(U / O)); assert.equal(r.pointEfficiency, truncate(O / B));
  assert.equal(r.efficiency, truncate(U / B));
  assert.ok(Math.abs(r.formulas[0].value - r.formulas[1].value * r.formulas[2].value) < 1e-12);
  for (const f of r.formulas) { const [a, b] = f.formula.split(' ÷ ').map(Number); assert.equal(f.value, a / b); }
});
test('17P and lower cores retain points, including intermediate neutral lookup rows', () => {
  for (const point of [0, 10, 14, 16, 17]) {
    const raw = withGrid(fixture(), point); raw.ArkGrid.Slots[0].Gems = null;
    const result = analyze(raw); assert.equal(result.status, 'ok', String(point));
    assert.equal(result.pointEfficiency, 0); assert.equal(result.diagnostics.coreBaselinePoints[0].point, point);
  }
});
test('only active gem points reduce cores, with an explicit17P floor', () => {
  const raw = withGrid(); raw.ArkGrid.Slots[0].Gems = [gridGem(1), gridGem(5, 1, false)];
  assert.equal(analyze(raw).diagnostics.coreBaselinePoints[0].point, 19);
  raw.ArkGrid.Slots[0].Gems = [gridGem(5), gridGem(5, 1)];
  assert.equal(analyze(raw).diagnostics.coreBaselinePoints[0].point, 17);
  raw.ArkGrid.Slots[0].Gems = [gridGem(30)];
  assert.equal(analyze(raw).diagnostics.coreBaselinePoints[0].point, 17);
});
test('missing, ambiguous, fractional and unfamiliar point units are rejected', () => {
  for (const point of [6, 1.5, 60, -1, '1,,00', 'NaN', '5%', '5개', '5abc', '5<BR>질서 포인트 : 오류']) {
    const raw = withGrid(); raw.ArkGrid.Slots[0].Gems = [gridGem(point)];
    assert.equal(analyze(raw).status, 'unavailable', String(point));
  }
  for (const gems of [null, [gridGem(2), gridGem(2)], [{ ...gridGem(), IsActive: null }], [{ ...gridGem(), Tooltip: '{}' }]]) {
    const raw = withGrid(); raw.ArkGrid.Slots[0].Gems = gems;
    assert.equal(analyze(raw).efficiency, null);
  }
});
test('effect names, labels, levels, values and uniqueness are an atomic contract', () => {
  for (const effect of [gridEffect('보스 피해', '1,,00'), gridEffect('보스 피해', 1, -1), gridEffect('새 효과', 3), { ...gridEffect('보스 피해', 1), Tooltip: '아군 공격력 강화 효과 +1.00%' }]) {
    const raw = withGrid(); raw.ArkGrid.Effects = [effect];
    assert.equal(analyze(raw).status, 'unavailable');
  }
  const raw = withGrid(); raw.ArkGrid.Effects.push(raw.ArkGrid.Effects[0]); assert.equal(analyze(raw).efficiency, null);
});
test('support-only effects and explicit empty effects yield actual zeros, not missing values', () => {
  const raw = withGrid(fixture(), 17); raw.ArkGrid.Effects = [gridEffect('아군 공격 강화', 3), gridEffect('낙인력', 4)];
  let r = analyze(raw); assert.equal(r.status, 'ok'); assert.equal(r.efficiency, 0);
  assert.deepEqual(r.effectEfficiencies.map((e) => e.efficiency), [0, 0]);
  raw.ArkGrid.Effects = []; r = analyze(raw); assert.equal(r.optionEfficiency, 0); assert.deepEqual(r.effectEfficiencies, []);
  // Cores without any gem effect arrive as an official Effects:null (2026-09-18); a non-array shape stays unresolved.
  raw.ArkGrid.Effects = null; assert.deepEqual(analyze(raw), r);
  raw.ArkGrid.Effects = {}; assert.equal(analyze(raw).status, 'unavailable');
});
test('unseen core names, grades and duplicate slots cannot use neutral model defaults', () => {
  for (const change of [r => { r.ArkGrid.Slots[0].Name = '아직 없는 코어'; }, r => { r.ArkGrid.Slots[0].Grade = '새 등급'; }, r => r.ArkGrid.Slots.push(r.ArkGrid.Slots[0])]) {
    const raw = withGrid(); change(raw); assert.equal(analyze(raw).efficiency, null);
  }
});
test('unequipped bracelet is neutral while incomplete bracelet remains unresolved', () => {
  const raw = withGrid(); raw.ArmoryEquipment.pop();
  const r = analyze(raw); assert.equal(r.status, 'ok'); assert.equal(r.diagnostics.full.factors.bracelet, 1);
  raw.ArmoryEquipment.push({ Type: '팔찌', Tooltip: '{}' }); assert.equal(analyze(raw).efficiency, null);
});
test('absence, malformed shape and purity remain distinct', () => {
  assert.equal(analyze({ ArkGrid: null }).status, 'absent'); assert.equal(analyze(fixture()).status, 'absent');
  assert.equal(analyze({ ArkGrid: { Slots: null, Effects: null } }).status, 'absent');
  for (const raw of [null, {}, { ArkGrid: {} }, { ArkGrid: { Slots: null } }, { ArkGrid: { Effects: null } }, { ArkGrid: { Slots: Array(7).fill({}), Effects: [] } }]) assert.equal(analyze(raw).status, 'unavailable', JSON.stringify(raw));
  const raw = withGrid(), before = JSON.stringify(raw); assert.deepEqual(analyze(raw), analyze(raw)); assert.equal(JSON.stringify(raw), before);
});
test('empty official grid shapes and an empty grid score identically in the whole-score comparison', async () => {
  const { evaluateNativeGemScore } = await import('../src/native-gem-efficiency.js');
  const expected = evaluateNativeGemScore(fixture());
  assert.ok(Number.isFinite(expected.value) && expected.value > 0); assert.deepEqual(expected.missing, []);
  for (const grid of [null, { Slots: null, Effects: null }]) {
    const raw = fixture(); raw.ArkGrid = grid;
    assert.deepEqual(evaluateNativeGemScore(raw), expected, JSON.stringify(grid));
  }
  const raw = fixture(); delete raw.ArkGrid;
  assert.equal(evaluateNativeGemScore(raw).value, null);
});
test('legendary and heroic cores within their caps use the relic rows of the dealer core tables', async () => {
  const { evaluateNativeGemScore } = await import('../src/native-gem-efficiency.js');
  const score = (Grade, Point) => { const raw = fixture(); raw.ArkGrid.Slots = [{ Index: 0, Name: '혼돈의 해 코어 : 현란한 공격', Grade, Point, Gems: null }]; return evaluateNativeGemScore(raw); };
  assert.deepEqual(score('전설', 14).missing, []); assert.equal(score('전설', 14).value, score('유물', 14).value);
  assert.equal(score('전설', 14).factors.coreFinalDamage, 1.01); assert.equal(score('영웅', 10).value, score('유물', 10).value);
  assert.notEqual(score('전설', 14).value, evaluateNativeGemScore(fixture()).value);
  for (const [grade, point] of [['전설', 15], ['영웅', 11], ['희귀', 10]]) assert.equal(score(grade, point).value, null, `${grade} ${point}`);
});
