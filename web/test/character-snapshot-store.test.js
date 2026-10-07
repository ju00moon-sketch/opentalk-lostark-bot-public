import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCharacterSnapshotStore } from '../src/character-snapshot-store.js';

const at=1790000000000;
const profile=(name='테스트바드',level=1740)=>({profile:{characterName:name,serverName:'루페온',characterClass:'바드',itemLevel:level},updatedAt:at});
function fixture(t,options={}){
  const dir=mkdtempSync(join(tmpdir(),'character-snapshot-')),path=join(dir,'snapshots.sqlite');
  let store=createCharacterSnapshotStore(path,{now:()=>at,...options});
  t.after(()=>{store.close();assert(basename(dir).startsWith('character-snapshot-'));rmSync(dir,{recursive:true,force:true});});
  return {path,get store(){return store;},reopen(){store.close();store=createCharacterSnapshotStore(path,{now:()=>at,...options});},save(name,value=profile(name),section='profile'){const a=store.beginAttempt(name);try{return store.putSuccess(name,section,a,value);}finally{store.endAttempt(a);}}};
}

test('snapshot survives a restart with original capture time and a private standalone database',t=>{
  const f=fixture(t);assert.equal(f.save('TestBard',profile('TestBard')),true);f.reopen();
  assert.deepEqual(f.store.get(' testbard ','profile'),profile('TestBard'));
  if(process.platform!=='win32')assert.equal(statSync(f.path).mode&0o777,0o600);
  const db=new DatabaseSync(f.path);assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);db.close();
});

test('late success and an older not-found cannot overwrite a newer successful attempt',t=>{
  const f=fixture(t),old=f.store.beginAttempt('테스트바드'),latest=f.store.beginAttempt('테스트바드');
  assert.equal(f.store.putSuccess('테스트바드','profile',latest,profile('테스트바드',1750)),true);
  assert.equal(f.store.putSuccess('테스트바드','profile',old,profile()),false);
  f.store.invalidateNotFound('테스트바드',old);assert.equal(f.store.get('테스트바드','profile').profile.itemLevel,1750);
  f.store.endAttempt(old);f.store.endAttempt(latest);
});

test('ended issued attempts retain only their original deletion cutoff, never a new write lease',t=>{
  const f=fixture(t);f.save('테스트바드');
  const missing=f.store.beginAttempt('테스트바드');f.store.endAttempt(missing);
  assert.equal(f.store.invalidateNotFound('테스트바드',{...missing}),false);
  assert.equal(f.store.invalidateNotFound('다른바드',missing),false);
  assert.equal(f.store.putSuccess('테스트바드','profile',missing,profile()),false);
  assert.equal(f.store.invalidateNotFound('테스트바드',missing),true);assert.equal(f.store.get('테스트바드','profile'),null);
  f.save('테스트바드',profile('테스트바드',1750));
  assert.equal(f.store.invalidateNotFound('테스트바드',missing),true);assert.equal(f.store.get('테스트바드','profile').profile.itemLevel,1750);
});

test('attempt capacity is bounded and a released slot immediately becomes reusable',t=>{
  const f=fixture(t),tokens=Array.from({length:256},()=>f.store.beginAttempt('테스트바드'));
  assert.throws(()=>f.store.beginAttempt('테스트바드'));
  f.store.endAttempt(tokens.pop());const replacement=f.store.beginAttempt('테스트바드');
  assert.equal(f.store.putSuccess('테스트바드','profile',replacement,profile()),true);
  for(const token of tokens)f.store.endAttempt(token);f.store.endAttempt(replacement);
});

test('404 deletes all sections and invalidates older in-flight saves without inventing a tombstone TTL',t=>{
  const f=fixture(t);f.save('테스트바드');
  f.save('테스트바드',{roster:{characterName:'테스트바드',serverName:'루페온',characters:[]},updatedAt:at},'roster');
  const old=f.store.beginAttempt('테스트바드'),gone=f.store.beginAttempt('테스트바드');
  f.store.invalidateNotFound('테스트바드',gone);
  assert.equal(f.store.get('테스트바드','profile'),null);assert.equal(f.store.get('테스트바드','roster'),null);
  assert.equal(f.store.putSuccess('테스트바드','profile',old,profile()),false);
  f.store.endAttempt(old);f.store.endAttempt(gone);assert.equal(f.save('테스트바드'),true);
});

test('whole-character LRU and byte and record budgets bound persistence',t=>{
  let time=at;const f=fixture(t,{maxCharacters:2,maxRecords:4,maxBytes:2000,now:()=>++time});
  f.save('첫번째');f.save('두번째');f.store.get('첫번째','profile');f.save('세번째');
  assert(f.store.get('첫번째','profile'));assert.equal(f.store.get('두번째','profile'),null);assert(f.store.get('세번째','profile'));
  const db=new DatabaseSync(f.path);const stats=db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM snapshots').get();db.close();
  assert(stats.n<=4);assert(stats.bytes<=2000);
});

test('invalid identity oversized data nonfinite values tampering and closed stores never yield a snapshot',t=>{
  const f=fixture(t,{maxRecordBytes:1024});
  assert.throws(()=>f.save('테스트바드',profile('다른바드')));
  assert.throws(()=>f.save('테스트바드',{...profile(),secret:'x'.repeat(1500)}));
  assert.throws(()=>f.save('테스트바드',{profile:{...profile().profile,title:'x'.repeat(1500)},updatedAt:at}));
  assert.throws(()=>f.save('테스트바드',profile('테스트바드',Infinity)));
  assert.throws(()=>f.store.beginAttempt('../bad'));
  f.save('테스트바드');const db=new DatabaseSync(f.path);db.prepare('UPDATE snapshots SET payload=?').run(JSON.stringify(profile('다른바드')));db.close();
  assert.equal(f.store.get('테스트바드','profile'),null);
  const a=f.store.beginAttempt('테스트바드');f.store.close();assert.equal(f.store.putSuccess('테스트바드','profile',a,profile()),false);assert.equal(f.store.get('테스트바드','profile'),null);
});

test('an authentication or unknown database cannot be opened as a character cache',t=>{
  const dir=mkdtempSync(join(tmpdir(),'character-snapshot-')),path=join(dir,'auth.sqlite');
  t.after(()=>{assert(basename(dir).startsWith('character-snapshot-'));rmSync(dir,{recursive:true,force:true});});
  const db=new DatabaseSync(path);db.exec('CREATE TABLE users (id TEXT); PRAGMA user_version=8;');db.close();
  assert.throws(()=>createCharacterSnapshotStore(path));
  const check=new DatabaseSync(path);assert.equal(check.prepare('PRAGMA user_version').get().user_version,8);assert.equal(check.prepare('SELECT COUNT(*) AS n FROM users').get().n,0);check.close();
});

test('byte and record limits independently evict whole names and do not impose a thirty-day TTL',t=>{
  const bytes=fixture(t,{maxBytes:250});bytes.save('첫번째');bytes.save('두번째');assert.equal(bytes.store.get('첫번째','profile'),null);assert(bytes.store.get('두번째','profile'));
  const records=fixture(t,{maxRecords:1});records.save('첫번째');records.save('두번째');assert.equal(records.store.get('첫번째','profile'),null);assert(records.store.get('두번째','profile'));
  let time=at;const old=fixture(t,{now:()=>time});old.save('테스트바드');time+=366*86400000;old.reopen();assert.equal(old.store.get('테스트바드','profile').updatedAt,at);
});
