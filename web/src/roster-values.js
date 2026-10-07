import { aggregateRosterValuations } from '../../src/roster-valuation.js';
import { normalizeCharacter } from './character-profile.js';
import { snapshotValuationInputs, valuationFingerprint } from './character-valuation.js';

// The bot's loopback-only view of the stored 원정대 환산 가치 (README.md).
// `/체급` must answer in seconds, but a full roster valuation takes tens of minutes, so the website keeps the
// numbers it already computes and the bot only ever reads them. The refresh job below is what fills that store.
export const BOT_ROSTER_VALUES_PATH = '/internal/bot/roster-values';
export const BOT_ROSTER_VALUES_REFRESH_PATH = '/internal/bot/roster-values/refresh';
export const RAID_LEVEL = 1720;
// Bumped whenever a fix changes what a finished valuation is worth, so the next run recalculates every stored row
// even when the equipment fingerprint did not move. A row written before this existed counts as version 1.
export const VALUATION_VERSION = 3;
export const NAME_LIMIT = 64;
const ROLES = ['dealer', 'support'];
const STATUSES = ['ok', 'partial', 'unavailable'];
const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const keyOf = name => name.toLowerCase();
const counted = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 10000) : 0;
const storedVersion = row => Number.isSafeInteger(row?.aggregate?.valuationVersion) ? row.aggregate.valuationVersion : 1;
const UNKNOWN_KEY_LIMIT = 256;

// The prices one valuation went without: `component:item` for an item, `component:*` for a component short of a
// price it does not list, `*` for a valuation that priced nothing. Sorted and unique, so a record can later tell
// whether a replay lost a price it once had (2026-09-23 교차 검토 C-R1). null when the list cannot be told or
// would be too long to keep; a record member holding null accepts only a complete replay.
export function valuationUnknownKeys(value) {
  if (value?.status === 'ok' && value.complete === true) return [];
  const components = value?.components;
  if (!components || typeof components !== 'object' || Array.isArray(components)) return null;
  if (value.status === 'unavailable') return ['*'];
  const keys = new Set();
  for (const [id, component] of Object.entries(components)) {
    const items = Array.isArray(component?.items) ? component.items : null;
    const missing = items ? items.filter(item => item?.status !== 'ok') : [];
    for (const item of missing) keys.add(typeof item?.id === 'string' ? `${id}:${item.id}` : `${id}:*`);
    if (!items || (!['ok', 'empty'].includes(component?.status) && !missing.length)) keys.add(`${id}:*`);
  }
  return keys.size && keys.size <= UNKNOWN_KEY_LIMIT ? [...keys].sort() : null;
}
// The same list for a stored row: a complete row missed nothing, a row that knew nothing missed everything, and a
// partial row carries the list its valuation had (null for a row stored before the list was kept).
function storedUnknownKeys(stored) {
  if (stored?.status === 'ok') return [];
  if (stored?.status === 'unavailable') return ['*'];
  const keys = stored?.aggregate?.unknownKeys;
  return Array.isArray(keys) && keys.length <= UNKNOWN_KEY_LIMIT && keys.every(key => typeof key === 'string') ? keys : null;
}

// "a,b,c" → normalized names without repeats; null when a name is invalid, repeated or the list is too long.
export function parseRosterValueNames(value) {
  if (typeof value !== 'string' || !value) return null;
  const parts = value.split(',');
  if (!parts.length || parts.length > NAME_LIMIT) return null;
  const names = [], seen = new Set();
  for (const part of parts) {
    const name = normalizeCharacter(part);
    if (!name || seen.has(keyOf(name))) return null;
    seen.add(keyOf(name));
    names.push(name);
  }
  return names;
}

// The same list carried in the refresh request body: { names: [...] }.
export function parseRosterValueBody(body) {
  let value;
  try { value = JSON.parse(body); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Array.isArray(value.names)) return null;
  if (!value.names.length || value.names.length > NAME_LIMIT || value.names.some(name => typeof name !== 'string')) return null;
  return parseRosterValueNames(value.names.join(','));
}

// Only what aggregateRosterValuations reads: the engraving books this character wears and its own subtotal
// without them. Everything else in a valuation is display detail the bot never shows.
export function projectRosterAggregate(value) {
  const base = { characterName: value?.characterName ?? null, serverName: value?.serverName ?? null, valuationVersion: VALUATION_VERSION };
  const own = value?.excludingSharedBooks;
  if (typeof base.characterName !== 'string' || typeof base.serverName !== 'string' ||
    !own || typeof own !== 'object' || !money(own.knownMarketReplacementGold) || !money(own.knownExpectedAcquisitionGold)) return base;
  const books = value?.components?.engravings;
  const source = Array.isArray(books?.items) ? books.items.slice(0, 64) : [];
  const items = source.map(item => ({
    status: item?.status === 'ok' ? 'ok' : 'unavailable',
    accountKey: typeof item?.accountKey === 'string' ? item.accountKey.slice(0, 120) : null,
    grade: typeof item?.grade === 'string' ? item.grade.slice(0, 10) : null,
    level: Number.isInteger(item?.level) ? item.level : null,
    marketReplacementGold: money(item?.marketReplacementGold) ? item.marketReplacementGold : null,
    checkedAt: Number.isSafeInteger(item?.checkedAt) ? item.checkedAt : null,
    reason: typeof item?.reason === 'string' ? item.reason.slice(0, 80) : null,
  }));
  const counts = books?.counts, unknown = Number.isSafeInteger(counts?.unknown) ? counts.unknown : items.length;
  return { ...base, estimatedItems: counted(value?.estimatedItems),
    components: { engravings: { items, counts: { items: items.length, known: items.filter(item => item.status === 'ok').length, unknown } } },
    excludingSharedBooks: { knownMarketReplacementGold: own.knownMarketReplacementGold,
      knownExpectedAcquisitionGold: own.knownExpectedAcquisitionGold, complete: own.complete === true },
    unknownKeys: valuationUnknownKeys(value) };
}

// One finished character valuation → the row the store keeps. The row is keyed by the full-input fingerprint the
// caller passes (valuationFingerprint), not by the valuation's own targetKey, which leaves out the bracelet and gems.
export function projectRosterValueRow(member, value, { role, targetKey, equipmentUpdatedAt, computedAt }) {
  const serverName = typeof value?.serverName === 'string' ? value.serverName : member.serverName;
  return { serverName, itemLevel: member.itemLevel, role: ROLES.includes(role) ? role : null,
    targetKey: typeof targetKey === 'string' ? targetKey : value?.targetKey, equipmentUpdatedAt,
    status: STATUSES.includes(value?.status) ? value.status : 'unavailable',
    knownGold: money(value?.knownGold) ? value.knownGold : 0,
    knownMarketGold: money(value?.knownMarketReplacementGold) ? value.knownMarketReplacementGold : 0,
    knownExpectedGold: money(value?.knownExpectedAcquisitionGold) ? value.knownExpectedAcquisitionGold : 0,
    complete: value?.complete === true,
    unknownItems: Number.isSafeInteger(value?.counts?.unknown) ? Math.min(value.counts.unknown, 10000) : 0,
    aggregate: projectRosterAggregate(value), computedAt };
}

export function createRosterValueService({ store, readRoster, readDetails, calculate, now = Date.now,
  raidLevel = RAID_LEVEL, concurrency = 4, maxAnchors = NAME_LIMIT, queueLimit = 256, retries = 1,
  retryWaitMs = 60000, runBudgetMs = 7200000, rosterMaxAgeMs = 129600000, freshMs = 72000000, setTimer = setTimeout,
  // 원정대 최고 기록: the sidecar store and the replay of a saved snapshot at today's prices.
  recordStore = null, valueFrom = null, recordConcurrency = 2, inputsCacheSize = 256, rosterCacheSize = 32 } = {}) {
  const queue = new Map();
  const readAttempts = new Map(), refreshAttempts = new Map();
  // Snapshots live in memory only between reading a character's equipment and deciding whether its roster set a
  // record; they are written to the store only when a record is replaced. The caps keep a long run bounded —
  // a member whose snapshot has been evicted simply leaves that anchor's record where it is.
  const inputsCache = new Map(), pageRosters = new Map();
  let running = null, current = null, last = null, lastSuccessAt = null, closed = false;

  function allow(attempts, ip, limit) {
    if (closed) return false;
    const time = now();
    for (const [key, row] of attempts) if (row.until <= time) attempts.delete(key);
    let row = attempts.get(ip);
    if (!row) { if (attempts.size >= 10000) return false; row = { until: time + 60000, count: 0 }; attempts.set(ip, row); }
    return ++row.count <= limit;
  }
  const sleep = ms => new Promise(resolve => { const timer = setTimer(resolve, ms); timer?.unref?.(); });
  async function mapBounded(items, callback, width = concurrency) {
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
      while (index < items.length && !closed) { const at = index++; await callback(items[at], at); }
    }));
  }
  function enqueue(name) {
    const normalized = normalizeCharacter(name);
    if (!normalized || queue.has(keyOf(normalized)) || queue.size >= queueLimit) return;
    queue.set(keyOf(normalized), normalized);
  }

  // A character is recalculated when anything the valuation reads moved (valuationFingerprint: the four target
  // lists plus the bracelet, its expectation and the ark grid gems), the last attempt fell short, the valuation
  // changed or the stored value is older than the freshness window (prices move daily). `details.updatedAt` is
  // the fetch time, not an equipment timestamp, so it is recorded but never compared.
  async function updateCharacter(member, state) {
    for (let attempt = 0; ; attempt++) {
      try {
        const details = await readDetails(member.characterName);
        const targetKey = valuationFingerprint(details);
        const equipmentUpdatedAt = Number.isSafeInteger(details?.updatedAt) ? details.updatedAt : null;
        const role = details?.efficiency?.score?.role;
        if (!targetKey || equipmentUpdatedAt === null) { state.failed++; return null; }
        let stored = null;
        try { stored = store.getCharacter(member.characterName); } catch { stored = null; }
        if (stored && stored.status === 'ok' && stored.targetKey === targetKey && storedVersion(stored) >= VALUATION_VERSION
          && Number.isSafeInteger(stored.computedAt) && now() - stored.computedAt < freshMs) {
          try { store.touch(member.characterName); } catch { state.storageFailed = true; }
          // A skipped character still read its equipment, so it can still take part in a record.
          state.skipped++; return details;
        }
        const value = await calculate(member.characterName);
        if (closed) { state.failed++; return null; }
        // The fingerprint came from the equipment read just above; a valuation of other equipment (it changed in
        // between) must not be stored under it. The next run reads and values the new equipment.
        if (typeof value?.targetKey === 'string' && value.targetKey !== details.valuationTargets.targetKey) { state.failed++; return null; }
        try { store.recordCharacter(member.characterName, projectRosterValueRow(member, value, { role, targetKey, equipmentUpdatedAt, computedAt: now() })); }
        catch { state.storageFailed = true; state.failed++; return null; }
        state.calculated++; return details;
      } catch (error) {
        if (error?.status === 429 && attempt < retries && !closed) { await sleep(retryWaitMs); continue; }
        state.failed++; return null;
      }
    }
  }

  // 원정대 최고 기록 (README.md). A record is one moment's 1720↑ roster sum,
  // replaced only by a higher one, so a gem counts once per moment and moving it to the bank cannot lower it.
  // Prices are handled separately: the equipment of the recorded moment is kept and priced again every day.
  const emptyRecord = () => ({ status: 'missing', knownGold: null, recordedAt: null, repricedAt: null,
    counts: { characters: 0, knownCharacters: 0, dealers: 0, supports: 0 }, members: [] });
  function rememberInputs(characterName, targetKey, inputs) {
    if (!recordStore || !inputs || typeof targetKey !== 'string') return;
    const id = keyOf(characterName);
    inputsCache.delete(id);
    inputsCache.set(id, { characterName, targetKey, inputs });
    while (inputsCache.size > inputsCacheSize) inputsCache.delete(inputsCache.keys().next().value);
  }
  // The record this roster would set right now, or null when a 1720↑ member has no stored row or no snapshot —
  // an incomplete moment is never recorded, and the existing record stays where it is.
  function recordCandidate(anchor) {
    const raid = (anchor.members || []).filter(row => typeof row?.characterName === 'string' &&
      typeof row.itemLevel === 'number' && row.itemLevel >= raidLevel);
    if (!raid.length || raid.length > 100) return null;
    const members = [], inputs = [], aggregates = [];
    for (const row of raid) {
      let stored = null;
      try { stored = store.getCharacter(row.characterName); } catch { return null; }
      const snapshot = inputsCache.get(keyOf(row.characterName));
      if (!stored || !snapshot || snapshot.targetKey !== stored.targetKey) return null;
      members.push({ characterName: row.characterName, serverName: stored.serverName, itemLevel: row.itemLevel,
        role: stored.role, targetKey: stored.targetKey, status: stored.status, knownGold: stored.knownGold,
        unpriced: storedUnknownKeys(stored) });
      inputs.push({ characterName: row.characterName, targetKey: stored.targetKey, inputs: snapshot.inputs });
      aggregates.push(stored.aggregate);
    }
    const result = aggregateRosterValuations(aggregates);
    if (!money(result?.knownGold)) return null;
    return { serverName: anchor.serverName, members, inputs, knownGold: result.knownGold };
  }
  // Today's price for the equipment the record froze. A member whose stored row was priced today for the same
  // equipment is reused as is; anything else is replayed from its saved snapshot. One refusal leaves the whole
  // record alone — a partial re-pricing would understate it. A valuation that comes back without throwing but
  // short of a price the record had is a refusal too: otherwise its lower known sum becomes the bar, a smaller
  // roster beats it and the original record and its snapshot are replaced for good (2026-09-23 교차 검토
  // C-P1-2·C-R1). A complete valuation always prices what the record did; a member complete at the recorded
  // moment must be complete again; a partial member may miss only what it already missed then. A record kept
  // before the missing list existed (`unpriced` absent) accepts only complete valuations of its partial members.
  function pricesAsRecorded(member, status, unknownKeys) {
    if (status === 'ok') return true;
    if (member.status === 'ok' || !Array.isArray(member.unpriced)) return false;
    const recorded = new Set(member.unpriced);
    if (recorded.has('*')) return true;
    return Array.isArray(unknownKeys) && unknownKeys.every(key => key !== '*' &&
      (recorded.has(key) || recorded.has(`${key.slice(0, key.indexOf(':'))}:*`)));
  }
  async function repriceRecord(name, state = null) {
    if (!recordStore || typeof valueFrom !== 'function') return false;
    let record = null, saved = null;
    try { record = recordStore.getRecord(name); if (record) saved = recordStore.getInputs(name); } catch { return false; }
    if (!record || !saved) return false;
    const aggregates = new Array(record.members.length);
    let failed = false;
    await mapBounded(record.members, async (member, index) => {
      if (failed) return;
      const entry = saved.get(keyOf(member.characterName));
      if (!entry || entry.targetKey !== member.targetKey) { failed = true; return; }
      let stored = null;
      try { stored = store.getCharacter(member.characterName); } catch { stored = null; }
      if (stored && stored.targetKey === member.targetKey && storedVersion(stored) >= VALUATION_VERSION
        && Number.isSafeInteger(stored.computedAt) && now() - stored.computedAt < freshMs
        && pricesAsRecorded(member, stored.status, storedUnknownKeys(stored))) { aggregates[index] = stored.aggregate; return; }
      try {
        const value = await valueFrom(member.characterName, entry.inputs);
        if (!pricesAsRecorded(member, value?.status, valuationUnknownKeys(value))) { failed = true; return; }
        aggregates[index] = projectRosterAggregate(value);
      } catch { failed = true; }
    }, recordConcurrency);
    if (failed || closed || aggregates.some(row => !row)) return false;
    const result = aggregateRosterValuations(aggregates);
    if (!money(result?.knownGold)) return false;
    // Members priced in full at the recorded moment must still add up to a complete roster today.
    if (record.members.every(member => member.status === 'ok') && result.complete !== true) return false;
    try { recordStore.updateRepriced(name, { repricedGold: result.knownGold, repricedAt: now() }); }
    catch { if (state) state.storageFailed = true; return false; }
    return true;
  }
  // Replace the record only when this moment is worth more than what the record is worth today.
  function considerRecord(anchor, state = null) {
    if (!recordStore) return false;
    const candidate = recordCandidate(anchor);
    if (!candidate) return false;
    let previous = null;
    try { previous = recordStore.getRecord(anchor.characterName); } catch { return false; }
    const bar = previous ? previous.repricedGold ?? previous.recordGold : null;
    if (bar !== null && candidate.knownGold <= bar) return false;
    try {
      recordStore.putRecord(anchor.characterName, { serverName: candidate.serverName, recordedAt: now(),
        recordGold: candidate.knownGold, members: candidate.members, inputs: candidate.inputs });
    } catch { if (state) state.storageFailed = true; return false; }
    return true;
  }
  function readRecord(name) {
    if (!recordStore) return emptyRecord();
    let record = null;
    try { record = recordStore.getRecord(name); } catch { record = null; }
    if (!record) return emptyRecord();
    // `status` is the character's own valuation status, so a member counted here is one whose whole value
    // was known at the recorded moment; the rest is what the bot shows as the missing-quote tail.
    return { status: 'ok', knownGold: record.repricedGold ?? record.recordGold, recordedAt: record.recordedAt,
      repricedAt: record.repricedAt,
      counts: { characters: record.members.length, knownCharacters: record.members.filter(row => row.status === 'ok').length,
        dealers: record.members.filter(row => row.role === 'dealer').length,
        supports: record.members.filter(row => row.role === 'support').length },
      members: record.members.map(row => ({ characterName: row.characterName, itemLevel: row.itemLevel, role: row.role })) };
  }

  // A roster read that hits the official budget waits like a character does; a run that mostly skips is
  // fast enough to exhaust the per-minute allowance with its details reads alone.
  async function readAnchorRoster(anchor) {
    for (let attempt = 0; ; attempt++) {
      try {
        const data = await readRoster(anchor);
        const value = data?.roster, rows = value?.characters;
        if (typeof value?.characterName === 'string' && typeof value?.serverName === 'string' &&
          Array.isArray(rows) && rows.length && rows.length <= 100) {
          return { characterName: value.characterName, serverName: value.serverName,
            members: rows.map(row => ({ characterName: row?.characterName, serverName: row?.serverName, itemLevel: row?.itemLevel })) };
        }
        return null;
      } catch (error) {
        if (error?.status === 429 && attempt < retries && !closed) { await sleep(retryWaitMs); continue; }
        return null;
      }
    }
  }

  async function runOnce(anchors) {
    const startedAt = now();
    const state = { startedAt, finishedAt: null, anchors: anchors.length, anchorsDone: 0, calculated: 0,
      skipped: 0, failed: 0, rostersFailed: 0, recorded: 0, repriced: 0, remaining: 0, storageFailed: false };
    current = state;
    const handled = new Set();
    for (let index = 0; index < anchors.length; index++) {
      if (closed || now() - startedAt >= runBudgetMs) {
        state.remaining = anchors.length - index;
        for (const name of anchors.slice(index)) enqueue(name);
        break;
      }
      const anchor = anchors[index];
      const roster = await readAnchorRoster(anchor);
      if (!roster) { state.rostersFailed++; state.anchorsDone++; continue; }
      try { store.recordRoster(roster.characterName, { serverName: roster.serverName, members: roster.members }); }
      catch { state.storageFailed = true; }
      const targets = roster.members.filter(row => typeof row.characterName === 'string' && typeof row.itemLevel === 'number' &&
        row.itemLevel >= raidLevel && !handled.has(keyOf(row.characterName)));
      for (const row of targets) handled.add(keyOf(row.characterName));
      await mapBounded(targets, async row => {
        const details = await updateCharacter(row, state);
        rememberInputs(row.characterName, valuationFingerprint(details), snapshotValuationInputs(details));
      });
      // The record is decided once the whole anchor is processed: re-price what the record already holds, then
      // replace it only if this moment beats it. A character shared with an earlier anchor keeps the snapshot
      // that anchor read, so it takes part here without a second equipment lookup.
      if (recordStore) {
        if (await repriceRecord(anchor, state)) state.repriced++;
        if (considerRecord({ characterName: roster.characterName, serverName: roster.serverName, members: roster.members }, state)) state.recorded++;
      }
      state.anchorsDone++;
    }
    state.finishedAt = now();
    current = null; last = state;
    if (state.remaining === 0 && !closed) lastSuccessAt = state.finishedAt;
    return state;
  }

  function summary() {
    const state = current || last;
    return { running: Boolean(current), queued: queue.size, lastSuccessAt,
      run: state ? { startedAt: state.startedAt, finishedAt: state.finishedAt, anchors: state.anchors,
        anchorsDone: state.anchorsDone, calculated: state.calculated, skipped: state.skipped, failed: state.failed,
        rostersFailed: state.rostersFailed, recorded: state.recorded ?? 0, repriced: state.repriced ?? 0,
        remaining: state.remaining, storageFailed: state.storageFailed } : null };
  }

  // One sequential job at a time; a second request only leaves its anchors behind for the next run.
  function refresh(names) {
    if (closed) return { status: 'unavailable', ...summary() };
    if (running) { for (const name of names) enqueue(name); return { status: 'running', ...summary() }; }
    const anchors = [], seen = new Set();
    // The queue holds anchors a read found missing or stale and anchors an earlier run ran out of time for,
    // so they go first: a guild larger than one run still comes around instead of waiting behind the same names.
    for (const [id, name] of [...queue]) {
      if (anchors.length >= maxAnchors) break;
      queue.delete(id); seen.add(id); anchors.push(name);
    }
    for (const name of names) {
      const id = keyOf(name);
      if (seen.has(id)) continue;
      seen.add(id);
      if (anchors.length < maxAnchors) { queue.delete(id); anchors.push(name); } else enqueue(name);
    }
    running = runOnce(anchors).catch(() => null).finally(() => { running = null; });
    return { status: 'started', ...summary() };
  }

  function anchorValue(name) {
    let roster = null;
    try { roster = store.getRoster(name); } catch { roster = null; }
    // A record outlives the roster row it came from, so it is reported even when the roster itself is missing.
    if (!roster) { enqueue(name); return { characterName: name, status: 'missing', roster: null, aggregate: null, computedAt: null, record: readRecord(name) }; }
    if (now() - roster.checkedAt > rosterMaxAgeMs) enqueue(name);
    const rows = roster.members.map(member => {
      let stored = null;
      try { stored = store.getCharacter(member.characterName); } catch { stored = null; }
      return { member, stored };
    });
    const characters = rows.map(({ member, stored }) => ({ characterName: member.characterName, serverName: member.serverName,
      itemLevel: member.itemLevel, role: stored?.role ?? null, status: stored ? stored.status : 'missing',
      knownGold: stored ? stored.knownGold : null }));
    const raid = rows.filter(({ member }) => member.itemLevel >= raidLevel);
    const computed = raid.filter(({ stored }) => stored).map(({ stored }) => stored.computedAt);
    let aggregate, status;
    if (!raid.length) {
      aggregate = { knownGold: 0, complete: true, engravingBooksGold: 0, estimatedItems: 0,
        counts: { characters: 0, knownCharacters: 0, unknownCharacters: 0, estimatedCharacters: 0 } };
      status = 'ok';
    } else {
      const result = aggregateRosterValuations(raid.map(({ member, stored }) => stored?.aggregate ??
        { characterName: member.characterName, serverName: member.serverName }));
      const known = Number.isSafeInteger(result?.counts?.knownCharacters) ? result.counts.knownCharacters : 0;
      aggregate = { knownGold: money(result?.knownGold) ? result.knownGold : 0, complete: result?.complete === true,
        engravingBooksGold: money(result?.engravingBooksGold) ? result.engravingBooksGold : 0,
        estimatedItems: counted(result?.estimatedItems),
        counts: { characters: raid.length, knownCharacters: known, unknownCharacters: raid.length - known,
          estimatedCharacters: counted(result?.counts?.estimatedCharacters) } };
      status = aggregate.complete && known === raid.length ? 'ok' : known === 0 ? 'missing' : 'partial';
    }
    return { characterName: roster.anchorName, status,
      roster: { checkedAt: roster.checkedAt, characters },
      aggregate, computedAt: computed.length ? { oldest: Math.min(...computed), newest: Math.max(...computed) } : null,
      record: readRecord(roster.anchorName) };
  }

  // The character page's own valuation fills the same store, so a roster somebody opened on the website is
  // already priced when `/체급` asks for it. An item level the page does not carry is taken from the stored row.
  async function absorb(member, value, inputs = null) {
    if (closed || !member || typeof member.characterName !== 'string') return;
    // Keyed like the refresh run: the fingerprint of the inputs this very valuation read. Without that snapshot
    // (a character over the snapshot size cap) the page leaves the row to the refresh run.
    const targetKey = inputs && typeof value?.targetKey === 'string' && inputs.valuationTargets?.targetKey === value.targetKey
      ? valuationFingerprint(inputs) : null;
    const equipmentUpdatedAt = Number.isSafeInteger(value?.equipmentUpdatedAt) ? value.equipmentUpdatedAt : null;
    if (!targetKey || equipmentUpdatedAt === null) return;
    let stored = null;
    try { stored = store.getCharacter(member.characterName); } catch { stored = null; }
    const itemLevel = typeof member.itemLevel === 'number' ? member.itemLevel : stored?.itemLevel;
    if (typeof itemLevel !== 'number') return;
    let role = null;
    try { role = (await readDetails(member.characterName))?.efficiency?.score?.role ?? null; } catch { role = null; }
    if (closed) return;
    try { store.recordCharacter(member.characterName, projectRosterValueRow({ ...member, itemLevel }, value,
      { role, targetKey, equipmentUpdatedAt, computedAt: now() })); } catch { /* storage trouble never reaches the page */ }
    rememberInputs(member.characterName, targetKey, inputs);
    // A roster somebody opened on the website sets records too. The check runs after every character and only
    // succeeds once the last 1720↑ member of that roster is stored, so a half-finished page cannot record a
    // lower sum. Unlike the nightly run this path never re-prices: the bar is what the last run left behind.
    if (!recordStore) return;
    for (const anchor of pageRosters.values())
      if (anchor.members.some(row => keyOf(row.characterName || '') === keyOf(member.characterName))) considerRecord(anchor);
  }
  function absorbRoster(roster) {
    if (closed || !roster || !Array.isArray(roster.characters)) return;
    const members = roster.characters.map(row => ({ characterName: row?.characterName, serverName: row?.serverName, itemLevel: row?.itemLevel }));
    try { store.recordRoster(roster.characterName, { serverName: roster.serverName, members }); }
    catch { /* storage trouble never reaches the page */ }
    if (!recordStore || typeof roster.characterName !== 'string' || typeof roster.serverName !== 'string') return;
    const id = keyOf(roster.characterName);
    pageRosters.delete(id);
    pageRosters.set(id, { characterName: roster.characterName, serverName: roster.serverName, members });
    while (pageRosters.size > rosterCacheSize) pageRosters.delete(pageRosters.keys().next().value);
  }

  return {
    refresh, status: summary, absorb, absorbRoster,
    read(names) { return { anchors: names.map(name => anchorValue(name)), updatedAt: now() }; },
    allowRead(ip) { return allow(readAttempts, ip, 60); },
    allowRefresh(ip) { return allow(refreshAttempts, ip, 6); },
    close() { closed = true; queue.clear(); readAttempts.clear(); refreshAttempts.clear(); inputsCache.clear(); pageRosters.clear(); },
  };
}
