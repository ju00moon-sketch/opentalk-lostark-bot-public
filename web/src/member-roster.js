import { GuildError } from './guild-store.js';
import { normalizeCharacter, normalizeProfile } from './character-profile.js';

const API = 'https://developer-lostark.game.onstove.com';
const MAX_BYTES = 512 * 1024;
const keyOf = value => value.normalize('NFC').toLowerCase();
const unavailable = () => new GuildError(502, 'member_roster_unavailable');
const notFound = () => new GuildError(404, 'member_roster_not_found');
const limited = () => new GuildError(429, 'member_roster_rate_limited');
const closedError = () => new GuildError(503, 'member_roster_unavailable');

function waitFor(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof GuildError ? signal.reason : unavailable());
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) abort(); else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

function plainText(value) {
  if (typeof value !== 'string' || !value.isWellFormed() ||
      /[<>&\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u.test(value)) throw unavailable();
  const text = value.normalize('NFC').trim();
  if (!text || [...text].length > 40) throw unavailable();
  return text;
}

function normalizeRoster(rows, name, updatedAt) {
  if (rows === null || (Array.isArray(rows) && !rows.length)) throw notFound();
  if (!Array.isArray(rows) || rows.length > 512) throw unavailable();
  const seen = new Set();
  const characters = rows.map(row => {
    const characterName = normalizeCharacter(row?.CharacterName);
    if (!characterName) throw unavailable();
    const key = keyOf(characterName);
    if (seen.has(key)) throw unavailable();
    seen.add(key);
    const serverName = plainText(row.ServerName), characterClass = plainText(row.CharacterClassName);
    try {
      return normalizeProfile({ ...row, ServerName: serverName, CharacterClassName: characterClass }, characterName);
    } catch { throw unavailable(); }
  });
  const anchor = characters.find(row => keyOf(row.characterName) === keyOf(name));
  if (!anchor) throw unavailable();
  characters.sort((a, b) => b.itemLevel - a.itemLevel || a.characterName.localeCompare(b.characterName, 'ko'));
  const byServer = new Map();
  for (const row of characters) {
    if (!byServer.has(row.serverName)) byServer.set(row.serverName, []);
    byServer.get(row.serverName).push(row);
  }
  const groups = [...byServer].map(([serverName, members]) => ({ serverName, characters: members }));
  groups.sort((a, b) => Number(b.serverName === anchor.serverName) - Number(a.serverName === anchor.serverName) || a.serverName.localeCompare(b.serverName, 'ko'));
  return { anchor, characters, groups, updatedAt };
}

// The caller obtains the anchor from verified server-side ownership. This service
// never accepts a session or changes membership; selection must be saved only
// after the caller rechecks that ownership revision and anchor still match.
export function createMemberRosterService({ config, fetchImpl = fetch, now = Date.now,
  cacheMs = 300000, maxEntries = 128, maxCacheBytes = 4 * 1024 * 1024,
  requestTimeoutMs = 8000, upstreamPerMinute = 20 } = {}) {
  const cache = new Map(), pending = new Map(), generations = new Map(), attempts = new Map();
  const controllers = new Set(), queue = [], starts = [];
  let cacheBytes = 0, active = 0, sequence = 0, closed = false, blockedUntil = 0;

  function allow(ip) {
    if (closed) return false;
    const timestamp = now();
    for (const [key, entry] of attempts) if (entry.until <= timestamp) attempts.delete(key);
    let entry = attempts.get(ip);
    if (!entry) {
      if (attempts.size >= 10000) return false;
      entry = { count: 0, until: timestamp + 60000 }; attempts.set(ip, entry);
    }
    return ++entry.count <= 30;
  }
  function forget(key) {
    const entry = cache.get(key);
    if (entry) cacheBytes -= entry.bytes;
    cache.delete(key);
  }
  function remember(key, value) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > maxCacheBytes) return;
    forget(key); cache.set(key, { value, bytes, until: now() + cacheMs }); cacheBytes += bytes;
    while (cache.size > maxEntries || cacheBytes > maxCacheBytes) forget(cache.keys().next().value);
  }
  function drain() {
    while (active < 2 && queue.length) {
      const entry = queue.shift(); entry.signal.removeEventListener('abort', entry.abort);
      if (closed || entry.signal.aborted) { entry.reject(closed ? closedError() : unavailable()); continue; }
      active++; let released = false;
      entry.resolve(() => { if (!released) { released = true; active--; drain(); } });
    }
  }
  function acquire(signal) {
    return new Promise((resolve, reject) => {
      if (closed || signal.aborted) return reject(closed ? closedError() : unavailable());
      if (queue.length >= 8) return reject(limited());
      const entry = { signal, resolve, reject };
      entry.abort = () => { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); reject(closed ? closedError() : unavailable()); };
      signal.addEventListener('abort', entry.abort, { once: true }); queue.push(entry); drain();
    });
  }
  function request(name) {
    const controller = new AbortController(); controllers.add(controller);
    const { signal } = controller, timer = setTimeout(() => controller.abort(unavailable()), requestTimeoutMs);
    const clearTimer = () => clearTimeout(timer);
    signal.addEventListener('abort', clearTimer, { once: true });
    let release, reader, response;
    const physical = (async () => {
      try {
        release = await acquire(signal); signal.throwIfAborted();
        const timestamp = now();
        while (starts.length && starts[0] <= timestamp - 60000) starts.shift();
        if (starts.length >= upstreamPerMinute || blockedUntil > timestamp) throw limited();
        starts.push(timestamp);
        response = await fetchImpl(`${API}/characters/${encodeURIComponent(name)}/siblings`, {
          method: 'GET', redirect: 'error', signal,
          headers: { Authorization: `bearer ${config.automaticApproval.lostArkApiKey}`, Accept: 'application/json' },
        });
        signal.throwIfAborted();
        const reset = response.headers.get('x-ratelimit-reset'), remaining = response.headers.get('x-ratelimit-remaining');
        if (response.status === 429 || (/^\d+$/.test(remaining || '') && Number(remaining) <= 15)) {
          const completed = now(), candidate = /^\d{10}$/.test(reset || '') ? Number(reset) * 1000 : completed + 60000;
          blockedUntil = candidate > completed && candidate <= completed + 120000 ? candidate : completed + 60000;
        }
        if (response.status === 404) throw notFound();
        if (response.status === 429) throw limited();
        if (!response.ok || response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '') ||
            Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) throw unavailable();
        reader = response.body.getReader(); const chunks = []; let bytes = 0;
        while (true) {
          const { value, done } = await reader.read(); signal.throwIfAborted(); if (done) break;
          bytes += value.byteLength; if (bytes > MAX_BYTES) throw unavailable(); chunks.push(Buffer.from(value));
        }
        const rows = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        return normalizeRoster(rows, name, now());
      } catch (error) {
        if (error?.status === 429) throw limited();
        if (error instanceof GuildError && error.code?.startsWith('member_roster_')) throw error;
        throw unavailable();
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', clearTimer); controllers.delete(controller);
        if (reader) void reader.cancel().catch(() => {}); else void response?.body?.cancel().catch(() => {});
        // Timeout settles callers, but a noncooperative transport keeps its slot
        // until the underlying fetch/body work actually completes.
        release?.();
      }
    })();
    return waitFor(physical, signal);
  }
  async function get(anchorName, { fresh = false } = {}) {
    const name = normalizeCharacter(anchorName);
    if (!name || typeof fresh !== 'boolean') throw new GuildError(400, 'invalid_request');
    if (closed || !config?.automaticApproval?.lostArkApiKey) throw closedError();
    const key = keyOf(name);
    if (!fresh) {
      const cached = cache.get(key);
      if (cached?.until > now()) {
        cache.delete(key); cache.set(key, cached); return structuredClone(cached.value);
      }
      if (pending.has(key)) {
        const value = await pending.get(key).promise;
        if (closed) throw closedError();
        return structuredClone(value);
      }
    }
    forget(key);
    const generation = generations.get(key) || { latest: 0, count: 0 };
    generation.latest = ++sequence; generation.count++; generations.set(key, generation);
    const entry = { sequence, promise: null };
    entry.promise = request(name).then(value => {
      if (closed) throw closedError();
      if (entry.sequence === generation.latest) remember(key, value);
      return value;
    }).finally(() => {
      if (pending.get(key) === entry) pending.delete(key);
      if (!--generation.count) generations.delete(key);
    });
    pending.set(key, entry);
    const value = await entry.promise;
    if (closed) throw closedError();
    return structuredClone(value);
  }
  async function verifySelection(anchorName, selectedName) {
    const name = normalizeCharacter(selectedName);
    if (!name) throw new GuildError(400, 'member_roster_selection_invalid');
    const result = await get(anchorName, { fresh: true });
    if (closed) throw closedError();
    const character = result.characters.find(row => keyOf(row.characterName) === keyOf(name));
    if (!character) throw new GuildError(400, 'member_roster_selection_invalid');
    return { character, anchor: result.anchor, verifiedAt: result.updatedAt };
  }
  return { get, verifySelection, allow, close() {
    if (closed) return; closed = true;
    for (const controller of controllers) controller.abort(closedError());
    cache.clear(); cacheBytes = 0; attempts.clear();
  } };
}
