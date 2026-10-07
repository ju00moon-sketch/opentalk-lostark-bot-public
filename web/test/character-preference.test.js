import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.js';
import { verifyOwnership } from './helpers/access.js';
import { assignOwner } from '../src/guild-owner.js';
import { preserveSchedule } from '../src/schedule-import.js';

const now=1790000000000;
const digest=value=>createHash('sha256').update(value).digest('hex');
const candidate={characterName:'다른서버바드',serverName:'카마인',characterClass:'바드',itemLevel:1720.83};
const changed={status:409,code:'member_character_changed'};

async function setup(t) {
  const directory=await mkdtemp(join(tmpdir(),'character-preference-test-'));
  const path=join(directory,'auth.sqlite'),store=createStore(path),db=new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON');
  t.after(async()=>{db.close();store.close();assert(basename(directory).startsWith('character-preference-test-'));await rm(directory,{recursive:true,force:true});});
  const accounts={};
  for(const [i,name] of ['owner','member','other','kakao'].entries()){
    const token=`fixture-${name}`,tokenHash=digest(token);
    store.createSession({provider:name==='kakao'?'kakao':'discord',providerId:String(70000+i),displayName:name,
      tokenHash,expiresAt:now+86400000,epoch:0},now);
    accounts[name]={...store.getSession(tokenHash,now),token,tokenHash};
  }
  store.guild.bootstrapOwner(accounts.owner.id,now);
  verifyOwnership(store,accounts.member,'인증한바드',now);
  store.guild.apply(accounts.member.id,'인증한바드',now);
  store.guild.review(accounts.owner.id,accounts.member.id,'approved',1,now);
  return {path,store,db,accounts,prefs:store.characterPreferences,
    capture:()=>store.characterPreferences.capture(accounts.member.id,accounts.member.tokenHash,now)};
}

test('a representative is separate from ownership, approval and signup and returns only public profile fields',async t=>{
  const h=await setup(t),{store,accounts,prefs}=h;
  const before={ownership:store.ownership.summary(accounts.member.id),guild:store.guild.state(accounts.member.id),signup:store.signup.state(accounts.member.id)};
  const snapshot=h.capture();
  assert.equal(snapshot.anchor.source,'verified');assert.equal(snapshot.anchor.characterName,'인증한바드');
  assert.equal(snapshot.sessionHash,accounts.member.tokenHash);assert.equal(snapshot.selected,null);assert.equal(snapshot.preferenceRevision,0);
  const saved=prefs.save(snapshot,{character:candidate,rosterCheckedAt:now},now);
  assert.deepEqual(saved.selected,candidate);assert.equal(saved.preferenceRevision,1);
  assert.deepEqual({ownership:store.ownership.summary(accounts.member.id),guild:store.guild.state(accounts.member.id),signup:store.signup.state(accounts.member.id)},before);
  assert.deepEqual(h.capture().selected,candidate);
});

test('only a live session for the approved member can capture or use a saved snapshot',async t=>{
  const h=await setup(t),a=h.accounts;
  assert.throws(()=>h.prefs.capture(a.member.id,a.other.tokenHash,now),{status:401,code:'login_required'});
  assert.throws(()=>h.prefs.capture(a.other.id,a.other.tokenHash,now),{status:403,code:'approval_required'});
  assert.throws(()=>h.prefs.capture(a.member.id,a.member.tokenHash,now+86400000),{status:401,code:'login_required'});
  const snapshot=h.capture();h.store.deleteSession(a.member.tokenHash);
  assert.throws(()=>h.prefs.assertCurrent(snapshot,now),{status:401,code:'login_required'});
  assert.throws(()=>h.prefs.save(snapshot,{character:candidate,rosterCheckedAt:now},now),{status:401,code:'login_required'});
});

test('revocation and account deletion intent stop delayed selection writes',async t=>{
  const h=await setup(t),snapshot=h.capture(),a=h.accounts;
  h.store.guild.review(a.owner.id,a.member.id,'revoked',snapshot.membershipRevision,now+1);
  assert.throws(()=>h.prefs.save(snapshot,{character:candidate,rosterCheckedAt:now},now+1),{status:403,code:'approval_required'});
  h.db.prepare("UPDATE guild_memberships SET status='approved' WHERE user_id=?").run(a.member.id);
  const restored=h.capture();h.store.beginDeletion(h.store.getAccount(a.member.tokenHash,now),now);
  assert.throws(()=>h.prefs.save(restored,{character:candidate,rosterCheckedAt:now},now),{status:401,code:'login_required'});
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM user_character_preferences').get().n,0);
});

test('preference and membership revisions prevent stale tab writes while roles preserve an existing choice',async t=>{
  const h=await setup(t),first=h.capture(),second=h.capture();
  h.prefs.save(first,{character:candidate,rosterCheckedAt:now},now);
  assert.throws(()=>h.prefs.save(second,{character:{...candidate,characterName:'다른대표'},rosterCheckedAt:now},now),changed);
  const before=h.capture();h.store.guild.setRole(h.accounts.owner.id,h.accounts.member.id,'admin',before.membershipRevision,now);
  assert.throws(()=>h.prefs.assertCurrent(before,now),changed);
  const after=h.capture();assert.equal(after.anchorFingerprint,before.anchorFingerprint);assert.deepEqual(after.selected,candidate);
});

test('an anchor change hides the previous choice but preserves its real revision for compare-and-swap',async t=>{
  const h=await setup(t);h.prefs.save(h.capture(),{character:candidate,rosterCheckedAt:now},now);
  const old=h.capture();h.db.prepare('UPDATE character_ownership SET revision=revision+1 WHERE user_id=?').run(h.accounts.member.id);
  assert.throws(()=>h.prefs.assertCurrent(old,now),changed);
  const current=h.capture();assert.equal(current.selected,null);assert.equal(current.preferenceRevision,1);
  assert.notEqual(current.anchorFingerprint,old.anchorFingerprint);
  assert.equal(h.prefs.save(current,{character:candidate,rosterCheckedAt:now},now).preferenceRevision,2);
});

test('legacy approved names work without creating proof, but blank names pending proof and mismatches do not',async t=>{
  const h=await setup(t),id=h.accounts.member.id;
  h.db.prepare('DELETE FROM character_ownership WHERE user_id=?').run(id);
  const legacy=h.capture();assert.equal(legacy.anchor.source,'legacy-approved');assert.equal(legacy.anchor.characterName,'인증한바드');
  h.prefs.save(legacy,{character:candidate,rosterCheckedAt:now},now);
  assert.equal(h.store.ownership.summary(id).state,'none');
  assert.throws(()=>h.prefs.capture(h.accounts.owner.id,h.accounts.owner.tokenHash,now),{status:409,code:'anchor_required'});
  h.db.prepare("INSERT INTO character_ownership VALUES (?,?,?,?,?,?,1,'pending',NULL,NULL,NULL)").run(id,'인증한바드','루페온','바드',1740,null);
  assert.throws(()=>h.capture(),changed);
  h.db.prepare("UPDATE character_ownership SET state='verified',method='stove',verified_at=?,character_name='다른캐릭터' WHERE user_id=?").run(now,id);
  assert.throws(()=>h.capture(),changed);
});

test('candidate profile fields and roster timestamps are strictly checked without partial writes',async t=>{
  const h=await setup(t);
  for(const patch of [{characterName:null},{characterName:'<bad>'},{serverName:''},{characterClass:'<script>'},{itemLevel:null},{itemLevel:'1720'},{itemLevel:Infinity},{itemLevel:10001},{extra:'injected'}]){
    assert.throws(()=>h.prefs.save(h.capture(),{character:{...candidate,...patch},rosterCheckedAt:now},now),{status:400,code:'invalid_request'});
  }
  for(const rosterCheckedAt of [null,-1,1.5,now+1,Infinity])
    assert.throws(()=>h.prefs.save(h.capture(),{character:candidate,rosterCheckedAt},now),{status:400,code:'invalid_request'});
  assert.equal(h.capture().preferenceRevision,0);
});

test('account removal cascades its preference but keeps a different member',async t=>{
  const h=await setup(t);h.prefs.save(h.capture(),{character:candidate,rosterCheckedAt:now},now);
  h.db.prepare("INSERT INTO guild_memberships VALUES (?,?,'approved',1,?,?,?)").run(h.accounts.other.id,'다른인증',now,now,h.accounts.owner.id);
  const other=h.prefs.capture(h.accounts.other.id,h.accounts.other.tokenHash,now);
  h.prefs.save(other,{character:{...candidate,characterName:'다른대표'},rosterCheckedAt:now},now);
  h.store.deleteLocalAccount(h.accounts.member.id);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM user_character_preferences').get().n,1);
  assert.equal(h.prefs.capture(h.accounts.other.id,h.accounts.other.tokenHash,now).selected.characterName,'다른대표');
  assert.deepEqual(h.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('schema seven migration is additive and preserves every existing row including schedule revisions',async t=>{
  const h=await setup(t);
  h.db.exec("INSERT INTO guild_schedule_metadata VALUES(1,'기존 일정',1); INSERT INTO guild_schedule_sheets VALUES('sheet','수요일',0,0,'{}');");
  h.db.prepare("INSERT INTO guild_schedule_entries VALUES('sheet','group','{\"A1\":\"기존회원\"}',?,17)").run(h.accounts.member.id);
  h.db.exec('DROP TABLE user_character_preferences; PRAGMA user_version=7;');
  const names=h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
  const rows=()=>Object.fromEntries(names.map(name=>[name,h.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
  const before=rows(),upgraded=createStore(h.path);
  try{assert.equal(h.db.prepare('PRAGMA user_version').get().user_version,8);assert.deepEqual(rows(),before);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM user_character_preferences').get().n,0);assert.deepEqual(h.db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(upgraded.characterPreferences.capture(h.accounts.member.id,h.accounts.member.tokenHash,now).preferenceRevision,0);
  }finally{upgraded.close();}
  assert.deepEqual(preserveSchedule(h.path),{preserved:true,sheets:1,groups:1});
});

test('owner assignment accepts schema eight without changing a chosen representative',async t=>{
  const h=await setup(t);h.prefs.save(h.capture(),{character:candidate,rosterCheckedAt:now},now);
  h.db.prepare("DELETE FROM guild_roles WHERE role='owner'").run();
  assert.equal(assignOwner(h.path,h.accounts.other.id,'discord').assigned,true);
  assert.deepEqual(h.capture().selected,candidate);
});
