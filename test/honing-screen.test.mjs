import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { optimizeHoning } from '../src/honing-optimizer.js';

// 도구 화면의 재련 계산기 스크립트를 실제로 실행한다. `node --check`는 문법만 보므로
// 「정의하지 않은 함수를 부른다」 같은 실행 오류를 못 잡는다 — 그 결함이 실제로 났다(2026-09-22 P1).
const source = fs.readFileSync(new URL('../docs/honing.js', import.meta.url), 'utf8');

const priceTable = {
  '운명의 파괴석': 1.69, '운명의 수호석': 0.18, '운명의 돌파석': 3, '아비도스 융화 재료': 30,
  '운명의 파편': 143 / 3000, '용암의 숨결': 439, '야금술 : 업화 [19-20]': 898,
};

// 서버가 실제로 내려보내는 모양을 그대로 만든다(web/src/honing-service.js의 trimStage와 같은 필드).
function payload(from, to) {
  const result = optimizeHoning({ kind: 'weapon', from, to, priceOf: name => priceTable[name] ?? null });
  assert.equal(result.status, 'ok');
  return {
    kind: result.kind, from: result.from, to: result.to, pricedAt: 0, updatedAt: 0,
    expectedGold: result.expectedGold, plainGold: result.plainGold, notes: result.notes,
    stages: result.stages.map(stage => ({
      from: stage.from, to: stage.to, successBps: stage.successBps,
      expectedGold: stage.expectedGold, plainGold: stage.plainGold, expectedAttempts: stage.expectedAttempts,
      breathName: stage.breathName, bookName: stage.bookName,
      firstSuccessBps: stage.plan[0].successBps, maximumAttempts: stage.plan.length,
      segments: stage.segments,
    })),
    materials: {},
  };
}

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {};
    this.className = ''; this.value = ''; this.id = ''; this.textContent = ''; this.hidden = false;
    this.parentNode = null; this.disabled = false;
    this.classList = { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  async fire(name, event = {}) { for (const fn of this.listeners[name] ?? []) await fn({ preventDefault() {}, ...event }); }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  all() { return this.children.flatMap(child => [child, ...child.all()]); }
  text() { return [this.textContent, ...this.all().map(node => node.textContent)].filter(Boolean).join(' '); }
}

function run(body) {
  const nodes = new Map();
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, new Element('div')); return nodes.get(id); };
  for (const id of ['honing-form', 'honing-kind', 'honing-from', 'honing-to', 'honing-result',
    'honing-status', 'honing-submit', 'honing-footer', 'honing-note']) get(id);
  const document = {
    getElementById: (id) => nodes.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => new Element(tag),
    addEventListener: () => {},
    readyState: 'complete',
  };
  const context = { document, window: { location: { origin: 'https://example.invalid' } }, console,
    fetch: async () => ({ ok: true, status: 200, json: async () => body }),
    setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, JSON, Math, Number, Date,
    Intl, Object, Array, String, Boolean, Promise, Error, AbortController, AbortSignal, TextEncoder, isNaN, parseInt, parseFloat };
  context.window.document = document;
  context.globalThis = context;
  vm.createContext(context);
  new vm.Script(source).runInContext(context);
  return { nodes, get };
}

test('정상 응답이 화면까지 그려진다 — 정의 없는 함수 호출로 결과가 숨지 않는다', async () => {
  const { get } = run(payload(18, 19));
  const form = get('honing-form');
  assert.ok((form.listeners.submit ?? []).length > 0, '화면 스크립트가 submit을 잡는다');
  get('honing-kind').value = 'weapon';
  get('honing-from').value = '18';
  get('honing-to').value = '20';
  await form.fire('submit');

  const status = get('honing-status').text();
  assert.equal(/not defined|undefined is not|ReferenceError/.test(status), false, `상태 문구에 실행 오류가 없다: ${status}`);
  const result = get('honing-result');
  assert.equal(result.hidden, false, '결과가 숨겨지지 않는다');
  const text = result.text();
  assert.ok(/G/.test(text), `금액이 그려진다: ${text.slice(0, 120)}`);
  // 조언이 실제로 렌더링됐는지 — describe가 없으면 여기서 비어 버린다.
  assert.ok(/책 1개|숨결|보조 재료 없이/.test(text), `조언이 들어간다: ${text.slice(0, 200)}`);
});

test('닿는 구간을 자르지 않고 전부 그린다', async () => {
  // 선택이 여러 번 바뀌는 구간을 만들어, 다섯째 구간까지 문구에 들어오는지 본다.
  const body = payload(23, 24);
  const [stage] = body.stages;
  const reachable = stage.segments.filter(segment => !segment.guaranteed)
    .filter((segment, index) => index === 0 || segment.reachProbability >= 0.05);
  const { get } = run(body);
  const form = get('honing-form');
  get('honing-kind').value = 'weapon';
  get('honing-from').value = '23';
  get('honing-to').value = '24';
  await form.fire('submit');
  const text = get('honing-result').text();
  assert.ok(reachable.length >= 2, `구간이 여러 개여야 의미 있는 검사다: ${reachable.length}`);
  for (const segment of reachable) {
    const label = segment.from === segment.to ? `${segment.from}회` : `${segment.from}-${segment.to}회`;
    assert.ok(text.includes(label), `${label} 구간이 화면에 있어야 한다`);
  }
  assert.equal(/더 있음|전체 보기/.test(text), false, '없는 전체 보기를 약속하지 않는다');
});

// 상세 표시(2026-09-23 「장비 강화」 탭): 응답에 있는 값만 그대로 그리고, 추정한 수치를 만들지 않는다.
test('단계마다 확률·시도·비용·보조 재료와 회차 계획을 응답 값 그대로 보여 준다', async () => {
  const body = payload(18, 20);
  const { get } = run(body);
  get('honing-kind').value = 'weapon';
  get('honing-from').value = '18';
  get('honing-to').value = '20';
  await get('honing-form').fire('submit');
  const result = get('honing-result');
  const text = result.text();
  const won = value => `${Math.round(value).toLocaleString('ko-KR')} G`;
  const items = result.all().filter(node => node.tagName === 'li');
  assert.equal(items.length, body.stages.length);
  body.stages.forEach((stage, index) => {
    const stageText = items[index].text();
    assert.ok(stageText.includes(`${stage.maximumAttempts.toLocaleString('ko-KR')}회 (확정 성공)`), `최대 시도: ${stageText.slice(0, 160)}`);
    assert.ok(stageText.includes(won(stage.plainGold)), '재료 없이 두드린 비용');
    assert.ok(stageText.includes(won(stage.plainGold - stage.expectedGold)), '아끼는 금액');
    const tries = stage.segments.filter(segment => !segment.guaranteed);
    assert.equal(stageText.includes(stage.breathName), tries.some(segment => segment.breath > 0), '숨결 이름은 실제로 넣을 때만');
    assert.equal(stageText.includes(stage.bookName), tries.some(segment => segment.book), '책 이름은 실제로 넣을 때만');
    const rows = items[index].all().filter(node => node.tagName === 'tr' && node.parentNode.tagName === 'tbody');
    assert.equal(rows.length, stage.segments.length, '회차 계획은 서버 구간을 빠짐없이 펼친다');
    const last = stage.segments.at(-1);
    if (last.guaranteed) assert.match(rows.at(-1).text(), /확정 성공/);
  });
  const total = body.stages.reduce((sum, stage) => sum + stage.maximumAttempts, 0);
  assert.ok(text.includes(`${total.toLocaleString('ko-KR')}회`), '전체 최대 시도는 단계 합');
});

// 새 상세 필드(details, 2026-09-23 계약 README.md)를 화면에 붙인다.
// 화면은 서버 값을 그대로 보여 주고 다시 계산하지 않는다 — 시험 자료는 계산과 무관한 눈에 띄는 값으로 만든다.
const material = (name, source, values = {}) => ({ name, source, unit: name === '골드' ? 'gold' : 'item', unitGold: 1,
  availability: 'known', perAttemptQuantity: source === 'base' ? 10 : source === 'growth' ? 0 : null, oneTimeQuantity: 0,
  firstAttemptQuantity: 10, expectedQuantity: 10, expectedGold: 10, worstCaseQuantity: 20, worstCaseGold: 20, ...values });
function detailed({ planDelivery = 'complete' } = {}) {
  const body = payload(18, 19);
  const [stage] = body.stages;
  const plan = [
    { attempt: 1, successBps: 600, artisanBeforeBps: 0, artisanAfterFailureBps: 280, reachProbability: 1, successProbability: 0.06,
      cumulativeSuccessProbability: 0.06, breathQuantity: 0, bookQuantity: 1, attemptGold: 10500, cumulativeGold: 14551.7, guaranteed: false },
    { attempt: 2, successBps: 10000, artisanBeforeBps: 10000, artisanAfterFailureBps: null, reachProbability: 0.94, successProbability: 0.94,
      cumulativeSuccessProbability: 1, breathQuantity: 0, bookQuantity: 0, attemptGold: 9602, cumulativeGold: 24153.7, guaranteed: true },
  ];
  stage.details = {
    materials: [
      material('운명의 파괴석', 'base', { unitGold: 1.69, expectedQuantity: 31289.99, expectedGold: 52880.09, worstCaseQuantity: 72900, worstCaseGold: 123201 }),
      material('운명의 파편', 'base', { expectedQuantity: 158767.7, expectedGold: 7567.9, worstCaseQuantity: 369900, worstCaseGold: 17631.9 }),
      material('골드', 'base', { expectedQuantity: 40677.2, expectedGold: 40677.2, worstCaseQuantity: 94770, worstCaseGold: 94770 }),
      material('운명의 파편', 'growth', { oneTimeQuantity: 85000, expectedQuantity: 85000, expectedGold: 4051.7, worstCaseQuantity: 85000, worstCaseGold: 4051.7 }),
      material('용암의 숨결', 'breath', { unitGold: 439, expectedQuantity: 0.11, expectedGold: 49.7, worstCaseQuantity: 1, worstCaseGold: 439 }),
      material('야금술 : 업화 [19-20]', 'book', { unitGold: 898, expectedQuantity: 11.37, expectedGold: 10209.7, worstCaseQuantity: 25, worstCaseGold: 22450 }),
    ],
    firstAttempt: { baseGold: 9602, breathGold: 0, bookGold: 898, growthGold: 4051.7, totalGold: 14551.7 },
    worstCase: { attempts: 27, gold: 286195.6, reachProbability: 0.106, terminal: 'artisan_guarantee' },
    percentiles: [{ probability: 0.5, attempts: 10, gold: 109052, cumulativeProbability: 0.534 }, { probability: 0.9, attempts: 26, gold: 275000, cumulativeProbability: 0.91 }],
    coverage: { growthShards: 'known', breath: 'available', book: 'available', excluded: ['silver', 'bound_inventory_offsets'] },
    plan: planDelivery === 'complete' ? plan : null,
  };
  body.details = { version: 1, model: {}, totals: { expectedGold: body.expectedGold, expectedAttempts: 11.6, worstCaseGold: 286195.6, maximumAttempts: 27 },
    prices: [
      { name: '운명의 파괴석', unit: 'item', unitGold: 1.69, source: 'market_bundle', sourceItemName: '운명의 파괴석', sourceBundleCount: 100, sourceBundleGold: 169, divisor: 100 },
      { name: '운명의 파편', unit: 'item', unitGold: 0.0476667, source: 'shard_bag', sourceItemName: '운명의 파편 주머니(대)', sourceBundleCount: 2, sourceBundleGold: 286, divisor: 6000 },
      { name: '골드', unit: 'gold', unitGold: 1, source: 'fixed_gold', sourceItemName: '골드', sourceBundleCount: null, sourceBundleGold: null, divisor: null },
      { name: '야금술 : 업화 [19-20]', unit: 'item', unitGold: null, source: 'market_bundle', sourceItemName: '야금술 : 업화 [19-20]', sourceBundleCount: null, sourceBundleGold: null, divisor: null },
    ],
    pricedAt: 0, priceTimeBasis: 'price_collection_completed', planDelivery, limits: { responseBytes: 1048576, attemptsPerStage: 400, stages: 25 } };
  return body;
}
async function show(body) {
  const { get } = run(body);
  get('honing-kind').value = 'weapon';
  get('honing-from').value = String(body.from);
  get('honing-to').value = String(body.to);
  await get('honing-form').fire('submit');
  return get('honing-result');
}
const rowsOf = (root, className) => root.all().filter(node => node.tagName === 'table' && node.className.includes(className))
  .flatMap(table => table.all().filter(node => node.tagName === 'tr' && node.parentNode.tagName === 'tbody'));

test('새 상세 필드가 있으면 구간 요약·재료·단계별 분위수·회차 계획·단가 출처를 서버 값 그대로 보여 준다', async () => {
  const result = await show(detailed());
  const text = result.text();
  assert.match(text, /최악 비용/);
  assert.ok(text.includes('286,196 G'), '최악 비용(표시 때만 반올림)');
  assert.ok(text.includes('14,552 G'), '첫 시도 비용');
  assert.match(text, /50% 확률로 10회 안에/);
  assert.match(text, /90% 확률로 26회 안에/);
  assert.match(text, /이 단계만/);
  const materials = rowsOf(result, 'honing-materials');
  const shardRows = materials.filter(row => row.text().includes('운명의 파편'));
  assert.ok(shardRows.some(row => /시도마다/.test(row.text())) && shardRows.some(row => /장비 성장/.test(row.text())), '시도 파편과 성장 파편을 따로 둔다');
  assert.ok(materials.some(row => row.text().includes('52,880 G') && row.text().includes('123,201 G')), '기대·최악 비용');
  assert.equal(rowsOf(result, 'honing-plan-table').length, 2, '회차별 계획은 서버 plan 행 그대로');
  assert.match(text, /운명의 파편 주머니\(대\) 2개\(파편 6,000개\) 286 G/);
  assert.equal(/전체 구간.*(50|90)%/.test(text), false, '구간 전체 분위수는 만들지 않는다');
});

test('details가 없는 예전 응답에서는 지금 화면을 그대로 그린다', async () => {
  const result = await show(payload(18, 19));
  const text = result.text();
  assert.equal(/최악 비용|50% 확률로|단가와 시세 출처/.test(text), false);
  assert.equal(rowsOf(result, 'honing-materials').length, 0);
  assert.ok(rowsOf(result, 'honing-plan-table').length > 0, '기존 구간 계획은 그대로');
});

test('회차 계획이 크기 한도로 생략되면 안내만 하고 요약·재료 표와 구간 계획은 그대로 둔다', async () => {
  const body = detailed({ planDelivery: 'omitted_size_limit' });
  const result = await show(body);
  const text = result.text();
  assert.match(text, /회차별 계획을 생략/);
  assert.ok(text.includes('286,196 G'));
  assert.ok(rowsOf(result, 'honing-materials').length > 0);
  assert.equal(rowsOf(result, 'honing-plan-table').length, body.stages[0].segments.length, '생략되면 기존 구간 표로 대신한다');
});

test('수량이 확인되지 않은 성장 파편은 「수량 미확인」, 시세가 없는 보조 재료는 「시세 없음」으로 적는다', async () => {
  const body = detailed();
  const rows = body.stages[0].details.materials;
  Object.assign(rows.find(row => row.source === 'growth'), { availability: 'quantity_unverified', oneTimeQuantity: null, firstAttemptQuantity: null,
    expectedQuantity: null, expectedGold: null, worstCaseQuantity: null, worstCaseGold: null });
  Object.assign(rows.find(row => row.source === 'book'), { availability: 'price_unavailable', unitGold: null, firstAttemptQuantity: 0,
    expectedQuantity: 0, expectedGold: 0, worstCaseQuantity: 0, worstCaseGold: 0 });
  const result = await show(body);
  const materials = rowsOf(result, 'honing-materials');
  const growth = materials.find(row => /장비 성장/.test(row.text()));
  const book = materials.find(row => row.text().includes('야금술'));
  assert.match(growth.text(), /수량 미확인/);
  assert.equal(/\b0 G\b|0개/.test(growth.text()), false, '미확인을 0으로 적지 않는다');
  assert.match(book.text(), /시세 없음/);
  assert.equal(/0 G/.test(book.text()), false, '시세 없는 재료를 무료처럼 적지 않는다');
});

// 상세가 일부만 온 응답(최상위 details 없음, 또는 한 단계만 없음)은 새 영역을 전혀 그리지 않고 모든 단계를 예전 구간 표로
// 그린다(2026-09-23 교차 검토 P2: 단계 펼침이 전체 판단을 따르지 않고 그 단계의 details만 봤다).
function twoStages() {
  const body = detailed();
  const second = payload(18, 20).stages[1];
  second.details = structuredClone(body.stages[0].details);
  body.to = 20;
  body.stages.push(second);
  return body;
}
for (const [label, strip] of [['최상위 details가 없으면', body => { delete body.details; }], ['한 단계만 details가 없으면', body => { delete body.stages[1].details; }]]) {
  test(`${label} 새 재료·회차 표 없이 모든 단계를 예전 구간 표로 그린다`, async () => {
    const body = twoStages();
    strip(body);
    const result = await show(body);
    assert.equal(rowsOf(result, 'honing-materials').length, 0);
    assert.equal(rowsOf(result, 'honing-attempts').length, 0);
    assert.equal(rowsOf(result, 'honing-plan-table').length, body.stages.reduce((sum, stage) => sum + stage.segments.length, 0));
  });
}

// 성공률 100%로 끝나는 단계도 있으므로(방어구 +0→+1) 「장인의 기운까지」 대신 「마지막 시도까지」라고 쓴다(교차 검토 P3).
test('요약은 최악 경로를 종료 방식과 상관없이 「마지막 시도까지」로 적는다', async () => {
  for (const body of [detailed(), payload(18, 19)]) {
    const text = (await show(body)).text();
    assert.equal(/장인의 기운까지/.test(text), false);
    assert.match(text, /모두 마지막 시도까지 가면/);
  }
  assert.match((await show(detailed())).text(), /최악 비용 \(모든 단계에서 마지막 시도까지 간 경우\)/);
});
