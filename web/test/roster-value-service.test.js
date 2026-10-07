import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRosterValueRecordStore } from '../src/roster-value-record-store.js';
import { createRosterValueService, projectRosterAggregate, parseRosterValueNames, parseRosterValueBody, VALUATION_VERSION } from '../src/roster-values.js';
import { snapshotValuationInputs, valuationFingerprint } from '../src/character-valuation.js';

const time = 1790000000000;
const key = name => Buffer.from(name).toString('hex').padEnd(64, '0').slice(0, 64);
const book = (accountKey = 'engraving:질풍', gold = 1000000) => ({ id: 'engraving-0', status: 'ok', accountKey,
  grade: '유물', level: 3, marketReplacementGold: gold, expectedAcquisitionGold: 0, knownGold: gold, checkedAt: time - 1000, name: '질풍 · 유물 Lv.3' });
function valuation(name, { market = 3000000, expected = 2000000, books = [book()], status = 'ok', complete = true } = {}) {
  const bookGold = books.filter(item => item.status === 'ok').reduce((sum, item) => sum + item.marketReplacementGold, 0);
  return { status, characterName: name, serverName: '루페온', targetKey: key(name), observedAt: time, checkedAt: time,
    components: { engravings: { id: 'engravings', status: 'ok', items: books, counts: { items: books.length, known: books.filter(item => item.status === 'ok').length, unknown: 0 } } },
    complete, knownGold: market + bookGold + expected, knownMarketReplacementGold: market + bookGold, knownExpectedAcquisitionGold: expected,
    counts: { items: 12, known: 12, unknown: 0 },
    excludingSharedBooks: { complete, knownMarketReplacementGold: market, knownExpectedAcquisitionGold: expected, knownGold: market + expected } };
}
const member = (characterName, itemLevel, serverName = '루페온') => ({ characterName, serverName, itemLevel });
function harness(t, { rosters, details = {}, calculate, now = () => time, options = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'roster-value-service-'));
  const store = createRosterValueRecordStore(join(directory, 'values.sqlite'), { now });
  const calls = { rosters: [], details: [], calculated: [], waits: [] };
  const service = createRosterValueService({ store, now, retryWaitMs: 60000,
    setTimer: (fn, ms) => { calls.waits.push(ms); return setTimeout(fn, 0); },
    readRoster: async name => {
      calls.rosters.push(name);
      const value = rosters[name];
      if (!value) throw Object.assign(new Error('missing'), { status: 502 });
      return { roster: { characterName: name, serverName: value.serverName ?? '루페온', characters: value.members }, updatedAt: now() };
    },
    readDetails: async name => {
      calls.details.push(name);
      const value = details[name];
      if (value === undefined) return { valuationTargets: { targetKey: key(name) }, updatedAt: time, efficiency: { score: { role: 'dealer' } } };
      if (value instanceof Error) throw value;
      return value;
    },
    calculate: async name => { calls.calculated.push(name); return calculate(name); },
    ...options });
  t.after(() => { service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { service, store, calls };
}
async function settle(service) {
  for (let i = 0; i < 20000 && service.status().running; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.status().running, false);
}

test('the name list keeps its order and refuses repeats, bad names and oversized lists', () => {
  assert.deepEqual(parseRosterValueNames('앞으로가나,합성캐릭터4'), ['앞으로가나', '합성캐릭터4']);
  assert.equal(parseRosterValueNames('앞으로가나,앞으로가나'), null);
  assert.equal(parseRosterValueNames('앞으로가나,'), null);
  assert.equal(parseRosterValueNames(''), null);
  assert.equal(parseRosterValueNames(Array.from({ length: 65 }, (_, i) => `채움${String(i).padStart(2, '0')}`).join(',')), null);
  assert.deepEqual(parseRosterValueBody(JSON.stringify({ names: ['앞으로가나'] })), ['앞으로가나']);
  for (const bad of ['{}', '[]', 'x', JSON.stringify({ names: [] }), JSON.stringify({ names: ['앞으로가나'], extra: 1 }), JSON.stringify({ names: [7] })])
    assert.equal(parseRosterValueBody(bad), null);
});

test('only 1720 and above characters are calculated and the stored projection keeps the engraving books', async t => {
  const { service, store, calls } = harness(t, {
    rosters: { 앞으로가나: { members: [member('앞으로가나', 1740), member('부캐하나', 1725), member('저렙부캐', 1700)] } },
    calculate: name => valuation(name),
  });
  assert.equal(service.refresh(['앞으로가나']).status, 'started');
  await settle(service);
  assert.deepEqual([...calls.calculated].sort(), ['부캐하나', '앞으로가나']);
  assert.equal(store.getCharacter('저렙부캐'), null);
  const stored = store.getCharacter('앞으로가나');
  assert.equal(stored.itemLevel, 1740); assert.equal(stored.role, 'dealer'); assert.equal(stored.status, 'ok');
  assert.equal(stored.knownGold, 6000000); assert.equal(stored.complete, true);
  assert.deepEqual(stored.aggregate.components.engravings.items, [{ status: 'ok', accountKey: 'engraving:질풍', grade: '유물',
    level: 3, marketReplacementGold: 1000000, checkedAt: time - 1000, reason: null }]);
  assert.deepEqual(stored.aggregate.excludingSharedBooks, { knownMarketReplacementGold: 3000000, knownExpectedAcquisitionGold: 2000000, complete: true });
  assert.deepEqual(store.getRoster('앞으로가나').members.map(row => row.characterName), ['앞으로가나', '부캐하나', '저렙부캐']);
  const run = service.status().run;
  assert.equal(run.calculated, 2); assert.equal(run.skipped, 0); assert.equal(run.failed, 0); assert.equal(run.remaining, 0);
  assert.equal(service.status().lastSuccessAt, time);
});

test('unchanged equipment is not recalculated and a shared character is handled once per run', async t => {
  const { service, store, calls } = harness(t, {
    rosters: { 앞으로가나: { members: [member('앞으로가나', 1740), member('같은캐릭', 1730)] },
      합성캐릭터4: { members: [member('합성캐릭터4', 1745), member('같은캐릭', 1730)] } },
    calculate: name => valuation(name),
  });
  service.refresh(['앞으로가나', '합성캐릭터4']);
  await settle(service);
  assert.deepEqual([...calls.calculated].sort(), ['같은캐릭', '합성캐릭터4', '앞으로가나'].sort());
  assert.equal(calls.calculated.filter(name => name === '같은캐릭').length, 1);
  const before = store.getCharacter('앞으로가나');
  calls.calculated.length = 0;
  service.refresh(['앞으로가나', '합성캐릭터4']);
  await settle(service);
  assert.deepEqual(calls.calculated, []);
  assert.equal(service.status().run.skipped, 3);
  assert.deepEqual(store.getCharacter('앞으로가나'), before);
});

test('a row written by an older valuation is recalculated even though nothing about the equipment moved', async t => {
  const { service, store, calls } = harness(t, {
    rosters: { 앞으로가나: { members: [member('앞으로가나', 1740)] } },
    calculate: name => valuation(name),
  });
  service.refresh(['앞으로가나']);
  await settle(service);
  assert.deepEqual(calls.calculated, ['앞으로가나']);
  const row = store.getCharacter('앞으로가나');
  assert.equal(row.aggregate.valuationVersion, VALUATION_VERSION);
  // A row stored before the version existed, with the same fingerprint, must not be skipped.
  const { valuationVersion, ...older } = row.aggregate;
  store.recordCharacter('앞으로가나', { serverName: row.serverName, itemLevel: row.itemLevel, role: row.role,
    targetKey: row.targetKey, equipmentUpdatedAt: row.equipmentUpdatedAt, status: row.status, knownGold: row.knownGold,
    knownMarketGold: row.knownMarketGold, knownExpectedGold: row.knownExpectedGold, complete: row.complete,
    unknownItems: row.unknownItems, aggregate: older, computedAt: row.computedAt });
  calls.calculated.length = 0;
  service.refresh(['앞으로가나']);
  await settle(service);
  assert.deepEqual(calls.calculated, ['앞으로가나']);
  assert.equal(service.status().run.skipped, 0);
  assert.equal(store.getCharacter('앞으로가나').aggregate.valuationVersion, VALUATION_VERSION);
});

test('replacement priced items are carried into the stored row and the read response', async t => {
  const { service } = harness(t, {
    rosters: { 앞으로가나: { members: [member('앞으로가나', 1740), member('정상캐릭', 1730)] } },
    calculate: name => ({ ...valuation(name), estimatedItems: name === '앞으로가나' ? 2 : 0 }),
  });
  service.refresh(['앞으로가나']);
  await settle(service);
  const [anchor] = service.read(['앞으로가나']).anchors;
  assert.equal(anchor.status, 'ok');
  assert.equal(anchor.aggregate.estimatedItems, 2);
  assert.equal(anchor.aggregate.counts.estimatedCharacters, 1);
  assert.equal(anchor.aggregate.counts.unknownCharacters, 0);
});

test('changed equipment, a failed calculation and a throttled one follow the retry wait', async t => {
  let fingerprint = key('앞으로가나'), attempts = 0;
  const { service, store, calls } = harness(t, {
    rosters: { 앞으로가나: { members: [member('앞으로가나', 1740), member('막힌캐릭', 1730), member('깨진캐릭', 1730)] } },
    details: { 앞으로가나: { valuationTargets: { get targetKey() { return fingerprint; } }, updatedAt: time, efficiency: { score: { role: 'support' } } } },
    calculate: name => {
      if (name === '막힌캐릭') { attempts++; if (attempts <= 2) throw Object.assign(new Error('limited'), { status: 429 }); return valuation(name); }
      if (name === '깨진캐릭') throw Object.assign(new Error('unavailable'), { status: 502 });
      return { ...valuation(name), targetKey: name === '앞으로가나' ? fingerprint : key(name) };
    },
  });
  service.refresh(['앞으로가나']);
  await settle(service);
  assert.equal(store.getCharacter('앞으로가나').role, 'support');
  // A throttled character waits once and gives up on the second refusal; an unavailable one is only counted.
  assert.deepEqual(calls.waits, [60000]);
  assert.equal(store.getCharacter('막힌캐릭'), null);
  assert.equal(store.getCharacter('깨진캐릭'), null);
  assert.equal(service.status().run.failed, 2);

  fingerprint = key('앞으로가나-장비변경');
  calls.calculated.length = 0;
  service.refresh(['앞으로가나']);
  await settle(service);
  assert.ok(calls.calculated.includes('앞으로가나'), 'moved equipment is recalculated');
  assert.equal(store.getCharacter('앞으로가나').targetKey,
    valuationFingerprint({ valuationTargets: { targetKey: fingerprint }, efficiency: { score: { role: 'support' } } }));
  assert.ok(store.getCharacter('막힌캐릭'), 'the third attempt finally stores the throttled character');
});

test('a bracelet or ark grid gem swap alone is recalculated inside the freshness window', async t => {
  // 전에는 건너뛰기 지문이 재련·보석·악세서리·각인서만 담아, 팔찌만 바꾸면 20시간 동안 옛 값이 남았다(교차 검토 C-P1-1).
  let clock = time;
  let bracelet = { name: '찬란한 팔찌', tier: 4, grade: '고대', stats: [{ text: '치명 +100' }], effects: [] };
  let expectation = { targetKey: key('팔찌-하나'), status: 'ok' };
  let gem = { name: '질서의 젬', slot: 0, points: 5, target: { targetKey: key('젬-하나') } };
  const detailsOf = () => ({ valuationTargets: { targetKey: key('앞으로가나') }, updatedAt: clock, bracelet,
    arkgrid: { cores: [{ name: '코어', slot: 0, gems: [gem] }] },
    efficiency: { braceletExpectation: expectation, score: { role: 'dealer' } } });
  const { service, calls } = harness(t, { now: () => clock,
    rosters: { 앞으로가나: { members: [member('앞으로가나', 1740)] } },
    details: { get 앞으로가나() { return detailsOf(); } },
    calculate: name => valuation(name) });
  service.refresh(['앞으로가나']);
  await settle(service);
  assert.deepEqual(calls.calculated, ['앞으로가나']);
  clock += 3600000;
  service.refresh(['앞으로가나']);
  await settle(service);
  assert.equal(calls.calculated.length, 1, 'the same equipment is still skipped although the fetch time moved');
  clock += 3600000;
  bracelet = { ...bracelet, stats: [{ text: '특화 +100' }] }; expectation = { targetKey: key('팔찌-둘'), status: 'ok' };
  service.refresh(['앞으로가나']);
  await settle(service);
  assert.equal(calls.calculated.length, 2, 'a new bracelet is valued again');
  clock += 3600000;
  gem = { ...gem, points: 6, target: { targetKey: key('젬-둘') } };
  service.refresh(['앞으로가나']);
  await settle(service);
  assert.equal(calls.calculated.length, 3, 'a new ark grid gem is valued again');
});

test('the valuation fingerprint covers everything the valuation reads and ignores fetch times', () => {
  const base = { valuationTargets: { targetKey: key('앞으로가나'), status: 'ok', observedAt: 1 }, updatedAt: 1,
    bracelet: { name: '팔찌', tier: 4, grade: '고대', stats: [{ text: '치명 +100', unread: 1 }], effects: null },
    arkgrid: { cores: [{ name: '코어', slot: 0, gems: [{ name: '젬', slot: 0, points: 5, target: { targetKey: key('젬') } }] }] },
    equipment: [{ Type: '무기' }], efficiency: { braceletExpectation: { targetKey: key('팔찌'), status: 'ok' }, score: { role: 'dealer' } } };
  const print = valuationFingerprint(base);
  assert.match(print, /^[a-f0-9]{64}$/);
  assert.equal(valuationFingerprint({ ...base, updatedAt: 2, valuationTargets: { ...base.valuationTargets, observedAt: 2 } }), print,
    'fetch times do not move it');
  assert.equal(valuationFingerprint(snapshotValuationInputs(base)), print, 'the saved snapshot has the same fingerprint');
  for (const moved of [
    { ...base, bracelet: { ...base.bracelet, stats: [{ text: '특화 +100' }] } },
    { ...base, efficiency: { ...base.efficiency, braceletExpectation: { targetKey: key('다른팔찌'), status: 'ok' } } },
    { ...base, arkgrid: { cores: [{ ...base.arkgrid.cores[0], gems: [{ ...base.arkgrid.cores[0].gems[0], points: 6 }] }] } },
    { ...base, valuationTargets: { ...base.valuationTargets, targetKey: key('다른장비') } },
    { ...base, efficiency: { ...base.efficiency, score: { role: 'support' } } },
  ]) assert.notEqual(valuationFingerprint(moved), print);
  assert.equal(valuationFingerprint(null), null);
  assert.equal(valuationFingerprint({ valuationTargets: { targetKey: 'short' } }), null);
});

test('a fresh row is skipped although the fetch time moved, and a stale row is recalculated', async t => {
  let clock = time;
  const { service, store, calls } = harness(t, {
    rosters: { 앞으로가나: { members: [member('앞으로가나', 1740)] } },
    details: { 앞으로가나: { valuationTargets: { targetKey: key('앞으로가나') }, get updatedAt() { return clock; }, efficiency: { score: { role: 'dealer' } } } },
    calculate: name => valuation(name),
    now: () => clock,
    options: { freshMs: 72000000 },
  });
  service.refresh(['앞으로가나']);
  await settle(service);
  assert.deepEqual(calls.calculated, ['앞으로가나']);
  const first = store.getCharacter('앞으로가나');
  assert.equal(first.computedAt, time);
  // Ten hours later the details are fetched again (new updatedAt) but the equipment fingerprint is the same.
  clock = time + 36000000;
  calls.calculated.length = 0;
  service.refresh(['앞으로가나']);
  await settle(service);
  assert.deepEqual(calls.calculated, []);
  assert.equal(service.status().run.skipped, 1);
  assert.equal(store.getCharacter('앞으로가나').computedAt, time);
  // Past the freshness window the same fingerprint is priced again.
  clock = time + 72000000;
  service.refresh(['앞으로가나']);
  await settle(service);
  assert.deepEqual(calls.calculated, ['앞으로가나']);
  assert.equal(service.status().run.skipped, 0);
  assert.equal(store.getCharacter('앞으로가나').computedAt, time + 72000000);
  assert.equal(store.getCharacter('앞으로가나').equipmentUpdatedAt, time + 72000000);
});

test('a throttled roster read waits once and continues, a second refusal counts the roster as failed', async t => {
  let refusals = { 앞으로가나: 1, 합성캐릭터4: 2 };
  const { service, store, calls } = harness(t, {
    rosters: { 앞으로가나: { members: [member('앞으로가나', 1740)] }, 합성캐릭터4: { members: [member('합성캐릭터4', 1745)] } },
    calculate: name => valuation(name),
    options: { readRoster: async name => {
      if (refusals[name] > 0) { refusals[name]--; throw Object.assign(new Error('limited'), { status: 429 }); }
      return { roster: { characterName: name, serverName: '루페온', characters: [member(name, 1740)] }, updatedAt: time };
    } },
  });
  service.refresh(['앞으로가나', '합성캐릭터4']);
  await settle(service);
  assert.deepEqual(calls.waits, [60000, 60000]);
  assert.deepEqual(calls.calculated, ['앞으로가나']);
  assert.ok(store.getRoster('앞으로가나'));
  assert.equal(store.getRoster('합성캐릭터4'), null);
  const run = service.status().run;
  assert.equal(run.rostersFailed, 1); assert.equal(run.anchorsDone, 2); assert.equal(run.failed, 0);
});

test('a run stops at its time budget and leaves the rest for the next one', async t => {
  let clock = time;
  const { service, store } = harness(t, {
    rosters: Object.fromEntries(['하나아', '두우울', '세에엣'].map(name => [name, { members: [member(name, 1740)] }])),
    calculate: name => { clock += 1000; return valuation(name); },
    now: () => clock,
    options: { runBudgetMs: 500 },
  });
  service.refresh(['하나아', '두우울', '세에엣']);
  await settle(service);
  const run = service.status().run;
  assert.equal(run.anchors, 3); assert.equal(run.calculated, 1); assert.equal(run.remaining, 2);
  assert.equal(service.status().lastSuccessAt, null, 'a truncated run is not a completed refresh');
  assert.equal(store.getCharacter('두우울'), null);
  assert.equal(service.status().queued, 2);
});

test('anchors past the run limit and a request during a run only wait in the queue', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, store, calls } = harness(t, {
    rosters: Object.fromEntries(['하나아', '두우울', '세에엣'].map(name => [name, { members: [member(name, 1740)] }])),
    calculate: async name => { if (name === '하나아') await gate; return valuation(name); },
    options: { maxAnchors: 1 },
  });
  assert.equal(service.refresh(['하나아', '두우울']).status, 'started');
  const busy = service.refresh(['세에엣']);
  assert.equal(busy.status, 'running');
  assert.equal(busy.queued, 2);
  release();
  await settle(service);
  assert.deepEqual(calls.calculated, ['하나아']);
  // A later request does not push the queue back — a guild larger than one run comes around instead of
  // waiting behind the same names every night.
  service.refresh(['하나아']);
  await settle(service);
  assert.ok(store.getCharacter('두우울'), 'the queued anchor runs before the newly requested one');
  service.refresh([]);
  await settle(service);
  assert.ok(store.getCharacter('세에엣'), 'queued anchors are drained by later runs');
});

test('a valuation without a usable subtotal is projected as an unknown character', () => {
  assert.deepEqual(projectRosterAggregate({ status: 'unavailable', characterName: '깨진캐릭', serverName: '루페온', components: {} }),
    { characterName: '깨진캐릭', serverName: '루페온', valuationVersion: VALUATION_VERSION });
  assert.deepEqual(projectRosterAggregate(null), { characterName: null, serverName: null, valuationVersion: VALUATION_VERSION });
  const partial = projectRosterAggregate(valuation('부분캐릭', { books: [{ id: 'engraving-0', status: 'unavailable', reason: 'book_price_unavailable' }] }));
  assert.deepEqual(partial.components.engravings.items, [{ status: 'unavailable', accountKey: null, grade: null, level: null,
    marketReplacementGold: null, checkedAt: null, reason: 'book_price_unavailable' }]);
});
