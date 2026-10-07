import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeCharacter } from './character-profile.js';

const FILE_LIMIT = 256 * 1024 * 1024;
const APPLICATION_ID = 0x4f54534e;
const KEYS = {
  profile: ['profile', 'updatedAt'],
  details: ['equipment', 'accessories', 'bracelet', 'stone', 'gems', 'engravings', 'arkpassive', 'cards', 'arkgrid', 'crit', 'efficiency', 'combatStats', 'updatedAt'],
  roster: ['roster', 'updatedAt'],
  arkgrid: ['arkgrid', 'updatedAt'],
};
const hash = text => createHash('sha256').update(text).digest('hex');
const invalid = () => new Error('Invalid character snapshot');
function keyOf(name) {
  const normalized = normalizeCharacter(name);
  if (!normalized) throw invalid();
  return normalized.toLowerCase();
}
function timestamp(value) { return Number.isSafeInteger(value) && value >= 0; }
function validatePayload(key, section, value, now, maxBytes) {
  if (!KEYS[section] || !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(field => !KEYS[section].includes(field))
      || !timestamp(value.updatedAt) || value.updatedAt > now) throw invalid();
  const name = section === 'profile' ? value.profile?.characterName : section === 'details'
    ? value.efficiency?.characterName : section === 'roster' ? value.roster?.characterName : value.arkgrid?.name;
  if (keyOf(name) !== key || (section === 'arkgrid' && value.arkgrid.partial !== false)) throw invalid();
  const stack = [[value, 0]]; let visited = 0, textBytes = 0;
  while (stack.length) {
    const [entry, depth] = stack.pop();
    if (++visited > 100000 || depth > 40) throw invalid();
    if (typeof entry === 'string') { textBytes += Buffer.byteLength(entry); if (textBytes > maxBytes) throw invalid(); continue; }
    if (entry === null || typeof entry === 'boolean') continue;
    if (typeof entry === 'number') { if (!Number.isFinite(entry)) throw invalid(); continue; }
    if (!entry || typeof entry !== 'object') throw invalid();
    if (Object.keys(entry).length > 10000) throw invalid();
    for (const item of Object.values(entry)) stack.push([item, depth + 1]);
  }
}

// Independent, disposable display cache. Never contains session or ownership rows.
export function createCharacterSnapshotStore(path, { now = Date.now, maxCharacters = 2000,
  maxRecords = 8000, maxBytes = 240 * 1024 * 1024, maxRecordBytes = 3 * 1024 * 1024 } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || ![maxCharacters, maxRecords, maxBytes, maxRecordBytes].every(Number.isSafeInteger)
      || maxCharacters < 1 || maxCharacters > 2000 || maxRecords < 1 || maxRecords > 8000
      || maxBytes < 1 || maxBytes > FILE_LIMIT || maxRecordBytes < 1 || maxRecordBytes > 3 * 1024 * 1024) throw invalid();
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink() || (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))) throw invalid();
  if (existsSync(path) && lstatSync(path).size > FILE_LIMIT) throw invalid();
  for (const suffix of ['-journal', '-wal', '-shm']) if (existsSync(path + suffix)
      && (!lstatSync(path + suffix).isFile() || lstatSync(path + suffix).isSymbolicLink())) throw invalid();
  if (process.platform !== 'win32' && (lstatSync(directory).mode & 0o077)) throw invalid();
  const db = new DatabaseSync(path);
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const app = db.prepare('PRAGMA application_id').get().application_id;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
    if (!((version === 0 && app === 0 && tables.length === 0) || (version === 1 && app === APPLICATION_ID && tables.length === 1 && tables[0] === 'snapshots'))) throw invalid();
    chmodSync(path, 0o600);
    // DELETE journaling bounds persistent files; no long-lived WAL or shared-memory sidecars.
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250; PRAGMA auto_vacuum=INCREMENTAL;');
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    db.exec(`PRAGMA max_page_count=${Math.floor(FILE_LIMIT / pageSize)};`);
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS snapshots (
        name_key TEXT NOT NULL, section TEXT NOT NULL CHECK(section IN ('profile','details','roster','arkgrid')),
        captured_at INTEGER NOT NULL CHECK(captured_at>=0), accessed_at INTEGER NOT NULL CHECK(accessed_at>=0),
        attempt INTEGER NOT NULL CHECK(attempt>0), bytes INTEGER NOT NULL CHECK(bytes>0),
        payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64), payload TEXT NOT NULL,
        PRIMARY KEY(name_key,section)
      ) STRICT;
      PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`);
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw invalid();
  } catch (error) { try { db.close(); } catch {} throw error; }
  try {
    let closed = false;
    let sequence = db.prepare('SELECT COALESCE(MAX(attempt),0) AS value FROM snapshots').get().value;
    let accessOrder = db.prepare('SELECT COALESCE(MAX(accessed_at),0) AS value FROM snapshots').get().value;
    const active = new Map();
    const issued = new WeakSet();
    const read = db.prepare('SELECT * FROM snapshots WHERE name_key=? AND section=?');
    const remove = db.prepare('DELETE FROM snapshots WHERE name_key=?');
    function beginAttempt(name) {
      const key = keyOf(name);
      // One service retains at most 128 cache leases, 32 pending operations,
      // and 32 display references whose entries may have been evicted.
      if (closed || active.size >= 256 || sequence >= Number.MAX_SAFE_INTEGER) throw invalid();
      const attempt = Object.freeze({ nameKey: key, revision: ++sequence });
      active.set(attempt, { valid: true });
      issued.add(attempt);
      return attempt;
    }
    function validAttempt(key, attempt) { return !closed && attempt?.nameKey === key && active.get(attempt)?.valid === true; }
    function nextAccess() {
      const value = now();
      if (!timestamp(value) || accessOrder >= Number.MAX_SAFE_INTEGER) throw invalid();
      return accessOrder = Math.max(value, accessOrder + 1);
    }
    function trim() {
      while (true) {
        const stats = db.prepare('SELECT COUNT(DISTINCT name_key) AS characters, COUNT(*) AS records, COALESCE(SUM(bytes),0) AS bytes FROM snapshots').get();
        if (stats.characters <= maxCharacters && stats.records <= maxRecords && stats.bytes <= maxBytes) return;
        const oldest = db.prepare('SELECT name_key FROM snapshots GROUP BY name_key ORDER BY MAX(accessed_at), name_key LIMIT 1').get();
        if (!oldest) return;
        remove.run(oldest.name_key);
      }
    }
    function get(name, section) {
      const key = keyOf(name);
      if (!KEYS[section]) throw invalid();
      if (closed) return null;
      const row = read.get(key, section);
      if (!row) return null;
      let value;
      try {
        if (row.bytes > maxRecordBytes || Buffer.byteLength(row.payload) !== row.bytes || hash(row.payload) !== row.payload_sha256) throw invalid();
        value = JSON.parse(row.payload);
        validatePayload(key, section, value, now(), maxRecordBytes);
        if (value.updatedAt !== row.captured_at) throw invalid();
      } catch { return null; }
      db.prepare('UPDATE snapshots SET accessed_at=? WHERE name_key=?').run(nextAccess(), key);
      return value;
    }
    function putSuccess(name, section, attempt, value) {
      const key = keyOf(name);
      if (!validAttempt(key, attempt)) return false;
      validatePayload(key, section, value, now(), maxRecordBytes);
      const payload = JSON.stringify(value), bytes = Buffer.byteLength(payload);
      if (!bytes || bytes > maxRecordBytes || bytes > maxBytes) throw invalid();
      db.exec('BEGIN IMMEDIATE');
      try {
        const changed = db.prepare(`INSERT INTO snapshots VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(name_key,section) DO UPDATE SET captured_at=excluded.captured_at, accessed_at=excluded.accessed_at,
            attempt=excluded.attempt, bytes=excluded.bytes, payload_sha256=excluded.payload_sha256, payload=excluded.payload
          WHERE excluded.attempt >= snapshots.attempt AND excluded.captured_at >= snapshots.captured_at`).run(
          key, section, value.updatedAt, nextAccess(), attempt.revision, bytes, hash(payload), payload).changes;
        trim(); db.exec('COMMIT');
        return Boolean(changed);
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    }
    function invalidateNotFound(name, attempt) {
      const key = keyOf(name);
      // A failed child request may finish before its display aggregation. An
      // issued token still carries its deletion cutoff after its write lease ends.
      if (closed || attempt?.nameKey !== key || !issued.has(attempt)) return false;
      for (const [other, state] of active) if (other.nameKey === key && other.revision <= attempt.revision) state.valid = false;
      db.prepare('DELETE FROM snapshots WHERE name_key=? AND attempt<=?').run(key, attempt.revision);
      return true;
    }
    trim();
    return { get, beginAttempt, putSuccess, invalidateNotFound,
      endAttempt(attempt) { active.delete(attempt); },
      close() { if (closed) return; closed = true; active.clear(); db.close(); },
    };
  } catch (error) { try { db.close(); } catch {} throw error; }
}
