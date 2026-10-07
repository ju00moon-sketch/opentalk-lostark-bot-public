import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, lstatSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { formatPreviousEntry, formatWelcome, requireWelcome, welcomeId, welcomeName, welcomeRoomName } from './welcome.js';

export class WelcomeStore {
  constructor(path) {
    if (path !== ':memory:') {
      path = resolve(path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      requireWelcome(!lstatSync(dirname(path)).isSymbolicLink(), 'STATE_DIRECTORY_SYMLINK');
      requireWelcome(!existsSync(path) || !lstatSync(path).isSymbolicLink(), 'STATE_FILE_SYMLINK');
    }
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS configuration (singleton INTEGER PRIMARY KEY CHECK(singleton=1), bot_id TEXT NOT NULL, rooms TEXT NOT NULL, baseline_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS members (room_id TEXT NOT NULL, member_id TEXT NOT NULL, name TEXT NOT NULL, observed_at INTEGER NOT NULL, PRIMARY KEY(room_id,member_id));
      CREATE TABLE IF NOT EXISTS name_history (room_id TEXT NOT NULL, member_id TEXT NOT NULL, name TEXT NOT NULL, observed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (room_id TEXT NOT NULL, event_id TEXT NOT NULL, kind TEXT NOT NULL, occurred_at INTEGER NOT NULL, PRIMARY KEY(room_id,event_id));
      CREATE TABLE IF NOT EXISTS welcomes (room_id TEXT NOT NULL, event_id TEXT NOT NULL, member_id TEXT NOT NULL, name TEXT NOT NULL, previous_name TEXT, occurred_at INTEGER NOT NULL, status TEXT NOT NULL, previous_at INTEGER, PRIMARY KEY(room_id,event_id,member_id));
      CREATE TABLE IF NOT EXISTS entries (room_id TEXT NOT NULL, member_id TEXT NOT NULL, event_id TEXT NOT NULL, name TEXT NOT NULL, occurred_at INTEGER NOT NULL, PRIMARY KEY(room_id,member_id,event_id));
      CREATE INDEX IF NOT EXISTS entries_by_member ON entries(room_id,member_id,occurred_at DESC);
      CREATE TABLE IF NOT EXISTS welcome_messages (room_id TEXT NOT NULL, event_id TEXT NOT NULL, sequence INTEGER NOT NULL, member_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(room_id,event_id,sequence));`);
    if (!this.db.prepare('PRAGMA table_info(welcomes)').all().some((column) => column.name === 'previous_at'))
      this.db.exec('ALTER TABLE welcomes ADD COLUMN previous_at INTEGER');
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  initialized() { return !!this.db.prepare('SELECT 1 FROM configuration').get(); }
  baseline(botId, rooms, at, seeds = []) {
    botId = welcomeId(botId);
    rooms = [...new Set(rooms.map(welcomeId))].sort();
    requireWelcome(rooms.length > 0 && Number.isSafeInteger(at), 'INVALID_BASELINE');
    this.transaction(() => {
      if (this.db.prepare('SELECT * FROM configuration').get()) this.assertBaseline(botId, rooms);
      else {
        this.db.prepare('INSERT INTO configuration VALUES (1,?,?,?)').run(botId, JSON.stringify(rooms), at);
        const identities = new Set();
        for (const seed of seeds) {
          const roomId = welcomeId(seed.roomId);
          const memberId = welcomeId(seed.memberId);
          requireWelcome(rooms.includes(roomId) && !identities.has(`${roomId}:${memberId}`), 'INVALID_BASELINE_MEMBER');
          identities.add(`${roomId}:${memberId}`);
          if (memberId !== botId) this.updateName(roomId, memberId, welcomeName(seed.name), at);
        }
      }
    });
  }
  assertBaseline(botId, rooms) {
    const config = this.db.prepare('SELECT * FROM configuration').get();
    requireWelcome(config && config.bot_id === botId && config.rooms === JSON.stringify([...new Set(rooms)].sort()), 'BASELINE_REQUIRED_OR_CHANGED');
    return config;
  }
  hasEvent(roomId, eventId) {
    return !!this.db.prepare('SELECT 1 FROM events WHERE room_id=? AND event_id=?').get(roomId, eventId);
  }
  hasUnconfirmed() {
    return !!this.db.prepare("SELECT 1 FROM welcomes WHERE status IN ('reserved','uncertain') LIMIT 1").get();
  }
  member(roomId, memberId) {
    return this.db.prepare('SELECT * FROM members WHERE room_id=? AND member_id=?').get(roomId, memberId);
  }
  previousName(roomId, memberId, name, at) {
    return this.db.prepare(`SELECT name FROM name_history
      WHERE room_id=? AND member_id=? AND name<>? AND observed_at<=?
      ORDER BY observed_at DESC,rowid DESC LIMIT 1`).get(roomId, memberId, name, at)?.name ?? null;
  }
  previousEntry(roomId, memberId, at, eventId) {
    const row = this.db.prepare(`SELECT name,occurred_at,event_id FROM entries
      WHERE room_id=? AND member_id=? AND (occurred_at<? OR
        (occurred_at=? AND CAST(event_id AS INTEGER)<CAST(? AS INTEGER)))
      ORDER BY occurred_at DESC,CAST(event_id AS INTEGER) DESC LIMIT 1`)
      .get(roomId, memberId, at, at, eventId);
    return row ? { name: row.name, at: row.occurred_at, eventId: row.event_id } : null;
  }
  updateName(roomId, memberId, name, at) {
    const before = this.member(roomId, memberId);
    if (!before || before.name !== name)
      this.db.prepare('INSERT INTO name_history VALUES (?,?,?,?)').run(roomId, memberId, name, at);
    if (before && before.observed_at > at) return;
    this.db.prepare(`INSERT INTO members VALUES (?,?,?,?) ON CONFLICT(room_id,member_id)
      DO UPDATE SET name=excluded.name,observed_at=excluded.observed_at`).run(roomId, memberId, name, at);
  }
  observe(event, name) {
    this.transaction(() => {
      if (this.hasEvent(event.roomId, event.eventId)) return;
      this.db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(event.roomId, event.eventId, 'message', event.at);
      this.updateName(event.roomId, event.actorId, name, event.observedAt);
    });
  }
  prepareJoin(event, members, status, roomName) {
    return this.transaction(() => {
      requireWelcome(status === 'reserved' || status === 'simulated', 'INVALID_WELCOME_STATUS');
      if (this.hasEvent(event.roomId, event.eventId)) return null;
      if (status === 'reserved') requireWelcome(!this.hasUnconfirmed(), 'UNCONFIRMED_REPLY_REQUIRES_REVIEW');
      roomName = welcomeRoomName(roomName);
      this.db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(event.roomId, event.eventId, 'join', event.at);
      const results = [];
      let sequence = 0;
      for (const member of members) {
        // Only genuine entry feeds populate this history. Baselines and current
        // profile lookups cannot manufacture or replace an entry snapshot.
        const previousEntry = this.previousEntry(event.roomId, member.id, event.at, event.eventId);
        const texts = [formatWelcome(member.name, roomName)];
        if (previousEntry) texts.push(formatPreviousEntry(previousEntry));
        const messages = texts.map((text) => ({ sequence: sequence++, text }));
        this.db.prepare(`INSERT INTO welcomes
          (room_id,event_id,member_id,name,previous_name,occurred_at,status,previous_at) VALUES (?,?,?,?,?,?,?,?)`)
          .run(event.roomId, event.eventId, member.id, member.name, previousEntry?.name ?? null,
            event.at, status, previousEntry?.at ?? null);
        this.db.prepare('INSERT INTO entries VALUES (?,?,?,?,?)')
          .run(event.roomId, member.id, event.eventId, member.name, event.at);
        for (const message of messages) this.db.prepare('INSERT INTO welcome_messages VALUES (?,?,?,?,?,?)')
          .run(event.roomId, event.eventId, message.sequence, member.id, message.text, status);
        this.updateName(event.roomId, member.id, member.name, event.at);
        this.updateName(event.roomId, member.id, member.latestName, member.latestAt ?? event.at);
        results.push({ id: member.id, name: member.name, previousEntry, messages });
      }
      return results;
    });
  }
  welcomeStatus(roomId, eventId, memberId) {
    return this.db.prepare('SELECT status FROM welcomes WHERE room_id=? AND event_id=? AND member_id=?')
      .get(roomId, eventId, memberId)?.status;
  }
  finishMessage(roomId, eventId, sequence, status) {
    requireWelcome(['confirmed_in_iris', 'uncertain'].includes(status), 'INVALID_WELCOME_STATUS');
    this.transaction(() => {
      const message = this.db.prepare(`UPDATE welcome_messages SET status=?
        WHERE room_id=? AND event_id=? AND sequence=? AND status='reserved' RETURNING member_id`)
        .get(status, roomId, eventId, sequence);
      requireWelcome(message, 'WELCOME_MESSAGE_NOT_RESERVED');
      const rows = this.db.prepare('SELECT status FROM welcome_messages WHERE room_id=? AND event_id=? AND member_id=?')
        .all(roomId, eventId, message.member_id);
      const memberStatus = rows.some((row) => row.status === 'uncertain') ? 'uncertain'
        : rows.every((row) => row.status === 'confirmed_in_iris') ? 'confirmed_in_iris' : 'reserved';
      this.db.prepare('UPDATE welcomes SET status=? WHERE room_id=? AND event_id=? AND member_id=?')
        .run(memberStatus, roomId, eventId, message.member_id);
    });
  }
  prune(now) {
    const cutoff = now - 30 * 86_400_000;
    this.transaction(() => {
      this.db.prepare("DELETE FROM welcomes WHERE occurred_at<? AND status NOT IN ('reserved','uncertain')").run(cutoff);
      this.db.prepare(`DELETE FROM welcome_messages WHERE NOT EXISTS
        (SELECT 1 FROM welcomes WHERE welcomes.room_id=welcome_messages.room_id
          AND welcomes.event_id=welcome_messages.event_id AND welcomes.member_id=welcome_messages.member_id)`).run();
      this.db.prepare(`DELETE FROM events WHERE occurred_at<? AND NOT EXISTS
        (SELECT 1 FROM welcomes WHERE welcomes.room_id=events.room_id AND welcomes.event_id=events.event_id)`).run(cutoff);
      // Keep the latest actual entry indefinitely, independently of send logs.
      // Recent entries also handle feeds delivered out of chronological order.
      this.db.prepare(`DELETE FROM entries WHERE occurred_at<? AND EXISTS
        (SELECT 1 FROM entries newer WHERE newer.room_id=entries.room_id AND newer.member_id=entries.member_id
          AND (newer.occurred_at>entries.occurred_at OR (newer.occurred_at=entries.occurred_at
            AND CAST(newer.event_id AS INTEGER)>CAST(entries.event_id AS INTEGER))))`).run(cutoff);
    });
  }
  close() { this.db.close(); }
}
