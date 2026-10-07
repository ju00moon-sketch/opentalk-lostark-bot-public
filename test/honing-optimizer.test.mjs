import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizeStage, optimizeHoning } from '../src/honing-optimizer.js';
import { evaluateNormalHoning } from '../src/honing-valuation.js';
import { HONING_STAGES } from '../src/data/honing-valuation.js';
import { breathLimit, breathGainBps, bookName, BREATH_TABLE, BOOST_MODEL } from '../src/data/honing-boost.js';

// 일반 재련 최저 비용. 확률·재료는 기존 모델 것을 그대로 쓰고 보조 재료 선택만 새로 푼다.
const priceTable = {
  '운명의 파괴석': 1.69, '운명의 수호석': 0.18, '운명의 돌파석': 3, '아비도스 융화 재료': 30,
  '운명의 파편': 143 / 3000, '용암의 숨결': 439, '빙하의 숨결': 338,
  '야금술 : 업화 [19-20]': 898, '재봉술 : 업화 [19-20]': 666,
  '야금술 : 업화 [15-18]': 28, '재봉술 : 업화 [15-18]': 5,
};
const priceOf = name => priceTable[name] ?? null;

test('단계마다 한 번 드는 성장 파편이 합계에 들어간다', () => {
  // 기존 honing-valuation.js는 growthShards를 포함한다. 옵티마이저가 빼먹으면 구간 비용이 그만큼 싸게 나온다.
  const shard = 143 / 3000;
  const rows = HONING_STAGES.t4Weapon;
  const from = 18, to = 20;
  const growth = rows.filter(rule => rule.from >= from && rule.from < to)
    .reduce((sum, rule) => sum + (rule.growthShards ?? 0), 0);
  assert.ok(growth > 0, `자료에 성장 파편이 있어야 한다: ${growth}`);

  const withBoost = optimizeHoning({ kind: 'weapon', from, to, priceOf });
  assert.equal(withBoost.status, 'ok');
  // 성장분은 어떤 선택을 해도 같은 금액이므로 최저·맨몸 양쪽에 같이 들어가고 아끼는 금액은 변하지 않는다.
  const stageGrowth = withBoost.stages.reduce((sum, stage) => sum + stage.growthGold, 0);
  assert.ok(Math.abs(stageGrowth - growth * shard) < 1e-6, `${stageGrowth} 대 ${growth * shard}`);
  const saved = withBoost.plainGold - withBoost.expectedGold;
  const rawSaved = withBoost.stages.reduce((sum, stage) => sum + stage.savedGold, 0);
  assert.ok(Math.abs(saved - rawSaved) < 1e-6, '성장분이 아끼는 금액을 흔들지 않는다');
  // 성장 파편 자료가 없는 낮은 단계는 사유를 남긴다 — 0으로 조용히 넘기지 않는다.
  const early = optimizeHoning({ kind: 'weapon', from: 0, to: 2, priceOf });
  assert.ok(early.notes.includes('growth_shards_unverified'), early.notes.join(','));
});

test('계획을 구간으로 묶으면 빈틈 없이 전체를 덮는다', () => {
  const result = optimizeHoning({ kind: 'weapon', from: 18, to: 19, priceOf });
  const [stage] = result.stages;
  assert.equal(stage.segments[0].from, 1);
  assert.equal(stage.segments[stage.segments.length - 1].to, stage.plan.length);
  for (const [index, segment] of stage.segments.entries()) {
    if (index === 0) continue;
    assert.equal(segment.from, stage.segments[index - 1].to + 1, '구간이 이어진다');
  }
  // 같은 선택이 이어지는 회차는 한 구간으로 묶인다.
  for (const segment of stage.segments) {
    for (let attempt = segment.from; attempt <= segment.to; attempt++) {
      const row = stage.plan[attempt - 1];
      assert.equal(row.breath, segment.breath);
      assert.equal(row.book, segment.book);
    }
  }
});

test('숨결 합계는 기본 확률을 넘지 못하고, 1%p보다 낮은 단계는 1%p까지 올린다', () => {
  for (const bps of Object.keys(BREATH_TABLE).map(Number)) {
    const limit = breathLimit(bps);
    const cap = Math.max(bps, BOOST_MODEL.breathFloorBps);
    assert.equal(limit.capBps, cap, `기본 ${bps}bps`);
    assert.equal(breathGainBps(bps, limit.count), cap, `기본 ${bps}bps 최대 투입`);
    assert.equal(breathGainBps(bps, 0), 0);
    // 한도를 넘겨 넣어도 더 오르지 않는다.
    assert.equal(breathGainBps(bps, limit.count + 1), null, '표에 없는 개수는 거절한다');
  }
  assert.equal(breathLimit(4500), null, '자료가 없는 기본 확률은 비워 둔다');
});

test('보조 재료를 쓰지 않으면 기존 모델의 기대 시도 횟수와 같다', () => {
  let checked = 0;
  for (const rows of Object.values(HONING_STAGES)) {
    for (const rule of rows) {
      const baseline = evaluateNormalHoning(rule);
      if (baseline.status !== 'ok') continue;
      // 1회 비용을 1골드로 두면 기대 비용이 곧 기대 시도 횟수다.
      const result = optimizeStage({ successBps: rule.successBps, failBonusBps: rule.failBonusBps, attemptGold: 1 });
      assert.ok(Math.abs(result.expectedGold - baseline.expectedAttempts) < 1e-9,
        `${rule.from}→${rule.to} ${result.expectedGold} 대 ${baseline.expectedAttempts}`);
      assert.ok(Math.abs(result.expectedAttempts - baseline.expectedAttempts) < 1e-9);
      checked += 1;
    }
  }
  assert.ok(checked > 100, `검산한 단계 ${checked}개`);
});

test('보조 재료가 공짜면 언제나 쓰고, 터무니없이 비싸면 쓰지 않는다', () => {
  const rule = { successBps: 300, failBonusBps: 30 };
  const limit = breathLimit(rule.successBps);
  const free = optimizeStage({ ...rule, attemptGold: 10_000,
    breath: { ...limit, unitGold: 0 }, book: { unitGold: 0 } });
  assert.equal(free.plan[0].breath, limit.count, '공짜면 한도까지 넣는다');
  assert.equal(free.plan[0].book, true);
  assert.equal(free.plan[0].successBps, 300 + limit.capBps + 300, '기본 + 숨결 한도 + 책');

  const costly = optimizeStage({ ...rule, attemptGold: 10_000,
    breath: { ...limit, unitGold: 1e9 }, book: { unitGold: 1e9 } });
  assert.equal(costly.plan[0].breath, 0);
  assert.equal(costly.plan[0].book, false);
  // 아무것도 쓰지 않는 답은 무보조 계산과 같아야 한다.
  const plain = optimizeStage({ ...rule, attemptGold: 10_000 });
  assert.ok(Math.abs(costly.expectedGold - plain.expectedGold) < 1e-6);
});

test('보조 재료를 쓸 수 있으면 기대 비용이 무보조보다 낮거나 같다', () => {
  const limit = breathLimit(150);
  for (const unitGold of [0, 50, 439, 5000]) {
    const rule = { successBps: 150, failBonusBps: 15, attemptGold: 30_000 };
    const boosted = optimizeStage({ ...rule, breath: { ...limit, unitGold }, book: { unitGold } });
    const plain = optimizeStage(rule);
    assert.ok(boosted.expectedGold <= plain.expectedGold + 1e-6, `숨결 ${unitGold}G`);
  }
});

test('장인의 기운이 차면 확정 성공으로 끝나고 그 회차에는 보조 재료를 넣지 않는다', () => {
  const limit = breathLimit(50);
  const result = optimizeStage({ successBps: 50, failBonusBps: 5, attemptGold: 1000,
    breath: { ...limit, unitGold: 1 }, book: { unitGold: 1 } });
  const last = result.plan[result.plan.length - 1];
  assert.equal(last.successBps, 10000, '마지막 회차는 확정 성공이다');
  assert.equal(last.guaranteed, true);
  assert.equal(last.breath, 0, '확정 성공에 보조 재료를 넣지 않는다');
  assert.equal(last.book, false);
  // 도달 확률은 회차가 갈수록 줄어든다.
  for (let index = 1; index < result.plan.length; index++) {
    assert.ok(result.plan[index].reachProbability < result.plan[index - 1].reachProbability);
  }
});

test('구간 계산은 단계별 합이고, 책이 없는 단계를 사유로 남긴다', () => {
  const result = optimizeHoning({ kind: 'weapon', from: 18, to: 22, priceOf });
  assert.equal(result.status, 'ok');
  assert.equal(result.stages.length, 4);
  assert.ok(Math.abs(result.expectedGold - result.stages.reduce((sum, s) => sum + s.expectedGold, 0)) < 1e-6);
  assert.ok(result.expectedGold < result.plainGold, '최저 비용이 맨몸보다 싸다');
  // 목표 +21 이상은 거래소에 책이 없다.
  assert.ok(result.notes.includes('book_none_for_stage'));
  // 책은 목표 단계 기준이라 +18→+19는 [19-20] 책을 쓴다.
  assert.equal(result.stages.find(s => s.to === 19).bookName, '야금술 : 업화 [19-20]');
  assert.equal(result.stages.find(s => s.to === 20).bookName, '야금술 : 업화 [19-20]');
  assert.equal(result.stages.find(s => s.to === 21).bookName, null);
  for (const stage of result.stages) assert.equal(stage.breathName, '용암의 숨결');
});

test('시세가 없으면 계산하지 않고 어느 재료가 없는지 알린다', () => {
  const missing = optimizeHoning({ kind: 'weapon', from: 18, to: 19, priceOf: name => (name === '운명의 파괴석' ? null : 1) });
  assert.deepEqual(missing, { status: 'unavailable', reason: 'material_price_unavailable', material: '운명의 파괴석' });
  // 보조 재료 시세만 없으면 그 재료를 빼고 계산은 한다.
  const noBreath = optimizeHoning({ kind: 'weapon', from: 18, to: 19,
    priceOf: name => (name === '용암의 숨결' ? null : priceOf(name)) });
  assert.equal(noBreath.status, 'ok');
  assert.equal(noBreath.stages[0].breathName, null);
  assert.ok(noBreath.notes.includes('breath_price_unavailable'));
});

test('잘못된 입력은 조용히 거절한다', () => {
  for (const bad of [{}, { kind: '무기' }, { kind: 'weapon', from: 5, to: 5, priceOf }, { kind: 'weapon', from: -1, to: 3, priceOf }]) {
    assert.equal(optimizeHoning(bad), null, JSON.stringify(bad));
  }
  for (const bad of [{}, { successBps: 0, failBonusBps: 0, attemptGold: 1 }, { successBps: 300, failBonusBps: -1, attemptGold: 1 }]) {
    assert.equal(optimizeStage(bad), null, JSON.stringify(bad));
  }
});

test('책 이름은 거래소 품명이고 구간 밖에는 없다', () => {
  assert.equal(bookName('t4', 'weapon', 14), '야금술 : 업화 [11-14]');
  assert.equal(bookName('t4', 'armor', 15), '재봉술 : 업화 [15-18]');
  assert.equal(bookName('t4', 'weapon', 20), '야금술 : 업화 [19-20]');
  assert.equal(bookName('t4', 'weapon', 21), null);
  assert.equal(bookName('serka', 'armor', 16), '재봉술 : 전율 [16-19]');
  assert.equal(bookName('vambrace', 'weapon', 12), null);
});
