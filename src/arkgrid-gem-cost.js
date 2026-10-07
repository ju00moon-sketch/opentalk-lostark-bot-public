export const GEM_COST_MODEL = '2026-09-16.1-four-scenarios';
// Official 2025-08-20 patch: /News/Notice/Views/13204. Pheons apply per purchased gem.
const PHEONS = Object.freeze({ 희귀: 6, 영웅: 12 });
const GRADES = Object.freeze(['희귀', '영웅']);
const MODES = Object.freeze({ general: [false, false], boundGold: [true, false],
  boundPheon: [false, true], boundBoth: [true, true] });
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const equal = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const unavailable = reason => ({ status: 'unavailable', reason, totalExpectedGold: null,
  purchaseExpectedGold: null, processingExpectedGold: null, pheonExpectedGold: null,
  requiredBoundGold: null, requiredBoundPheons: null, startingGrade: null, comparisonComplete: false });

function normalize(alternatives) {
  if (!Array.isArray(alternatives) || alternatives.length > 2) return null;
  const seen = new Set(), valid = [];
  for (const row of alternatives) {
    if (!row || !GRADES.includes(row.startingGrade) || seen.has(row.startingGrade)) return null;
    seen.add(row.startingGrade);
    if (row.status === 'unavailable') continue;
    if (row.status !== 'ok' || !finite(row.expectedStartingGems) || row.expectedStartingGems < 1 ||
        !finite(row.successProbability) || row.successProbability <= 0 || row.successProbability > 1 ||
        !equal(row.successProbability * row.expectedStartingGems, 1) ||
        !finite(row.purchaseGold) || row.purchaseGold <= 0 || !finite(row.purchaseExpectedGold) ||
        !finite(row.processingExpectedGold) || !finite(row.totalExpectedGold) ||
        !equal(row.purchaseExpectedGold, row.purchaseGold * row.expectedStartingGems) ||
        !equal(row.totalExpectedGold, row.purchaseExpectedGold + row.processingExpectedGold)) return null;
    valid.push(row);
  }
  return valid;
}

/** Fixed-policy expected tradable outlay; bound balances are hypothetical, never read. */
export function buildGemCostScenarios(alternatives, currencyQuote) {
  const rows = normalize(alternatives);
  const currency = currencyQuote?.status === 'ok' && finite(currencyQuote.pheonUnitGold) && currencyQuote.pheonUnitGold > 0
    ? structuredClone(currencyQuote) : null;
  const availableGrades = GRADES.filter(grade => rows?.some(row => row.startingGrade === grade));
  const scenarios = {};
  for (const [mode, [boundGold, boundPheon]] of Object.entries(MODES)) {
    const fail = reason => { scenarios[mode] = { ...unavailable(reason), availableGrades: [...availableGrades] }; };
    if (rows === null) { fail('invalid_grade_results'); continue; }
    if (!rows.length) { fail('starting_prices_unavailable'); continue; }
    if (!boundPheon && !currency) { fail('pheon_currency_unavailable'); continue; }
    const candidates = rows.map(row => {
      const expectedPheons = row.expectedStartingGems * PHEONS[row.startingGrade];
      const purchaseExpectedGold = row.purchaseExpectedGold;
      const processingExpectedGold = boundGold ? 0 : row.processingExpectedGold;
      const pheonExpectedGold = boundPheon ? 0 : expectedPheons * currency.pheonUnitGold;
      return { status: 'ok', modelVersion: `${GEM_COST_MODEL}/${row.modelVersion}`, costModelVersion: GEM_COST_MODEL,
        calculationModelVersion: row.modelVersion, comparison: row.comparison,
        policyVersion: row.policyVersion, startingGrade: row.startingGrade,
        successProbability: row.successProbability, expectedStartingGems: row.expectedStartingGems,
        expectedProcessingCount: row.expectedProcessingCount, expectedRerolls: row.expectedRerolls,
        purchaseGold: row.purchaseGold, baseProcessingGold: row.baseProcessingGold,
        purchaseExpectedGold, processingExpectedGold, pheonExpectedGold,
        totalExpectedGold: purchaseExpectedGold + processingExpectedGold + pheonExpectedGold,
        expectedPheons, resourceProcessingGold: row.processingExpectedGold,
        requiredBoundGold: boundGold ? row.processingExpectedGold : 0,
        requiredBoundPheons: boundPheon ? expectedPheons : 0,
        comparisonComplete: availableGrades.length === GRADES.length, availableGrades: [...availableGrades],
        selectionBasis: 'lowest_expected_tradable_gold_among_available_grades',
        assumptions: [
          '희귀·영웅 시작 젬 중 같은 고정 가공 정책에서 거래 가능 골드 지출 기댓값이 작은 등급을 선택합니다. 최적 가공 정책을 뜻하지 않습니다.',
          '가공 초기화·융합·재판매 회수는 사용하지 않습니다.',
          ...(boundGold ? ['해당 캐릭터의 보유 귀속 골드로 가공비 전액을 충당한다고 가정합니다. 젬 구매가는 그대로 필요합니다.'] : []),
          ...(boundPheon ? ['보유 페온으로 구매에 필요한 페온 전액을 충당한다고 가정합니다. 보유량은 조회하지 않습니다.'] : ['페온은 100개당 850 크리스탈의 대량 상품 단가로 환산하며 묶음 구매 잔량은 반영하지 않습니다.']),
          '필요 재화도 평균 기댓값이므로 해당 수량만으로 성공을 보장하지 않습니다.',
        ] };
    });
    if (candidates.some(row => !finite(row.totalExpectedGold) || !finite(row.expectedPheons))) {
      fail('cost_out_of_range'); continue;
    }
    candidates.sort((a, b) => a.totalExpectedGold - b.totalExpectedGold || GRADES.indexOf(a.startingGrade) - GRADES.indexOf(b.startingGrade));
    scenarios[mode] = candidates[0];
  }
  return { scenarios, currency };
}
