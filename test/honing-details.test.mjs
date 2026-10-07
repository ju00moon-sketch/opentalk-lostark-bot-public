import test from 'node:test';
import assert from 'node:assert/strict';
import * as optimizer from '../src/honing-optimizer.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-8 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
const run = (options = {}) => optimizer.optimizeHoning({ kind: 'weapon', from: 0, to: 1,
  priceOf: name => /숨결|술/.test(name) ? null : 1, includeDetails: true, ...options });

test('100% 실제 단계의 재료·골드·분위수는 4147G 손계산과 같고 미확인 성장은 null이다', () => {
  const stage = run().stages[0];
  assert.ok(stage.details, '상세 응답이 있어야 한다');
  assert.equal(stage.expectedGold, 4147);
  assert.equal(stage.details.firstAttempt.totalGold, 4147);
  assert.equal(stage.details.worstCase.gold, 4147);
  assert.deepEqual(stage.details.percentiles, [0.5, 0.9].map(probability => ({ probability, attempts: 1, gold: 4147, cumulativeProbability: 1 })));
  for (const [name, quantity] of [['운명의 파괴석', 350], ['운명의 돌파석', 12], ['아비도스 융화 재료', 5], ['운명의 파편', 3000], ['골드', 780]]) {
    const row = stage.details.materials.find(m => m.name === name && m.source === 'base');
    assert.equal(row.expectedQuantity, quantity); assert.equal(row.worstCaseQuantity, quantity);
    assert.equal(row.expectedGold, quantity); assert.equal(row.firstAttemptQuantity, quantity);
  }
  const growth = stage.details.materials.find(m => m.source === 'growth');
  assert.equal(growth.expectedQuantity, null); assert.equal(growth.expectedGold, null);
  assert.equal(growth.availability, 'quantity_unverified');
  assert.equal(stage.details.worstCase.terminal, 'success_probability_100');
});

test('50% 고정 확률의 유한 분포는 손계산 p50 1회·p90 4회·최악 6회와 일치한다', () => {
  assert.equal(typeof optimizer.summarizeHoningPlan, 'function');
  const plan = optimizer.optimizeStage({successBps:5000, failBonusBps:0, attemptGold:10}).plan;
  const detail = optimizer.summarizeHoningPlan(plan, 0);
  near(detail.expectedAttempts, 1.96875); near(detail.expectedGold, 19.6875);
  assert.deepEqual(detail.percentiles, [{probability:0.5, attempts:1, gold:10, cumulativeProbability:0.5},
    {probability:0.9, attempts:4, gold:40, cumulativeProbability:0.9375}]);
  assert.equal(detail.worstCase.gold, 60); assert.equal(detail.worstCase.reachProbability, 0.03125);
  assert.equal(detail.plan[0].artisanAfterFailureBps, 2330);
  assert.equal(detail.plan.at(-1).artisanAfterFailureBps, null);
  near(detail.plan.reduce((sum, p) => sum + p.successProbability, 0), 1);
  assert.equal(optimizer.summarizeHoningPlan(plan.slice(0, -1), 0), null, '잘린 분포는 거절');
});

test('표 밖 극저확률로 상한에서 잘린 계획은 완전한 상세 분포로 집계하지 않는다', () => {
  const stage = optimizer.optimizeStage({successBps:1, failBonusBps:0, attemptGold:1});
  assert.equal(stage.plan.length, optimizer.WALK_LIMIT);
  assert.notEqual(stage.plan.at(-1).successBps, 10000);
  const successMass = stage.plan.reduce((sum, row) => sum + row.reachProbability * row.successBps / 10000, 0);
  near(successMass, 1 - 0.9999 ** optimizer.WALK_LIMIT);
  assert.ok(successMass < 0.04, '대부분의 성공 질량이 절단된 계획 밖에 있다');
  assert.equal(optimizer.summarizeHoningPlan(stage.plan), null, '불완전한 분포를 요약하지 않는다');
});

test('일회성 성장량을 반복하지 않고 숨결·책은 도달 확률로 가중한다', () => {
  const result = run({from:18,to:19,priceOf:()=>1}); const stage=result.stages[0];
  assert.ok(stage.details);
  const rows=stage.details.materials;
  const growth=rows.find(m=>m.source==='growth');assert.equal(growth.expectedQuantity,85000);assert.equal(growth.worstCaseQuantity,85000);
  for(const source of ['breath','book']){
    const row=rows.find(m=>m.source===source);
    const quantity=p=>source==='breath'?p.breath:Number(p.book);
    near(row.expectedQuantity,stage.plan.reduce((n,p)=>n+p.reachProbability*quantity(p),0));
    assert.equal(row.worstCaseQuantity,stage.plan.reduce((n,p)=>n+quantity(p),0));
    assert.equal(row.name,source==='breath'?stage.breathName:stage.bookName);
  }
  near(rows.reduce((n,m)=>n+(m.expectedGold??0),0),stage.expectedGold);
  near(rows.reduce((n,m)=>n+(m.worstCaseGold??0),0),stage.details.worstCase.gold);
  assert.equal(stage.details.plan.at(-1).breathQuantity,0);assert.equal(stage.details.plan.at(-1).bookQuantity,0);
});

test('미확보 보조 재료는 무료로 표시하지 않으며 기존 이름 null을 보존한다', () => {
  const stage=run({from:18,to:19}).stages[0];assert.ok(stage.details);
  assert.equal(stage.breathName,null);assert.equal(stage.bookName,null);
  for(const source of ['breath','book']){
    const row=stage.details.materials.find(m=>m.source===source);
    assert.equal(row.availability,'price_unavailable');assert.equal(row.unitGold,null);
    for(const key of ['expectedQuantity','expectedGold','worstCaseQuantity','worstCaseGold'])assert.equal(row[key],0);
    assert.ok(row.name.length>0);
  }
  const late=run({from:24,to:25}).stages[0];assert.equal(late.details.coverage.book,'not_applicable');
  assert.equal(late.details.materials.some(m=>m.source==='book'),false);
});

test('상세 집계를 켜도 기존 정책·비용·기본 반환 값은 바뀌지 않는다', () => {
  const options={from:18,to:20,priceOf:()=>100};
  const old=run({...options,includeDetails:false}), full=run(options);
  assert.ok(full.stages[0].details);
  const clean={...full,stages:full.stages.map(({details,...stage})=>stage)};
  assert.deepEqual(clean,old);
});
