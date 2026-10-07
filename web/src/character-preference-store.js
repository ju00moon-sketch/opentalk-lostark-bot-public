import { createHash } from 'node:crypto';
import { GuildError } from './guild-store.js';
import { normalizeCharacter } from './character-profile.js';

export const CHARACTER_PREFERENCE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS user_character_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    anchor_fingerprint TEXT NOT NULL CHECK(length(anchor_fingerprint)=64 AND anchor_fingerprint NOT GLOB '*[^0-9a-f]*'),
    character_name TEXT NOT NULL, server_name TEXT NOT NULL, character_class TEXT NOT NULL,
    item_level REAL NOT NULL CHECK(item_level>0 AND item_level<=10000),
    revision INTEGER NOT NULL CHECK(revision>0 AND revision<=9007199254740991),
    selected_at INTEGER NOT NULL CHECK(selected_at>=0),
    roster_checked_at INTEGER NOT NULL CHECK(roster_checked_at>=0 AND roster_checked_at<=selected_at)
  ) STRICT;
`;

const integer=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const invalid=()=>{throw new GuildError(400,'invalid_request');};
const changed=()=>{throw new GuildError(409,'member_character_changed');};
const key=value=>normalizeCharacter(value)?.toLowerCase()||'';
const label=value=>typeof value==='string'&&value.length>0&&value.length<=40&&
  value===value.normalize('NFC').trim()&&/^[가-힣A-Za-z0-9 ·-]+$/u.test(value);

function validProfile(profile) {
  return object(profile)&&Object.keys(profile).length===4&&
    ['characterName','serverName','characterClass','itemLevel'].every(field=>Object.hasOwn(profile,field))&&
    typeof profile.characterName==='string'&&normalizeCharacter(profile.characterName)===profile.characterName&&label(profile.serverName)&&label(profile.characterClass)&&
    typeof profile.itemLevel==='number'&&Number.isFinite(profile.itemLevel)&&profile.itemLevel>0&&profile.itemLevel<=10000;
}

/** Account convenience only: this store never changes ownership or membership. */
export function createCharacterPreferenceStore(db,transaction) {
  function capture(userId,sessionHash,timestamp) {
    if(!integer(timestamp))invalid();
    if(typeof sessionHash!=='string'||!/^[0-9a-f]{64}$/.test(sessionHash)||!db.prepare(`
      SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>?
      AND NOT EXISTS(SELECT 1 FROM deletion_intents WHERE user_id=u.id)`).get(sessionHash,userId,timestamp)) {
      throw new GuildError(401,'login_required');
    }
    const member=db.prepare('SELECT * FROM guild_memberships WHERE user_id=?').get(userId);
    if(member?.status!=='approved')throw new GuildError(403,'approval_required');
    if(!integer(member.revision,1))changed();
    const memberName=normalizeCharacter(member.character_name);
    if(!memberName)throw new GuildError(409,'anchor_required');
    const ownership=db.prepare('SELECT * FROM character_ownership WHERE user_id=?').get(userId);
    let anchor,proof;
    if(ownership){
      const name=normalizeCharacter(ownership.character_name);
      if(ownership.state!=='verified'||!name||key(name)!==key(memberName)||
        !label(ownership.server_name)||!integer(ownership.revision,1)||!integer(ownership.verified_at)||
        !['stove','discord'].includes(ownership.method))changed();
      anchor={source:'verified',characterName:name,serverName:ownership.server_name};
      proof=[ownership.revision,ownership.method,ownership.verified_at,ownership.server_name];
    }else{
      anchor={source:'legacy-approved',characterName:memberName};
      proof=[member.applied_at,member.reviewed_at];
    }
    // Membership revision is a separate CAS value: a role change alone need not
    // erase the preference. A new application or ownership proof changes the pin.
    const anchorFingerprint=createHash('sha256').update(JSON.stringify([
      'representative-v1',userId,anchor.source,key(anchor.characterName),member.applied_at,member.reviewed_at,...proof,
    ])).digest('hex');
    const preference=db.prepare('SELECT * FROM user_character_preferences WHERE user_id=?').get(userId);
    const preferenceRevision=preference?.revision??0;
    if(!integer(preferenceRevision,preference?1:0))changed();
    let selected=null;
    if(preference?.anchor_fingerprint===anchorFingerprint){
      selected={characterName:preference.character_name,serverName:preference.server_name,
        characterClass:preference.character_class,itemLevel:preference.item_level};
      if(!validProfile(selected))changed();
    }
    return {userId,sessionHash,anchor,anchorFingerprint,membershipRevision:member.revision,preferenceRevision,selected};
  }

  function assertCurrent(snapshot,timestamp) {
    if(!object(snapshot))changed();
    const current=capture(snapshot.userId,snapshot.sessionHash,timestamp);
    if(!integer(snapshot.membershipRevision,1)||!integer(snapshot.preferenceRevision)||
      current.anchorFingerprint!==snapshot.anchorFingerprint||current.membershipRevision!==snapshot.membershipRevision||
      current.preferenceRevision!==snapshot.preferenceRevision)changed();
    return current;
  }

  function save(snapshot,input,timestamp) {
    return transaction(()=>{
      const current=assertCurrent(snapshot,timestamp);
      if(!object(input)||Object.keys(input).length!==2||!validProfile(input.character)||
        !integer(input.rosterCheckedAt)||input.rosterCheckedAt>timestamp)invalid();
      if(current.preferenceRevision===Number.MAX_SAFE_INTEGER)changed();
      const profile=input.character;
      // The HTTP service must select this profile from its validated official
      // siblings response. Names sent by the browser alone are not candidates.
      db.prepare(`INSERT INTO user_character_preferences VALUES(?,?,?,?,?,?,1,?,?)
        ON CONFLICT(user_id) DO UPDATE SET anchor_fingerprint=excluded.anchor_fingerprint,
        character_name=excluded.character_name,server_name=excluded.server_name,
        character_class=excluded.character_class,item_level=excluded.item_level,
        revision=revision+1,selected_at=excluded.selected_at,roster_checked_at=excluded.roster_checked_at`)
        .run(current.userId,current.anchorFingerprint,profile.characterName,profile.serverName,profile.characterClass,
          profile.itemLevel,timestamp,input.rosterCheckedAt);
      return capture(current.userId,current.sessionHash,timestamp);
    });
  }
  return {capture,assertCurrent,save};
}
