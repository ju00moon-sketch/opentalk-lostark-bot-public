import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRosterValueRecordStore } from '../src/roster-value-record-store.js';
import { createRosterRecordStore } from '../src/roster-record-store.js';
import { createRosterValueService } from '../src/roster-values.js';
import { valuationFingerprint } from '../src/character-valuation.js';

// 원정대 단위 최고 기록 (README.md): one moment's 1720↑ sum is kept and only a
// higher moment replaces it, while the equipment it froze is priced again every refresh run.
const time = 1790000000000;
const key = name => Buffer.from(name).toString('hex').padEnd(64, '0').slice(0, 64);
const book = (accountKey = 'engraving:질풍', gold = 1000000) => ({ id: 'engraving-0', status: 'ok', accountKey,
  grade: '유물', level: 3, marketReplacementGold: gold, expectedAcquisitionGold: 0, knownGold: gold, checkedAt: time - 1000 });
function valuation(name, { market = 3000000, expected = 2000000, targetKey = key(name), books = [book()] } = {}) {
  const bookGold = books.filter(item => item.status === 'ok').reduce((sum, item) => sum + item.marketReplacementGold, 0);
  return { status: 'ok', characterName: name, serverName: '루페온', targetKey, observedAt: time, checkedAt: time,
    equipmentUpdatedAt: time,
    components: { engravings: { id: 'engravings', status: 'ok', items: books, counts: { items: books.length, known: books.length, unknown: 0 } } },
    complete: true, knownGold: market + bookGold + expected, knownMarketReplacementGold: market + bookGold,
    knownExpectedAcquisitionGold: expected, counts: { items: 12, known: 12, unknown: 0 },
    excludingSharedBooks: { complete: true, knownMarketReplacementGold: market, knownExpectedAcquisitionGold: expected,
      knownGold: market + expected } };
}
const member = (characterName, itemLevel) => ({ characterName, serverName: '루페온', itemLevel });
// Rows and records are keyed by the fingerprint of everything the valuation reads, built from the harness details.
const printOf = targetKey => valuationFingerprint({ valuationTargets: { targetKey }, efficiency: { score: { role: 'dealer' } } });

// `worth` prices a piece of equipment, not a character: a replay of a saved snapshot has to answer what that
// equipment is worth today, which is exactly what separates a record from the character's current value.
function harness(t, { rosters = {}, worth = {}, fingerprints = {}, now = () => time, valueFrom, options = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'roster-record-service-'));
  const store = createRosterValueRecordStore(join(directory, 'values.sqlite'), { now });
  const recordStore = createRosterRecordStore(join(directory, 'records.sqlite'), { now });
  const calls = { calculated: [], repriced: [] };
  const targetOf = name => fingerprints[name] ?? key(name);
  const valueOf = (name, targetKey) => valuation(name, { market: worth[targetKey] ?? 3000000, targetKey });
  const service = createRosterValueService({ store, recordStore, now, retryWaitMs: 60000,
    setTimer: (fn) => setTimeout(fn, 0),
    readRoster: async name => {
      const value = rosters[name];
      if (!value) throw Object.assign(new Error('missing'), { status: 502 });
      return { roster: { characterName: name, serverName: '루페온', characters: value }, updatedAt: now() };
    },
    readDetails: async name => ({ valuationTargets: { version: 'roster-targets-v1', characterName: name, serverName: '루페온',
      targetKey: targetOf(name), components: {}, quotes: [] }, updatedAt: now(), efficiency: { score: { role: 'dealer' } } }),
    calculate: async name => { calls.calculated.push(name); return valueOf(name, targetOf(name)); },
    valueFrom: valueFrom ?? (async (name, inputs) => { const targetKey = inputs?.valuationTargets?.targetKey;
      calls.repriced.push({ name, targetKey }); return valueOf(name, targetKey); }),
    ...options });
  t.after(() => { service.close(); store.close(); recordStore.close(); rmSync(directory, { recursive: true, force: true }); });
  return { service, store, recordStore, calls };
}
async function settle(service) {
  for (let i = 0; i < 20000 && service.status().running; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.status().running, false);
}

test('a refresh run records the roster sum and only a higher moment replaces it', async t => {
  let clock = time;
  const worth = { [key('앞으로가나')]: 3000000, [key('부캐하나')]: 1000000 };
  const fingerprints = {};
  const { service, recordStore, calls } = harness(t, { now: () => clock, worth, fingerprints,
    rosters: { 앞으로가나: [member('앞으로가나', 1740), member('부캐하나', 1730), member('저렙부캐', 1700)] } });
  service.refresh(['앞으로가나']);
  await settle(service);
  const first = recordStore.getRecord('앞으로가나');
  // 3,000,000 + 1,000,000 market + 2 × 2,000,000 expected + one shared engraving book.
  assert.equal(first.recordGold, 9000000);
  assert.equal(first.recordedAt, time);
  assert.equal(first.repricedGold, null);
  assert.deepEqual(first.members.map(row => row.characterName), ['앞으로가나', '부캐하나']);
  assert.deepEqual([...recordStore.getInputs('앞으로가나').keys()].sort(), ['부캐하나', '앞으로가나']);
  assert.equal(service.status().run.recorded, 1);

  // The bank run: the gems left a character, so today's roster is worth less. The record does not move.
  clock = time + 90000000;
  fingerprints.부캐하나 = key('부캐하나-보석뺌'); worth[fingerprints.부캐하나] = 10000;
  calls.calculated.length = 0;
  service.refresh(['앞으로가나']);
  await settle(service);
  assert.ok(calls.calculated.includes('부캐하나'), 'moved equipment is recalculated');
  assert.equal(recordStore.getRecord('앞으로가나').recordGold, 9000000);
  assert.equal(recordStore.getRecord('앞으로가나').recordedAt, time);
  assert.equal(service.status().run.recorded, 0);

  // Putting them back on a stronger character beats the record, and the new moment replaces it whole.
  clock = time + 180000000;
  fingerprints.부캐하나 = key('부캐하나-보석다시'); worth[fingerprints.부캐하나] = 5000000;
  service.refresh(['앞으로가나']);
  await settle(service);
  const raised = recordStore.getRecord('앞으로가나');
  assert.equal(raised.recordGold, 13000000);
  assert.equal(raised.recordedAt, clock);
  assert.equal(raised.repricedGold, null, 'a fresh record starts without a re-priced number');
  assert.equal(raised.members.find(row => row.characterName === '부캐하나').targetKey, printOf(key('부캐하나-보석다시')));
  assert.equal(service.status().run.recorded, 1);
});

test('re-pricing reuses a row priced today and replays a snapshot only for equipment that moved', async t => {
  let clock = time;
  const worth = { [key('앞으로가나')]: 3000000, [key('부캐하나')]: 1000000 };
  const fingerprints = {};
  const { service, recordStore, calls } = harness(t, { now: () => clock, worth, fingerprints,
    rosters: { 앞으로가나: [member('앞으로가나', 1740), member('부캐하나', 1730)] } });
  service.refresh(['앞으로가나']);
  await settle(service);
  assert.equal(recordStore.getRecord('앞으로가나').recordGold, 9000000);

  // Nothing moved: every member already has a row priced inside the freshness window, so no snapshot is replayed.
  clock = time + 3600000;
  service.refresh(['앞으로가나']);
  await settle(service);
  assert.deepEqual(calls.repriced, []);
  assert.equal(recordStore.getRecord('앞으로가나').repricedGold, 9000000);
  assert.equal(recordStore.getRecord('앞으로가나').repricedAt, clock);
  assert.equal(service.status().run.repriced, 1);

  // One character changed its equipment, so only that one is priced again from what the record saved.
  clock = time + 180000000;
  fingerprints.부캐하나 = key('부캐하나-장비변경'); worth[fingerprints.부캐하나] = 10000;
  service.refresh(['앞으로가나']);
  await settle(service);
  assert.deepEqual(calls.repriced, [{ name: '부캐하나', targetKey: key('부캐하나') }]);
  assert.equal(recordStore.getRecord('앞으로가나').repricedGold, 9000000, 'the record is still the recorded equipment');
  assert.equal(recordStore.getRecord('앞으로가나').recordGold, 9000000);
});

test('a re-pricing that cannot finish keeps the last number instead of lowering the record', async t => {
  let clock = time, refuse = false;
  const worth = { [key('앞으로가나')]: 3000000, [key('부캐하나')]: 1000000 };
  const fingerprints = {};
  const { service, recordStore } = harness(t, { now: () => clock, worth, fingerprints,
    rosters: { 앞으로가나: [member('앞으로가나', 1740), member('부캐하나', 1730)] },
    valueFrom: async name => { if (refuse) throw Object.assign(new Error('limited'), { status: 429 }); return valuation(name); } });
  service.refresh(['앞으로가나']);
  await settle(service);
  clock = time + 3600000;
  service.refresh(['앞으로가나']);
  await settle(service);
  assert.equal(recordStore.getRecord('앞으로가나').repricedGold, 9000000);

  clock = time + 180000000;
  refuse = true; fingerprints.부캐하나 = key('부캐하나-장비변경'); worth[fingerprints.부캐하나] = 10000;
  service.refresh(['앞으로가나']);
  await settle(service);
  const kept = recordStore.getRecord('앞으로가나');
  assert.equal(kept.repricedGold, 9000000, 'a refused replay leaves the previous number in place');
  assert.equal(kept.repricedAt, time + 3600000);
  assert.equal(service.status().run.repriced, 0);
});

test('a re-pricing that comes back with prices missing leaves a complete record and its snapshot alone', async t => {
  // 전에는 예외 없이 partial로 돌아온 재가격도 성공으로 쳐서, 낮아진 합이 기준이 되고 더 낮은 지금 장비가 원래 기록과
  // 그 입력 사본을 영영 밀어냈다(교차 검토 C-P1-2).
  let clock = time, missingPrices = false;
  const worth = { [key('앞으로가나')]: 3000000, [key('부캐하나')]: 1000000 };
  const fingerprints = {};
  const partial = (name, targetKey) => {
    const value = valuation(name, { market: 100, expected: 0, targetKey });
    return { ...value, status: 'partial', complete: false, excludingSharedBooks: { ...value.excludingSharedBooks, complete: false } };
  };
  const { service, recordStore } = harness(t, { now: () => clock, worth, fingerprints,
    rosters: { 앞으로가나: [member('앞으로가나', 1740), member('부캐하나', 1730)] },
    valueFrom: async (name, inputs) => {
      const targetKey = inputs?.valuationTargets?.targetKey;
      return missingPrices && name === '부캐하나' ? partial(name, targetKey) : valuation(name, { market: worth[targetKey] ?? 3000000, targetKey });
    } });
  service.refresh(['앞으로가나']);
  await settle(service);
  assert.equal(recordStore.getRecord('앞으로가나').recordGold, 9000000);

  // 장비를 바꿔 지금 값은 8,010,000으로 내려갔고, 기록 장비의 재가격은 한 항목 시세를 못 받아 partial이다.
  clock = time + 180000000;
  missingPrices = true; fingerprints.부캐하나 = key('부캐하나-장비변경'); worth[fingerprints.부캐하나] = 10000;
  service.refresh(['앞으로가나']);
  await settle(service);
  const kept = recordStore.getRecord('앞으로가나');
  assert.equal(kept.recordGold, 9000000, '기록이 교체되지 않는다');
  assert.equal(kept.recordedAt, time);
  assert.equal(kept.repricedGold, null, 'partial 재가격은 기준으로 쓰지 않는다');
  assert.equal(service.status().run.repriced, 0);
  assert.equal(service.status().run.recorded, 0);
  assert.equal(recordStore.getInputs('앞으로가나').get('부캐하나').targetKey, printOf(key('부캐하나')), '기록 장비의 사본이 남는다');

  // 시세가 돌아오면 남아 있던 사본으로 원래 장비를 다시 매긴다.
  clock = time + 360000000;
  missingPrices = false;
  service.refresh(['앞으로가나']);
  await settle(service);
  assert.equal(recordStore.getRecord('앞으로가나').repricedGold, 9000000);
  assert.equal(recordStore.getRecord('앞으로가나').recordGold, 9000000);
});

test('a re-pricing that loses a price a partial member had leaves the record alone', async t => {
  // 기록 때부터 partial이던 구성원도, 그때 값을 알던 품목의 시세가 빠진 재가격은 받지 않는다. 알려진 합이 줄어 기준이
  // 내려가면 더 낮은 지금 장비가 원래 기록과 그 입력 사본을 밀어낸다(교차 검토 C-R1).
  let clock = time, gemPriced = true;
  const worth = { [key('앞으로가나')]: 3000000, [key('부캐하나')]: 1000000 };
  const fingerprints = {};
  // 부캐하나의 기록 장비: gem-1은 500,000에 매겨지고 gem-2는 처음부터 시세가 없다.
  const gemmed = (name, targetKey, known) => {
    const value = valuation(name, { market: worth[targetKey] ?? 3000000, targetKey }), gem = known ? 500000 : 0;
    const items = [known ? { id: 'gem-1', status: 'ok', marketReplacementGold: gem, expectedAcquisitionGold: 0, knownGold: gem, checkedAt: time }
      : { id: 'gem-1', status: 'unavailable', reason: 'price_unavailable' }, { id: 'gem-2', status: 'unavailable', reason: 'price_unavailable' }];
    return { ...value, status: 'partial', complete: false, knownGold: value.knownGold + gem,
      components: { ...value.components, gems: { id: 'gems', status: known ? 'partial' : 'unavailable', items } },
      excludingSharedBooks: { ...value.excludingSharedBooks, complete: false,
        knownMarketReplacementGold: value.excludingSharedBooks.knownMarketReplacementGold + gem } };
  };
  const priced = (name, targetKey) => name === '부캐하나' && targetKey === key('부캐하나') ? gemmed(name, targetKey, gemPriced)
    : valuation(name, { market: worth[targetKey] ?? 3000000, targetKey });
  const { service, recordStore } = harness(t, { now: () => clock, worth, fingerprints,
    rosters: { 앞으로가나: [member('앞으로가나', 1740), member('부캐하나', 1730)] },
    valueFrom: async (name, inputs) => priced(name, inputs?.valuationTargets?.targetKey),
    options: { calculate: async name => priced(name, fingerprints[name] ?? key(name)) } });
  service.refresh(['앞으로가나']);
  await settle(service);
  const first = recordStore.getRecord('앞으로가나');
  // 3,000,000 + 1,500,000 market + 2 × 2,000,000 expected + one shared engraving book.
  assert.equal(first.recordGold, 9500000);
  assert.deepEqual(first.members.find(row => row.characterName === '부캐하나').unpriced, ['gems:gem-2']);

  // 부캐하나가 보석 없는 장비로 바꿔 지금 합은 9,300,000이다. 기록 장비를 다시 매기다 gem-1 시세까지 빠지면 알려진
  // 합이 9,000,000으로 내려가고, 전에는 그 값이 기준이 되어 9,300,000이 기록을 밀어냈다.
  clock = time + 180000000;
  gemPriced = false; fingerprints.부캐하나 = key('부캐하나-보석뺌'); worth[fingerprints.부캐하나] = 1300000;
  service.refresh(['앞으로가나']);
  await settle(service);
  const kept = recordStore.getRecord('앞으로가나');
  assert.equal(kept.recordGold, 9500000, '기록이 교체되지 않는다');
  assert.equal(kept.recordedAt, time);
  assert.equal(kept.repricedGold, null);
  assert.equal(service.status().run.repriced, 0);
  assert.equal(service.status().run.recorded, 0);

  // 기록 때부터 모르던 gem-2만 빠진 재가격은 받는다. 다른 구성원의 시세가 오른 것은 정상적인 재가격이다.
  clock = time + 360000000;
  gemPriced = true; worth[key('앞으로가나')] = 3100000;
  service.refresh(['앞으로가나']);
  await settle(service);
  assert.equal(recordStore.getRecord('앞으로가나').repricedGold, 9600000);
  assert.equal(service.status().run.repriced, 1);
  assert.equal(service.status().run.recorded, 0);
});

test('a roster opened on the website records once its last 1720 member is stored', async t => {
  const { service, recordStore } = harness(t, { rosters: {} });
  const roster = { characterName: '앞으로가나', serverName: '루페온',
    characters: [member('앞으로가나', 1740), member('부캐하나', 1730), member('저렙부캐', 1700)] };
  service.absorbRoster(roster);
  const inputs = name => ({ version: 'roster-value-inputs-v1', updatedAt: time,
    valuationTargets: { targetKey: key(name) } });
  await service.absorb(roster.characters[0], valuation('앞으로가나'), inputs('앞으로가나'));
  assert.equal(recordStore.getRecord('앞으로가나'), null, 'a half-finished roster cannot set a record');
  await service.absorb(roster.characters[1], valuation('부캐하나'), inputs('부캐하나'));
  const stored = recordStore.getRecord('앞으로가나');
  assert.equal(stored.recordGold, 11000000);
  assert.deepEqual(stored.members.map(row => row.characterName), ['앞으로가나', '부캐하나']);
  // A character below the raid line is stored but never part of the record.
  await service.absorb(roster.characters[2], valuation('저렙부캐'), inputs('저렙부캐'));
  assert.deepEqual(recordStore.getRecord('앞으로가나').members.map(row => row.characterName), ['앞으로가나', '부캐하나']);
  // A character valued without its roster — the single character page — is not a record of anything.
  await service.absorb(member('혼자캐릭', 1740), valuation('혼자캐릭'), inputs('혼자캐릭'));
  assert.equal(recordStore.getRecord('혼자캐릭'), null);
});

test('the read response carries the record beside the current value, and says so when there is none', async t => {
  let clock = time;
  const { service, recordStore } = harness(t, { now: () => clock,
    worth: { [key('앞으로가나')]: 3000000, [key('부캐하나')]: 1000000 },
    rosters: { 앞으로가나: [member('앞으로가나', 1740), member('부캐하나', 1730), member('저렙부캐', 1700)] } });
  const before = service.read(['앞으로가나']).anchors[0];
  assert.deepEqual(before.record, { status: 'missing', knownGold: null, recordedAt: null, repricedAt: null,
    counts: { characters: 0, knownCharacters: 0, dealers: 0, supports: 0 }, members: [] });
  service.refresh(['앞으로가나']);
  await settle(service);
  clock = time + 3600000;
  service.refresh(['앞으로가나']);
  await settle(service);
  const [anchor] = service.read(['앞으로가나']).anchors;
  assert.deepEqual(anchor.record, { status: 'ok', knownGold: 9000000, recordedAt: time, repricedAt: time + 3600000,
    counts: { characters: 2, knownCharacters: 2, dealers: 2, supports: 0 },
    members: [{ characterName: '앞으로가나', itemLevel: 1740, role: 'dealer' },
      { characterName: '부캐하나', itemLevel: 1730, role: 'dealer' }] });
  assert.equal(anchor.aggregate.knownGold, 9000000, 'the current value is still reported beside the record');
  // A record survives a character leaving the roster, and is reported even when the roster row itself is gone.
  assert.equal(recordStore.getRecord('앞으로가나').members.length, 2);
  assert.equal(service.read(['없는앵커']).anchors[0].record.status, 'missing');
});
