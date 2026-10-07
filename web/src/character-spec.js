import { GuildError } from './guild-store.js';
import { findCharacterProfile, normalizeCharacter, normalizeProfile } from './character-profile.js';
import { mapCharacterSpecData } from './character-spec-data.js';
import { analyzeCrit } from '../../src/crit-analysis.js';
import { analyzeNativeEfficiency } from '../../src/native-character-efficiency.js';
import { analyzeNativeSpecScore } from '../../src/native-spec-score.js';
import { analyzeBraceletExpectation } from '../../src/character-bracelet-expectation.js';
import { parseRosterValuationTargets } from '../../src/roster-valuation-targets.js';
import { createArkgridRosterService, summarizeGrid } from '../../src/arkgrid-roster.js';

const API = 'https://developer-lostark.game.onstove.com';
export const specSections = new Set(['profile', 'details', 'roster', 'arkgrid']);
const failure = () => new GuildError(502, 'character_unavailable');
const limited = () => new GuildError(429, 'character_rate_limited');
const keyOf = name => name.normalize('NFC').toLowerCase();

export function normalizeCombatStats(value) {
  if (!Array.isArray(value) || value.length > 20) return null;
  const names = ['공격력', '최대 생명력', '치명', '특화', '신속', '제압', '인내', '숙련'];
  const stats = new Map();
  for (const row of value) {
    if (!row || typeof row !== 'object' || !names.includes(row.Type)) continue;
    if (stats.has(row.Type)) return null;
    if (!['number', 'string'].includes(typeof row.Value) || String(row.Value).length > 32 ||
        !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(String(row.Value))) continue;
    const number = Number(String(row.Value).replaceAll(',', ''));
    if (Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER) stats.set(row.Type, number);
  }
  return stats.size ? names.filter(name => stats.has(name)).map(name => ({ name, value: stats.get(name) })) : null;
}

function safeCrit(raw) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const rows = (value, max) => Array.isArray(value) && value.length <= max && value.every(object);
  const tooltip = value => {
    if (typeof value !== 'string' || value.length > 131072) return false;
    try { return object(JSON.parse(value)); } catch { return false; }
  };
  try {
    if (!rows(raw.ArmoryProfile?.Stats, 20) || !rows(raw.ArmoryEquipment, 32) || !rows(raw.ArmorySkills, 100) ||
        !object(raw.ArmoryEngraving) || !rows(raw.ArmoryEngraving.ArkPassiveEffects, 16) ||
        !object(raw.ArkPassive) || !rows(raw.ArkPassive.Effects, 100)) return null;
    const stat = raw.ArmoryProfile.Stats.find(value => value.Type === '치명');
    if (!Array.isArray(stat?.Tooltip) || !stat.Tooltip.every(value => typeof value === 'string' && value.length <= 16384)) return null;
    const match = /치명타 적중률이 <font[^>]*>(\d+(?:\.\d+)?)%/.exec(String(stat.Tooltip));
    if (!match || Number(match[1]) > 100) return null;
    if (raw.ArmoryEquipment.some(value => ['목걸이', '귀걸이', '반지', '팔찌'].includes(value.Type) && !tooltip(value.Tooltip)) ||
        raw.ArmoryEngraving.ArkPassiveEffects.some(value => typeof value.Name !== 'string' || typeof value.Description !== 'string' ||
          !Number.isInteger(value.Level) || value.Level < 0 || value.Level > 10) ||
        raw.ArkPassive.Effects.some(value => typeof value.Description !== 'string' || !tooltip(value.ToolTip)) ||
        raw.ArmorySkills.some(value => value.Level > 1 && !tooltip(value.Tooltip))) return null;
    const result = analyzeCrit(raw);
    const finite = value => typeof value === 'number' ? Number.isFinite(value)
      : Array.isArray(value) ? value.every(finite) : object(value) ? Object.values(value).every(finite) : true;
    return finite(result) && result.total >= 0 && result.total <= 1000 ? result : null;
  } catch { return null; }
}

// One instance per web process. Successful public data only; no session or account values.
export function createCharacterSpecService({ config, fetchImpl = fetch, now = Date.now,
  cacheMs = 300000, maxEntries = 128, maxCacheBytes = 16 * 1024 * 1024,
  upstreamPerMinute = 40, concurrency = 4, requestTimeoutMs = 8000, snapshotStore = null, scoreRecordStore = null } = {}) {
  const cache = new Map();
  const pending = new Map();
  const workStates = new WeakMap();
  const failureOrigins = new WeakMap();
  const liveStates = new Set();
  const displayPending = new Map();
  const attempts = new Map();
  const starts = [];
  const queue = [];
  const controllers = new Set();
  let cacheBytes = 0;
  let active = 0;
  let blockedUntil = 0;
  let closed = false;
  let headerBudget = null;
  let workRevision = 0;
  let snapshotUnavailable = false;

  function allow(ip) {
    const timestamp = now();
    for (const [key, entry] of attempts) if (entry.until <= timestamp) attempts.delete(key);
    let entry = attempts.get(ip);
    if (!entry) {
      if (attempts.size >= 10000) return false;
      entry = { count: 0, until: timestamp + 60000 };
      attempts.set(ip, entry);
    }
    return ++entry.count <= 60;
  }
  function forget(key) {
    const entry = cache.get(key);
    if (!entry) return;
    cacheBytes -= entry.bytes;
    cache.delete(key);
    entry.state.cached = false;
    releaseAttempt(entry.state);
  }
  function remember(key, value, state) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > maxCacheBytes) return;
    forget(key);
    state.cached = true;
    cache.set(key, { value, bytes, revision: state.revision, state, until: now() + cacheMs });
    cacheBytes += bytes;
    while (cache.size > maxEntries || cacheBytes > maxCacheBytes) forget(cache.keys().next().value);
  }
  function releaseAttempt(state) {
    if (state?.settled && !state.cached && state.displayUsers === 0 && !state.released) {
      snapshotCall('endAttempt', state.attempt);
      state.released = true;
      liveStates.delete(state);
    }
  }
  function share(key, operation, shouldCache = () => true, refresh = false) {
    if (closed) return Promise.reject(failure());
    if (pending.has(key)) return pending.get(key);
    const entry = cache.get(key);
    if (!refresh && entry?.until > now()) {
      cache.delete(key); cache.set(key, entry);
      const promise = Promise.resolve(entry.value);
      workStates.set(promise, entry.state);
      return promise;
    }
    forget(key);
    if (pending.size >= 32) return Promise.reject(limited());
    const name = key.split(':')[1];
    const state = { key, valid: true, revision: ++workRevision, settled: false, cached: false, released: false,
      displayUsers: 0, attempt: snapshotCall('beginAttempt', name) };
    liveStates.add(state);
    const promise = Promise.resolve().then(operation).then(value => {
      if (!state.valid) throw new GuildError(404, 'character_not_found');
      if (!closed && shouldCache(value)) remember(key, value, state);
      return value;
    }).catch(error => {
      // A parent aggregation can join older child work. Keep the first failing
      // upstream operation's chronology instead of assigning its parent's age.
      if (error && typeof error === 'object' && !failureOrigins.has(error)) failureOrigins.set(error, state);
      throw error;
    }).finally(() => {
      pending.delete(key); state.settled = true; releaseAttempt(state);
    });
    workStates.set(promise, state);
    pending.set(key, promise);
    return promise;
  }
  function reserve() {
    const timestamp = now();
    while (starts.length && starts[0] <= timestamp - 60000) starts.shift();
    if (closed) throw failure();
    if (blockedUntil > timestamp || starts.length >= upstreamPerMinute) throw limited();
    if (headerBudget && headerBudget.until > timestamp) {
      if (headerBudget.remaining <= 10) throw limited();
      headerBudget.remaining--;
    }
    starts.push(timestamp);
  }
  function observe(response) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    const timestamp = now();
    const epoch = /^\d{10}$/.test(reset || '') ? Number(reset) * 1000 : timestamp + 60000;
    const until = epoch > timestamp && epoch <= timestamp + 120000 ? epoch : timestamp + 60000;
    if (/^\d{1,5}$/.test(remaining || '')) {
      // Out-of-order responses cannot raise a previously observed budget in the same window.
      const available = Number(remaining);
      if (headerBudget?.until > timestamp) headerBudget.remaining = Math.min(headerBudget.remaining, available);
      else headerBudget = { remaining: available, until };
    }
    if (response.status === 429) blockedUntil = until;
  }
  function acquire(signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      if (queue.length >= 12) return reject(limited());
      const entry = { signal, resolve, reject };
      entry.abort = () => { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); reject(failure()); };
      signal.addEventListener('abort', entry.abort, { once: true });
      queue.push(entry);
      drain();
    });
  }
  function drain() {
    while (active < concurrency && queue.length) {
      const entry = queue.shift();
      entry.signal.removeEventListener('abort', entry.abort);
      if (entry.signal.aborted) { entry.reject(failure()); continue; }
      active++;
      entry.resolve(() => { active--; drain(); });
    }
  }
  async function request(path, { signal: parent, maxBytes = 3 * 1024 * 1024 } = {}) {
    if (!config.automaticApproval.lostArkApiKey) throw new GuildError(503, 'character_unavailable');
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    let release;
    let reader;
    try {
      release = await acquire(signal);
      signal.throwIfAborted();
      reserve();
      const response = await fetchImpl(API + path, { method: 'GET', redirect: 'error', signal,
        headers: { Authorization: `bearer ${config.automaticApproval.lostArkApiKey}`, Accept: 'application/json' } });
      observe(response);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 404) throw new GuildError(404, 'character_not_found');
        if (response.status === 429) throw limited();
        throw failure();
      }
      if (response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '') ||
          Number(response.headers.get('content-length')) > maxBytes || !response.body) {
        void response.body?.cancel().catch(() => {}); throw failure();
      }
      reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw failure();
        chunks.push(Buffer.from(value));
      }
      signal.throwIfAborted();
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch (error) {
      if (error instanceof GuildError) throw error;
      throw failure();
    } finally {
      clearTimeout(timer); controller.abort(); controllers.delete(controller);
      if (reader) void reader.cancel().catch(() => {});
      release?.();
    }
  }
  async function profile(name) {
    // Reuse signup's validation and error mapping, including its strict profile body limit.
    // The injected transport applies the public budget before that existing parser consumes it.
    const data = await findCharacterProfile(config, name, async (url, init) => {
      const value = await request(new URL(url).pathname, { signal: init.signal, maxBytes: 65536 });
      return Response.json(value);
    }, { extended: true });
    return { profile: data, updatedAt: now() };
  }
  function siblings(name, refresh = false) {
    return share(`siblings:${keyOf(name)}`, async () => {
      const rows = await request(`/characters/${encodeURIComponent(name)}/siblings`, { maxBytes: 128 * 1024 });
      if (rows === null) throw new GuildError(404, 'character_not_found');
      if (!Array.isArray(rows) || !rows.length || rows.length > 240) throw failure();
      const seen = new Set();
      const result = rows.map(row => {
        const character = normalizeCharacter(row?.CharacterName);
        if (!character) throw failure();
        const summary = normalizeProfile(row, character);
        const key = keyOf(character);
        if (seen.has(key)) throw failure();
        seen.add(key);
        return summary;
      });
      if (!seen.has(keyOf(name))) throw failure();
      return result.sort((a, b) => b.itemLevel - a.itemLevel || a.characterName.localeCompare(b.characterName, 'ko'));
    }, () => true, refresh);
  }
  const makeArkgridReader = refresh => createArkgridRosterService({
    readSiblings: async name => (await siblings(name, refresh)).filter(row => row.itemLevel > 0).map(row => ({ CharacterName: row.characterName,
      ServerName: row.serverName, ItemAvgLevel: String(row.itemLevel) })),
    readGrid: (name, options) => share(`grid:${keyOf(name)}`, async () => {
      const grid = await request(`/armories/characters/${encodeURIComponent(name)}/arkgrid`, { ...options, maxBytes: 512 * 1024 });
      if (grid !== null && (!grid || typeof grid !== 'object' || Array.isArray(grid) ||
          (grid.Slots !== null && (!Array.isArray(grid.Slots) || grid.Slots.length > 6)))) throw failure();
      summarizeGrid(grid);
      return grid;
    }, () => true, refresh),
    requestTimeoutMs, totalTimeoutMs: 18000,
  });
  const readArkgrid = makeArkgridReader(false), refreshArkgrid = makeArkgridReader(true);
  function getInternal(name, section, refresh = false) {
    if (!normalizeCharacter(name) || !specSections.has(section)) return Promise.reject(new GuildError(400, 'invalid_request'));
    name = normalizeCharacter(name);
    return share(`${section}:${keyOf(name)}`, async () => {
      try {
        if (section === 'profile') return await profile(name);
        if (section === 'details') {
          const raw = await request(`/armories/characters/${encodeURIComponent(name)}?filters=${encodeURIComponent('profiles+avatars+equipment+engravings+gems+arkpassive+combat-skills+cards+arkgrid')}`);
          if (raw === null) throw new GuildError(404, 'character_not_found');
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw failure();
          normalizeProfile(raw.ArmoryProfile, name);
          const details = mapCharacterSpecData({ equipment: raw.ArmoryEquipment, gems: raw.ArmoryGem,
            engravings: raw.ArmoryEngraving, arkpassive: raw.ArkPassive, cards: raw.ArmoryCard, arkgrid: raw.ArkGrid });
          const crit = safeCrit(raw);
          const efficiency = analyzeNativeEfficiency(raw, { crit, now });
          efficiency.braceletExpectation = analyzeBraceletExpectation(raw);
          efficiency.score = analyzeNativeSpecScore(raw);
          recordScore(name, efficiency.score);
          return { ...details, crit, efficiency, valuationTargets: parseRosterValuationTargets(raw, { observedAt: now() }),
            combatStats: normalizeCombatStats(raw.ArmoryProfile?.Stats), updatedAt: now() };
        }
        if (section === 'roster') {
          const characters = await siblings(name, refresh);
          const anchor = characters.find(row => keyOf(row.characterName) === keyOf(name));
          return { roster: { characterName: anchor.characterName, serverName: anchor.serverName, characters }, updatedAt: now() };
        }
        return { arkgrid: await (refresh ? refreshArkgrid : readArkgrid)(name), updatedAt: now() };
      } catch (error) {
        if (error instanceof GuildError) throw error;
        throw failure();
      }
    }, value => !value.arkgrid?.partial, refresh);
  }
  function invalidateName(name, revision) {
    const suffix = `:${keyOf(name)}`;
    for (const state of liveStates) if (state.key.endsWith(suffix) && state.revision <= revision) state.valid = false;
    for (const [key, entry] of cache) if (key.endsWith(suffix) && entry.revision <= revision) forget(key);
  }
  // The best 환산 점수 only rises; storage trouble never blocks the response and stops after repeated failures.
  let scoreRecordFailures = 0;
  function recordScore(name, score) {
    if (!scoreRecordStore || scoreRecordFailures >= 3 || score?.status !== 'ok' || !Number.isFinite(score.score) || score.score <= 0) return;
    try { scoreRecordStore.record(name, { score: score.score, role: score.role, modelVersion: score.modelVersion, recordedAt: now() }); scoreRecordFailures = 0; }
    catch { scoreRecordFailures++; }
  }
  function snapshotCall(method, ...args) {
    if (snapshotUnavailable && method !== 'endAttempt') return null;
    try {
      const result = snapshotStore?.[method]?.(...args) ?? null;
      if (method === 'invalidateNotFound' && snapshotStore && result !== true) snapshotUnavailable = true;
      return result;
    }
    catch { if (method === 'invalidateNotFound') snapshotUnavailable = true; return null; }
  }
  // refresh bypasses the shared cache for callers that must see the current upstream answer (the nightly
  // 원정대 환산 가치 job re-reads each roster); the display path keeps its own getForDisplay entry point.
  function get(name, section, { refresh = false } = {}) { return getInternal(name, section, refresh === true); }
  function getForDisplay(value, section, { refresh = false } = {}) {
    const name = normalizeCharacter(value);
    if (!name || !specSections.has(section) || typeof refresh !== 'boolean') return Promise.reject(new GuildError(400, 'invalid_request'));
    if (closed) return Promise.reject(failure());
    const key = `${section}:${keyOf(name)}:${refresh}`;
    if (displayPending.has(key)) return displayPending.get(key);
    if (displayPending.size >= 32) return Promise.reject(limited());
    const saved = reason => {
      if (closed) return null;
      const data = snapshotCall('get', name, section);
      return data ? { ...data, source: 'saved', capturedAt: data.updatedAt, refreshFailed: reason } : null;
    };
    const operation = Promise.resolve().then(async () => {
      let revision = workRevision, state, attempt;
      try {
        const request = getInternal(name, section, refresh);
        state = workStates.get(request);
        if (state) {
          state.displayUsers++;
          revision = state.revision; attempt = state.attempt;
        }
        // Valuation inputs are ephemeral server data, never a saved display source.
        const { valuationTargets: _valuationTargets, ...data } = await request;
        if (closed) throw failure();
        if (state?.valid === false) throw new GuildError(404, 'character_not_found');
        if (data.arkgrid?.partial) {
          const previous = saved('partial_upstream');
          if (previous) return previous;
          return { ...data, source: 'live', capturedAt: data.updatedAt, refreshFailed: 'partial_upstream' };
        }
        snapshotCall('putSuccess', name, section, attempt, data);
        return { ...data, source: 'live', capturedAt: data.updatedAt, refreshFailed: null };
      } catch (error) {
        if (error?.status === 404) {
          const origin = failureOrigins.get(error);
          if (origin) { revision = origin.revision; attempt = origin.attempt; }
          invalidateName(name, revision);
          snapshotCall('invalidateNotFound', name, attempt);
          throw error;
        }
        if (!closed && [429, 502, 503].includes(error?.status)) {
          const previous = saved(error.status === 429 ? 'rate_limited' : 'official_unavailable');
          if (previous) return previous;
        }
        throw error;
      } finally {
        if (state) { state.displayUsers--; releaseAttempt(state); }
      }
    }).finally(() => displayPending.delete(key));
    displayPending.set(key, operation);
    return operation;
  }
  return { get, getForDisplay, allow, close() {
    closed = true;
    for (const controller of controllers) controller.abort();
    for (const entry of queue.splice(0)) { entry.signal.removeEventListener('abort', entry.abort); entry.reject(failure()); }
    for (const key of cache.keys()) forget(key);
    attempts.clear();
  } };
}
