import { randomBytes } from 'node:crypto';
import { GuildError, validCharacter } from './guild-store.js';

export const OWNERSHIP_SCHEMA = `
  CREATE TABLE IF NOT EXISTS character_ownership (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    character_name TEXT NOT NULL, server_name TEXT NOT NULL, character_class TEXT NOT NULL,
    item_level REAL NOT NULL CHECK(item_level>0), guild_name TEXT,
    revision INTEGER NOT NULL CHECK(revision>0), state TEXT NOT NULL CHECK(state IN ('pending','verified')),
    method TEXT CHECK(method IN ('stove','discord')), stove_account_id TEXT, verified_at INTEGER,
    CHECK((state='pending' AND method IS NULL AND stove_account_id IS NULL AND verified_at IS NULL)
      OR (state='verified' AND method IS NOT NULL AND verified_at IS NOT NULL))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS ownership_challenges (
    user_id TEXT PRIMARY KEY REFERENCES character_ownership(user_id) ON DELETE CASCADE,
    session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    code TEXT NOT NULL UNIQUE, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 5)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS ownership_discord_transactions (
    state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES character_ownership(user_id) ON DELETE CASCADE,
    session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    provider_id TEXT NOT NULL, binding_hash TEXT NOT NULL, verifier TEXT NOT NULL,
    revision INTEGER NOT NULL, character_name TEXT NOT NULL, expires_at INTEGER NOT NULL
  ) STRICT;
`;
const key = value => typeof value === 'string' ? value.normalize('NFC').toLowerCase() : '';
const conflict = () => { throw new GuildError(409, 'ownership_state_changed'); };

export function createOwnershipStore(db, transaction) {
  const row = userId => db.prepare('SELECT * FROM character_ownership WHERE user_id=?').get(userId);
  const active = userId => db.prepare('SELECT 1 FROM users WHERE id=? AND NOT EXISTS(SELECT 1 FROM deletion_intents WHERE user_id=users.id)').get(userId);
  function requireSession(userId, sessionHash, timestamp) {
    if (!active(userId) || !db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?').get(sessionHash, userId, timestamp)) {
      throw new GuildError(401, 'login_required');
    }
  }
  function summary(userId) {
    const value = active(userId) && row(userId);
    if (!value) return { state: 'none', revision: 0, character: null, method: null, verifiedAt: null };
    return { state: value.state, revision: value.revision, character: { characterName: value.character_name,
      serverName: value.server_name, characterClass: value.character_class, itemLevel: value.item_level, guildName: value.guild_name },
    method: value.method, verifiedAt: value.verified_at };
  }
  function state(userId, timestamp, sessionHash) {
    const value = summary(userId);
    const challenge = sessionHash && value.state === 'pending' && db.prepare('SELECT * FROM ownership_challenges WHERE user_id=? AND session_hash=?').get(userId, sessionHash);
    return { ...value, challenge: challenge && challenge.expires_at > timestamp && challenge.attempts < 5 ? {
      code: challenge.code, expiresAt: challenge.expires_at, reissueAt: challenge.issued_at + 60000, attemptsRemaining: 5 - challenge.attempts,
    } : null };
  }
  function mutable(userId) {
    if (db.prepare("SELECT 1 FROM guild_memberships WHERE user_id=? AND status='approved'").get(userId)) throw new GuildError(409, 'already_approved');
  }
  function issue(userId, sessionHash, timestamp) {
    const code = `PG-${randomBytes(12).toString('hex').toUpperCase()}`;
    db.prepare(`INSERT INTO ownership_challenges VALUES (?,?,?,?,?,0)
      ON CONFLICT(user_id) DO UPDATE SET session_hash=excluded.session_hash, code=excluded.code,
      issued_at=excluded.issued_at, expires_at=excluded.expires_at, attempts=0`).run(userId, sessionHash, code, timestamp, timestamp + 1800000);
    db.prepare('DELETE FROM ownership_discord_transactions WHERE user_id=?').run(userId);
  }
  function current(userId, sessionHash, revision, timestamp) {
    requireSession(userId, sessionHash, timestamp); mutable(userId);
    const value = row(userId);
    if (!value || value.revision !== revision || value.state !== 'pending') conflict();
    return value;
  }
  function matches(userId, characterName) {
    const value = active(userId) && row(userId);
    return Boolean(value?.state === 'verified' && key(value.character_name) === key(characterName));
  }
  function checkSelection(userId, sessionHash, timestamp) {
    requireSession(userId, sessionHash, timestamp); mutable(userId);
    const challenge = db.prepare('SELECT issued_at FROM ownership_challenges WHERE user_id=?').get(userId);
    if (challenge && challenge.issued_at + 60000 > timestamp) throw new GuildError(429, 'verification_cooldown');
    return row(userId)?.revision || 0;
  }
  return {
    state, summary, matches, checkSelection,
    select(userId, sessionHash, profile, expectedRevision, timestamp) {
      return transaction(() => {
        checkSelection(userId, sessionHash, timestamp);
        const old = row(userId);
        if ((old?.revision || 0) !== expectedRevision) conflict();
        if (!validCharacter(profile?.characterName) || !Number.isFinite(profile.itemLevel) || profile.itemLevel <= 0) throw new GuildError(400, 'invalid_request');
        db.prepare(`INSERT INTO character_ownership VALUES (?,?,?,?,?,?,1,'pending',NULL,NULL,NULL)
          ON CONFLICT(user_id) DO UPDATE SET character_name=excluded.character_name, server_name=excluded.server_name,
          character_class=excluded.character_class, item_level=excluded.item_level, guild_name=excluded.guild_name,
          revision=revision+1,state='pending',method=NULL,stove_account_id=NULL,verified_at=NULL`)
          .run(userId, profile.characterName, profile.serverName, profile.characterClass, profile.itemLevel, profile.guildName || null);
        issue(userId, sessionHash, timestamp);
        return state(userId, timestamp, sessionHash);
      });
    },
    renew(userId, sessionHash, revision, timestamp) {
      return transaction(() => {
        current(userId, sessionHash, revision, timestamp);
        const previous = db.prepare('SELECT issued_at FROM ownership_challenges WHERE user_id=?').get(userId);
        if (previous && previous.issued_at + 60000 > timestamp) throw new GuildError(429, 'verification_cooldown');
        db.prepare('UPDATE character_ownership SET revision=revision+1 WHERE user_id=?').run(userId);
        issue(userId, sessionHash, timestamp); return state(userId, timestamp, sessionHash);
      });
    },
    beginStove(userId, sessionHash, revision, timestamp) {
      return transaction(() => {
        const value = current(userId, sessionHash, revision, timestamp);
        const challenge = db.prepare('SELECT * FROM ownership_challenges WHERE user_id=? AND session_hash=?').get(userId, sessionHash);
        if (!challenge) throw new GuildError(409, 'verification_required');
        if (challenge.expires_at <= timestamp) throw new GuildError(409, 'verification_expired');
        if (challenge.attempts >= 5) throw new GuildError(429, 'verification_locked');
        db.prepare('UPDATE ownership_challenges SET attempts=attempts+1 WHERE user_id=?').run(userId);
        return { userId, sessionHash, revision, characterName: value.character_name, code: challenge.code, expiresAt: challenge.expires_at };
      });
    },
    finishStove(proof, result, timestamp) {
      return transaction(() => {
        const value = current(proof.userId, proof.sessionHash, proof.revision, timestamp);
        const challenge = db.prepare('SELECT code,expires_at FROM ownership_challenges WHERE user_id=? AND session_hash=?').get(proof.userId, proof.sessionHash);
        if (!challenge || challenge.code !== proof.code || challenge.expires_at <= timestamp || proof.expiresAt <= timestamp ||
          key(value.character_name) !== key(proof.characterName) || key(result?.characterName) !== key(proof.characterName) ||
          typeof result?.stoveAccountId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(result.stoveAccountId)) conflict();
        db.prepare("UPDATE character_ownership SET state='verified',method='stove',stove_account_id=?,verified_at=?,revision=revision+1 WHERE user_id=?")
          .run(result.stoveAccountId, timestamp, proof.userId);
        db.prepare('DELETE FROM ownership_challenges WHERE user_id=?').run(proof.userId);
        db.prepare('DELETE FROM ownership_discord_transactions WHERE user_id=?').run(proof.userId);
        return state(proof.userId, timestamp, proof.sessionHash);
      });
    },
    beginDiscord({ stateHash, userId, sessionHash, bindingHash, verifier, revision }, timestamp) {
      return transaction(() => {
        const value = current(userId, sessionHash, revision, timestamp);
        const identity = db.prepare('SELECT provider,provider_id FROM users WHERE id=?').get(userId);
        if (identity.provider !== 'discord') throw new GuildError(403, 'automatic_discord_required');
        db.prepare('DELETE FROM ownership_discord_transactions WHERE expires_at<=? OR user_id=?').run(timestamp, userId);
        if (db.prepare('SELECT COUNT(*) AS count FROM ownership_discord_transactions').get().count >= 1000) throw new GuildError(429, 'rate_limited');
        db.prepare('INSERT INTO ownership_discord_transactions VALUES (?,?,?,?,?,?,?,?,?)')
          .run(stateHash, userId, sessionHash, identity.provider_id, bindingHash, verifier, revision, value.character_name, timestamp + 300000);
      });
    },
    consumeDiscord(stateHash, bindingHash, sessionHash, timestamp) {
      return transaction(() => {
        const value = db.prepare(`SELECT user_id AS userId,session_hash AS sessionHash,provider_id AS providerId,
          verifier,revision,character_name AS characterName,expires_at AS expiresAt FROM ownership_discord_transactions
          WHERE state_hash=? AND binding_hash=? AND session_hash=? AND expires_at>?`).get(stateHash, bindingHash, sessionHash, timestamp);
        if (value) db.prepare('DELETE FROM ownership_discord_transactions WHERE state_hash=?').run(stateHash);
        return value;
      });
    },
    finishDiscord(proof, timestamp) {
      return transaction(() => {
        const value = current(proof.userId, proof.sessionHash, proof.revision, timestamp);
        if (proof.expiresAt <= timestamp || key(value.character_name) !== key(proof.characterName) ||
          db.prepare('SELECT provider_id FROM users WHERE id=?').get(proof.userId)?.provider_id !== proof.providerId) conflict();
        db.prepare("UPDATE character_ownership SET state='verified',method='discord',stove_account_id=NULL,verified_at=?,revision=revision+1 WHERE user_id=?")
          .run(timestamp, proof.userId);
        db.prepare('DELETE FROM ownership_challenges WHERE user_id=?').run(proof.userId);
        return state(proof.userId, timestamp, proof.sessionHash);
      });
    },
  };
}
