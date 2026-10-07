import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGemCostScenarios } from '../src/arkgrid-gem-cost.js';

const currency = { status: 'ok', pheonUnitGold: 10, price95: 10 * 95 / 8.5, observedAt: 100, checkedAt: 200 };
const row = (startingGrade, expectedStartingGems, purchaseGold, processingExpectedGold) => ({
  status: 'ok', comparison: 'at-least', startingGrade, expectedStartingGems, successProbability: 1 / expectedStartingGems,
  purchaseGold, purchaseExpectedGold: expectedStartingGems * purchaseGold, processingExpectedGold,
  totalExpectedGold: expectedStartingGems * purchaseGold + processingExpectedGold,
  expectedProcessingCount: 6, expectedRerolls: 1, baseProcessingGold: 900, modelVersion: 'test', policyVersion: 'test',
});

test('four scenarios choose grades independently and preserve the resources covered by bound balances', () => {
  const rows = [row('희귀', 10, 100, 1000), row('영웅', 2, 700, 100)];
  const result = buildGemCostScenarios(rows, currency).scenarios;
  assert.equal(result.general.startingGrade, '영웅'); assert.equal(result.general.totalExpectedGold, 1740);
  assert.equal(result.boundGold.startingGrade, '희귀'); assert.equal(result.boundGold.totalExpectedGold, 1600);
  assert.equal(result.boundGold.requiredBoundGold, 1000); assert.equal(result.boundGold.processingExpectedGold, 0);
  assert.equal(result.boundPheon.startingGrade, '영웅'); assert.equal(result.boundPheon.totalExpectedGold, 1500);
  assert.equal(result.boundPheon.requiredBoundPheons, 24); assert.equal(result.boundPheon.pheonExpectedGold, 0);
  assert.equal(result.boundBoth.startingGrade, '희귀'); assert.equal(result.boundBoth.totalExpectedGold, 1000);
  assert.equal(result.boundBoth.requiredBoundGold, 1000); assert.equal(result.boundBoth.requiredBoundPheons, 60);
  for (const value of Object.values(result)) {
    assert.equal(value.totalExpectedGold, value.purchaseExpectedGold + value.processingExpectedGold + value.pheonExpectedGold);
    assert.equal(value.comparisonComplete, true); assert.equal(value.purchaseGold > 0, true);
    assert.equal(value.comparison, 'at-least'); assert.equal(value.calculationModelVersion, 'test');
    assert.equal(value.successProbability, 1 / value.expectedStartingGems);
  }
});

test('missing currency still permits owned-pheon scenarios without treating the missing quote as free', () => {
  const s = buildGemCostScenarios([row('희귀', 2, 100, 500), row('영웅', 1, 400, 100)], null).scenarios;
  assert.equal(s.general.status, 'unavailable'); assert.equal(s.general.totalExpectedGold, null);
  assert.equal(s.boundGold.status, 'unavailable'); assert.equal(s.boundPheon.totalExpectedGold, 500);
  assert.equal(s.boundBoth.totalExpectedGold, 200);
});

test('one available grade remains explicitly incomplete, no grades means no zero total', () => {
  const missing = { status: 'unavailable', startingGrade: '영웅', reason: 'missing_quote' };
  const one = buildGemCostScenarios([row('희귀', 1.5, 10.5, 99.1), missing], currency).scenarios.general;
  assert.equal(one.status, 'ok'); assert.equal(one.comparisonComplete, false);
  assert.deepEqual(one.availableGrades, ['희귀']); assert.equal(one.expectedPheons, 9);
  assert.equal(one.totalExpectedGold, 204.85);
  for (const result of Object.values(buildGemCostScenarios([missing], currency).scenarios)) {
    assert.equal(result.status, 'unavailable'); assert.equal(result.totalExpectedGold, null);
  }
});

test('invalid or duplicated grades, incoherent decomposition and overflow are not plausible prices', () => {
  const good = row('희귀', 2, 100, 100);
  for (const rows of [[good, good], [{ ...good, startingGrade: '고급' }], [{ ...good, expectedStartingGems: Infinity }],
    [{ ...good, processingExpectedGold: -1 }], [{ ...good, purchaseExpectedGold: 1 }],
    [{ ...good, successProbability: 0 }], [{ ...good, totalExpectedGold: NaN }]]) {
    assert.equal(buildGemCostScenarios(rows, currency).scenarios.general.status, 'unavailable');
  }
});

test('inputs are unchanged, tied results are stable and no random discount is applied', () => {
  const rows = [row('영웅', 1, 100, 100), row('희귀', 2, 50, 100)], before = JSON.stringify(rows);
  const result = buildGemCostScenarios(rows, currency);
  assert.equal(JSON.stringify(rows), before); assert.equal(result.scenarios.general.startingGrade, '희귀');
  assert.equal(result.scenarios.general.totalExpectedGold, 320);
});
