import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { GuildError } from './guild-store.js';
import { normalizeCharacter } from './character-profile.js';
import { CHARACTER_LIMIT, DAILY, RAID_LIMIT, WEEKLY, dailyPeriod, findRaid, raidId, raidsFor, sortRaids, weeklyPeriod } from '../../src/data/homework.js';

// 숙제표 저장소 (README.md).
// 회원마다 표에 올린 캐릭터와 캐릭터별 주간 레이드 선택, 그리고 지금 주기의 체크만 보관한다. 주기가 바뀌면 다음
// 체크가 그 줄을 덮어쓰므로 따로 지우는 일 없이 06:00(주간은 수요일)에 저절로 새 숙제가 된다.
// 인증 데이터베이스는 배포 때 스키마를 그대로 두어야 하므로 다른 기록들과 같이 전용 파일에 둔다.
export const HOMEWORK_APPLICATION_ID = 0x4f544857;
export const HOMEWORK_CHARACTER_TABLE_SQL = `CREATE TABLE homework_characters (
  user_id TEXT NOT NULL, character_name TEXT NOT NULL, server_name TEXT NOT NULL, character_class TEXT NOT NULL,
  item_level REAL NOT NULL CHECK(item_level>0 AND item_level<=10000),
  position INTEGER NOT NULL CHECK(position>=0 AND position<=63), raids TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  PRIMARY KEY(user_id, character_name)
) STRICT`;
export const HOMEWORK_PROGRESS_TABLE_SQL = `CREATE TABLE homework_progress (
  user_id TEXT NOT NULL, character_name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('daily','weekly')),
  item_id TEXT NOT NULL CHECK(length(item_id)>0 AND length(item_id)<=120),
  period TEXT NOT NULL CHECK(length(period)=10),
  value INTEGER NOT NULL CHECK(value>=0 AND value<=99),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  PRIMARY KEY(user_id, character_name, scope, item_id)
) STRICT`;
// 한 번에 보낼 수 있는 체크 수. 화면은 잠깐 모았다가 한 번에 보낸다.
export const CHECK_LIMIT = 60;
// 숙제표 쓰기 요청 본문의 상한(바이트). 웹 입구의 기본 1 KiB로는 여러 칸을 모은 정상 요청도 거절된다(2026-09-23
// 교차 검토 F-P2-3: 체크 18칸 1,408바이트가 413). 가장 긴 이름·항목으로 채운 체크 60칸이 약 9.3 KB, 캐릭터 24명 ×
// 레이드 3개가 약 5.3 KB라 여유를 둔 값이며, 이 계산은 시험이 지금 자료로 다시 확인한다.
export const HOMEWORK_BODY_LIMIT = 16 * 1024;
const FILE_LIMIT = 64 * 1024 * 1024;

const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new GuildError(400, 'invalid_request'); };
const unavailable = () => Object.assign(new Error('Homework storage is unavailable'), { code: 'homework_unavailable' });
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 40 &&
  value === value.normalize('NFC').trim() && /^[가-힣A-Za-z0-9 ·-]+$/u.test(value);
const userKey = value => (typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : invalid());

// 화면이 보내온 캐릭터 한 줄. 이름·서버·직업·레벨은 원정대 조회 값을 그대로 돌려받는다.
function validCharacter(entry) {
  return object(entry) && typeof entry.characterName === 'string' && normalizeCharacter(entry.characterName) === entry.characterName &&
    label(entry.serverName) && label(entry.characterClass) &&
    typeof entry.itemLevel === 'number' && Number.isFinite(entry.itemLevel) && entry.itemLevel > 0 && entry.itemLevel <= 10000 &&
    Array.isArray(entry.raids) && entry.raids.length <= RAID_LIMIT && new Set(entry.raids).size === entry.raids.length &&
    entry.raids.every(id => typeof id === 'string' && findRaid(id) !== null && entry.itemLevel >= findRaid(id).ilvl);
}

// 레이드 이름에는 쉼표가 들어가기도 해서(「3막: 칠흑, 폭풍의 밤」) 목록을 JSON으로 적는다.
// 쉼표로 이어 두었던 예전 줄도 그대로 읽고, 어느 쪽이든 지금 자료에 없는 이름은 버린다.
// 고른 순서와 상관없이 늘 골드가 큰 순서로 적고 읽어서, 예전에 저장한 줄도 바로 정렬되어 보인다.
const writeRaids = (raids) => JSON.stringify(sortRaids(raids));

// 예전 줄은 레이드를 쉼표로 이었으므로 이름 안의 쉼표에서도 잘려 있다. 앞에서부터, 다시 이었을 때 지금 자료의
// 레이드가 되는 가장 긴 조각 묶음을 한 레이드로 되살리고, 끝내 맞는 레이드가 없는 조각만 버린다.
function splitLegacyRaids(value) {
  const pieces = value.split(',');
  const ids = [];
  for (let start = 0; start < pieces.length;) {
    let end = pieces.length;
    while (end > start && !findRaid(pieces.slice(start, end).join(','))) end -= 1;
    if (end === start) { start += 1; continue; }
    ids.push(pieces.slice(start, end).join(','));
    start = end;
  }
  return ids;
}

const readRaids = (value) => {
  if (typeof value !== 'string' || !value) return [];
  let parts;
  if (value.startsWith('[')) {
    try { parts = JSON.parse(value); } catch { return []; }
  } else parts = splitLegacyRaids(value);
  return Array.isArray(parts) ? sortRaids(parts) : [];
};

const itemMax = (scope, itemId) => {
  const known = (scope === 'daily' ? DAILY : WEEKLY).find(item => item.id === itemId);
  if (known) return known.max;
  // 주간 레이드는 관문과 더보기를 0/1로 적는다. 고른 레이드에 있는 관문인지는 아래에서 확인한다.
  return scope === 'weekly' && /^[^|]+\|[^|]+\|\d{1,2}(\|bonus)?$/u.test(itemId) ? 1 : null;
};

export function createHomeworkStore(path, { now = Date.now, maxFileBytes = FILE_LIMIT } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw unavailable();
  let db;
  try {
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      try { const fd = openSync(path, 'wx', 0o600); closeSync(fd); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).size > maxFileBytes) throw unavailable();
    for (const suffix of ['-journal', '-wal', '-shm']) {
      if (existsSync(path + suffix) && (!lstatSync(path + suffix).isFile() || lstatSync(path + suffix).isSymbolicLink())) throw unavailable();
    }
    db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout=250;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const app = db.prepare('PRAGMA application_id').get().application_id;
    const objects = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()
      .sort((a, b) => a.name.localeCompare(b.name));
    const fresh = version === 0 && app === 0 && objects.length === 0;
    // 처음 만드는 파일이 아니면 우리가 만든 그 스키마여야 한다.
    if (!fresh && !(version === 1 && app === HOMEWORK_APPLICATION_ID && objects.length === 2 &&
      objects[0].type === 'table' && objects[0].name === 'homework_characters' && objects[0].sql === HOMEWORK_CHARACTER_TABLE_SQL &&
      objects[1].type === 'table' && objects[1].name === 'homework_progress' && objects[1].sql === HOMEWORK_PROGRESS_TABLE_SQL)) throw unavailable();
    chmodSync(path, 0o600);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=OFF;');
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    db.exec(`PRAGMA max_page_count=${Math.floor(maxFileBytes / pageSize)};`);
    if (fresh) {
      db.exec('BEGIN IMMEDIATE');
      try { db.exec(`${HOMEWORK_CHARACTER_TABLE_SQL}; ${HOMEWORK_PROGRESS_TABLE_SQL}; PRAGMA application_id=${HOMEWORK_APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw unavailable();
  } catch (error) {
    try { db?.close(); } catch {}
    throw error?.code === 'homework_unavailable' ? error : unavailable();
  }

  let closed = false;
  const open = () => { if (closed) throw unavailable(); };
  const readCharacters = db.prepare('SELECT * FROM homework_characters WHERE user_id=? ORDER BY position');
  const readCharacter = db.prepare('SELECT * FROM homework_characters WHERE user_id=? AND character_name=?');
  const readProgress = db.prepare('SELECT character_name, scope, item_id, value FROM homework_progress WHERE user_id=? AND period=?');
  const insertCharacter = db.prepare(`INSERT INTO homework_characters
    (user_id, character_name, server_name, character_class, item_level, position, raids, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateCharacter = db.prepare(`UPDATE homework_characters SET server_name=?, character_class=?, item_level=?, raids=?, updated_at=?
    WHERE user_id=? AND character_name=?`);
  const clearCharacters = db.prepare('DELETE FROM homework_characters WHERE user_id=?');
  const clearProgress = db.prepare('DELETE FROM homework_progress WHERE user_id=?');
  const dropProgressOf = db.prepare('DELETE FROM homework_progress WHERE user_id=? AND character_name=?');
  const progressNames = db.prepare('SELECT DISTINCT character_name FROM homework_progress WHERE user_id=?');
  const writeProgress = db.prepare(`INSERT INTO homework_progress (user_id, character_name, scope, item_id, period, value, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, character_name, scope, item_id)
    DO UPDATE SET period=excluded.period, value=excluded.value, updated_at=excluded.updated_at`);

  function transaction(action) {
    open();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function board(userId, timestamp) {
    open();
    const periods = { daily: dailyPeriod(timestamp), weekly: weeklyPeriod(timestamp) };
    const progress = new Map();
    for (const scope of ['daily', 'weekly']) {
      for (const row of readProgress.all(userId, periods[scope])) {
        if (row.scope !== scope) continue;
        const entry = progress.get(row.character_name) ?? { daily: {}, weekly: {} };
        entry[scope][row.item_id] = row.value;
        progress.set(row.character_name, entry);
      }
    }
    const characters = readCharacters.all(userId).map(row => {
      const checks = progress.get(row.character_name) ?? { daily: {}, weekly: {} };
      return {
        characterName: row.character_name, serverName: row.server_name, characterClass: row.character_class,
        itemLevel: row.item_level, raids: readRaids(row.raids),
        daily: checks.daily, weekly: checks.weekly,
      };
    });
    return { characters, periods };
  }

  return {
    board(userId, timestamp = now()) {
      if (!integer(timestamp)) invalid();
      return board(userKey(userId), timestamp);
    },

    // 표에 올릴 캐릭터와 레이드 선택을 통째로 바꾼다. 빠진 캐릭터의 체크도 같이 지운다.
    saveCharacters(userId, entries, timestamp = now()) {
      const key = userKey(userId);
      if (!integer(timestamp) || !Array.isArray(entries) || entries.length > CHARACTER_LIMIT) invalid();
      const names = entries.map(entry => (validCharacter(entry) ? entry.characterName.toLowerCase() : invalid()));
      if (new Set(names).size !== names.length) invalid();
      return transaction(() => {
        clearCharacters.run(key);
        const keep = new Set(entries.map(entry => entry.characterName));
        for (const row of progressNames.all(key)) {
          if (!keep.has(row.character_name)) dropProgressOf.run(key, row.character_name);
        }
        entries.forEach((entry, position) => insertCharacter.run(key, entry.characterName, entry.serverName,
          entry.characterClass, entry.itemLevel, position, writeRaids(entry.raids), timestamp));
        return board(key, timestamp);
      });
    },

    // 체크 여러 칸을 한 번에. 값은 0부터 그 항목의 최대 횟수까지이며, 주기가 지난 줄은 새 주기 값으로 덮어쓴다.
    applyChecks(userId, changes, timestamp = now()) {
      const key = userKey(userId);
      if (!integer(timestamp) || !Array.isArray(changes) || !changes.length || changes.length > CHECK_LIMIT) invalid();
      for (const change of changes) {
        if (!object(change) || Object.keys(change).length !== 4 || !['daily', 'weekly'].includes(change.scope) || !integer(change.value) ||
          typeof change.characterName !== 'string' || normalizeCharacter(change.characterName) !== change.characterName ||
          typeof change.itemId !== 'string') invalid();
        const max = itemMax(change.scope, change.itemId);
        if (max === null || change.value > max) invalid();
      }
      return transaction(() => {
        for (const { characterName, scope, itemId, value } of changes) {
          const row = readCharacter.get(key, characterName);
          if (!row) throw new GuildError(409, 'homework_character_missing');
          // 고른 레이드의 관문만 체크할 수 있다. 레이드를 바꾸면 그 레이드 체크는 사라진다.
          if (scope === 'weekly' && !WEEKLY.some(item => item.id === itemId)) {
            const chosen = readRaids(row.raids);
            const parts = itemId.split('|');
            const raid = findRaid(`${parts[0]}|${parts[1]}`);
            const gate = Number(parts[2]);
            if (!raid || !chosen.includes(raidId(raid)) || !integer(gate) || gate >= raid.gates.length) invalid();
          }
          writeProgress.run(key, characterName, scope, itemId, scope === 'daily' ? dailyPeriod(timestamp) : weeklyPeriod(timestamp), value, timestamp);
        }
        return board(key, timestamp);
      });
    },

    // 원정대 조회 결과로 레벨을 맞춘다. 이름이 그대로인 캐릭터의 선택과 체크는 유지한다.
    syncLevels(userId, roster, timestamp = now()) {
      const key = userKey(userId);
      if (!integer(timestamp) || !Array.isArray(roster)) invalid();
      const byName = new Map(roster.filter(entry => typeof entry?.characterName === 'string')
        .map(entry => [entry.characterName.toLowerCase(), entry]));
      return transaction(() => {
        for (const row of readCharacters.all(key)) {
          const fresh = byName.get(row.character_name.toLowerCase());
          if (!fresh || !validCharacter({ ...fresh, raids: [] })) continue;
          if (fresh.itemLevel === row.item_level && fresh.characterClass === row.character_class && fresh.serverName === row.server_name) continue;
          // 레벨이 내려가 못 가는 레이드가 생기면 그 선택만 뺀다.
          const raids = readRaids(row.raids).filter(id => raidsFor(fresh.itemLevel).some(raid => raidId(raid) === id));
          updateCharacter.run(fresh.serverName, fresh.characterClass, fresh.itemLevel, writeRaids(raids), timestamp, key, row.character_name);
        }
        return board(key, timestamp);
      });
    },

    // 홈페이지 탈퇴로 계정이 사라질 때 그 회원의 숙제표도 함께 지운다.
    forget(userId) {
      const key = userKey(userId);
      return transaction(() => {
        clearProgress.run(key);
        clearCharacters.run(key);
        return true;
      });
    },

    close() {
      if (closed) return;
      closed = true;
      try { db.close(); } catch {}
    },
  };
}
