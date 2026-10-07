import { GuildError } from './guild-store.js';
import { normalizeNickname, normalizeCharacter } from './character-profile.js';

export const SIGNUP_SCHEMA = `
  CREATE TABLE IF NOT EXISTS kakao_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('pending', 'legacy', 'complete')),
    nickname TEXT,
    character_name TEXT,
    server_name TEXT,
    character_class TEXT,
    item_level REAL,
    completed_at INTEGER,
    CHECK ((state='complete' AND nickname IS NOT NULL AND character_name IS NOT NULL AND server_name IS NOT NULL
      AND character_class IS NOT NULL AND item_level IS NOT NULL AND item_level>0 AND completed_at IS NOT NULL)
      OR (state IN ('pending', 'legacy') AND nickname IS NULL AND character_name IS NULL AND server_name IS NULL
      AND character_class IS NULL AND item_level IS NULL AND completed_at IS NULL))
  ) STRICT;
`;

export function createSignupStore(db, transaction) {
  function state(userId) {
    const row = db.prepare(`SELECT state, character_name AS characterName, server_name AS serverName,
      character_class AS characterClass, item_level AS itemLevel FROM kakao_profiles WHERE user_id=?`).get(userId);
    if (!row) return null;
    const { state, ...character } = row;
    return { state, character: state === 'complete' ? character : null };
  }
  return {
    state,
    complete(userId, nickname, profile, timestamp) {
      return transaction(() => {
        if (normalizeNickname(nickname) !== nickname || normalizeCharacter(profile?.characterName) !== profile?.characterName ||
            !Number.isFinite(profile?.itemLevel) || profile.itemLevel <= 0) throw new GuildError(400, 'invalid_request');
        const user = db.prepare(`SELECT id FROM users WHERE id=? AND provider='kakao'
          AND NOT EXISTS (SELECT 1 FROM deletion_intents WHERE user_id=users.id)`).get(userId);
        if (!user) throw new GuildError(401, 'login_required');
        const updated = db.prepare(`UPDATE kakao_profiles SET state='complete', nickname=?, character_name=?, server_name=?,
          character_class=?, item_level=?, completed_at=? WHERE user_id=? AND state IN ('pending','legacy')`)
          .run(nickname, profile.characterName, profile.serverName, profile.characterClass, profile.itemLevel, timestamp, userId);
        if (!updated.changes) throw new GuildError(409, 'signup_complete');
        db.prepare('UPDATE users SET display_name=?, updated_at=? WHERE id=?').run(nickname, timestamp, userId);
        return state(userId);
      });
    },
  };
}
