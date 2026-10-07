import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {INPUTS_LIMIT,MEMBERS_LIMIT,createRosterRecordStore} from '../src/roster-record-store.js';

const time=1790000000000;
const key=name=>Buffer.from(name).toString('hex').padEnd(64,'0').slice(0,64);
const stores=new Map();
const member=(characterName,extra={})=>({characterName,serverName:'루페온',itemLevel:1740,role:'dealer',
  targetKey:key(characterName),status:'ok',knownGold:8000000,...extra});
const inputsOf=(characterName,extra={})=>({characterName,targetKey:key(characterName),
  inputs:{version:'roster-value-inputs-v1',updatedAt:time-1000,valuationTargets:{targetKey:key(characterName)},...extra}});
const record=(extra={})=>({serverName:'루페온',recordedAt:time-60000,recordGold:12000000,
  members:[member('앞으로가나'),member('부캐하나',{role:'support',knownGold:4000000})],
  inputs:[inputsOf('앞으로가나'),inputsOf('부캐하나')],...extra});
function location(t){const dir=mkdtempSync(join(tmpdir(),'roster-record-')),path=join(dir,'roster-records.sqlite');stores.set(path,new Set());
  t.after(()=>{for(const store of stores.get(path))store.close();stores.delete(path);assert(basename(dir).startsWith('roster-record-'));rmSync(dir,{recursive:true,force:true});});return path;}
function open(t,path,options={}){const store=createRosterRecordStore(path,{now:()=>time,...options});stores.get(path).add(store);return store;}

test('a record and its per-character inputs survive a restart and are replaced together',t=>{
 const path=location(t),store=open(t,path);
 assert.equal(store.getRecord('앞으로가나'),null);
 assert.equal(store.getInputs('앞으로가나').size,0);
 const stored=store.putRecord('앞으로가나',record());
 assert.equal(stored.anchorName,'앞으로가나');assert.equal(stored.recordGold,12000000);
 assert.equal(stored.recordedAt,time-60000);assert.equal(stored.checkedAt,time);
 assert.equal(stored.repricedGold,null);assert.equal(stored.repricedAt,null);
 assert.deepEqual(stored.members.map(row=>row.characterName),['앞으로가나','부캐하나']);
 assert.deepEqual([...store.getInputs('앞으로가나').keys()],['부캐하나','앞으로가나']);
 // A new record replaces the row and every input sheet of that anchor, so the two can never disagree.
 const replaced=store.putRecord('앞으로가나',{...record({recordGold:20000000}),
   members:[member('앞으로가나')],inputs:[inputsOf('앞으로가나')]});
 assert.equal(replaced.recordGold,20000000);assert.equal(replaced.members.length,1);
 assert.deepEqual([...store.getInputs('앞으로가나').keys()],['앞으로가나']);
 store.close();
 const reopened=open(t,path);
 assert.deepEqual(reopened.getRecord('앞으로가나'),replaced);
 assert.deepEqual(reopened.getInputs('앞으로가나').get('앞으로가나').inputs,inputsOf('앞으로가나').inputs);
 if(process.platform!=='win32')assert.equal(statSync(path).mode&0o777,0o600);
});

test('re-pricing moves only today’s number and leaves the recorded moment untouched',t=>{
 let clock=time;const store=open(t,location(t),{now:()=>clock});
 assert.equal(store.updateRepriced('앞으로가나',{repricedGold:1,repricedAt:time}),null);
 store.putRecord('SatinaV',record());
 clock=time+86400000;
 const repriced=store.updateRepriced('satinav',{repricedGold:9000000,repricedAt:clock});
 assert.equal(repriced.anchorName,'SatinaV');
 assert.equal(repriced.repricedGold,9000000);assert.equal(repriced.repricedAt,clock);
 assert.equal(repriced.recordGold,12000000);assert.equal(repriced.recordedAt,time-60000);
 assert.deepEqual(store.getRecord('satinav'),repriced);
 for(const bad of [{repricedGold:-1,repricedAt:clock},{repricedGold:1,repricedAt:clock+1},{repricedGold:1},null])
   assert.throws(()=>store.updateRepriced('satinav',bad),/unavailable/);
 assert.equal(store.getRecord('satinav').repricedGold,9000000);
});

test('a member may carry the prices it went without, and a record written before that still reads',t=>{
 const store=open(t,location(t));
 // 재가격이 기록 때 알던 시세를 잃었는지 가리는 목록이다(교차 검토 C-R1). 예전 기록에는 이 칸이 없다.
 store.putRecord('앞으로가나',record({members:[member('앞으로가나',{unpriced:[]}),
   member('부캐하나',{status:'partial',knownGold:4000000,unpriced:['gems:gem-2']})]}));
 assert.deepEqual(store.getRecord('앞으로가나').members.map(row=>row.unpriced),[[],['gems:gem-2']]);
 store.putRecord('부캐하나',{...record(),members:[member('부캐하나',{status:'partial',unpriced:null})],inputs:[inputsOf('부캐하나')]});
 assert.equal(store.getRecord('부캐하나').members[0].unpriced,null);
 store.putRecord('SatinaV',{...record(),members:[member('SatinaV')],inputs:[inputsOf('SatinaV')]});
 assert.equal(Object.hasOwn(store.getRecord('SatinaV').members[0],'unpriced'),false);
 for(const unpriced of ['gems:gem-2',[1],[''],['x'.repeat(201)],Array.from({length:257},(_,i)=>`gems:${i}`)])
   assert.throws(()=>store.putRecord('SatinaV',{...record(),members:[member('SatinaV',{unpriced})],inputs:[inputsOf('SatinaV')]}),/unavailable/);
});

test('a record whose members and inputs disagree, or whose fields are wrong, is refused',t=>{
 const store=open(t,location(t));
 for(const bad of [record({members:[member('앞으로가나',{status:'stale'})],inputs:[inputsOf('앞으로가나')]}),
   record({members:[member('앞으로가나',{role:'tank'})],inputs:[inputsOf('앞으로가나')]}),
   record({members:[member('앞으로가나',{targetKey:'zz'})],inputs:[inputsOf('앞으로가나')]}),
   record({members:[member('앞으로가나',{knownGold:-1})],inputs:[inputsOf('앞으로가나')]}),
   record({members:[member('앞으로가나'),member('앞으로가나')],inputs:[inputsOf('앞으로가나')]}),
   // The record counted two characters but only one can be priced again — an unusable record.
   record({members:[member('앞으로가나'),member('부캐하나')],inputs:[inputsOf('앞으로가나')]}),
   record({members:[member('앞으로가나')],inputs:[inputsOf('다른캐릭')]}),
   record({recordedAt:time+1}),record({recordGold:-1}),record({serverName:''}),
   record({members:[],inputs:[]}),{...record(),extra:1},null,[]])
   assert.throws(()=>store.putRecord('앞으로가나',bad),/unavailable/);
 assert.throws(()=>store.putRecord('',record()),/unavailable/);
 assert.equal(store.getRecord('앞으로가나'),null);
});

test('an oversized member list or input sheet is refused as capacity instead of being trimmed',t=>{
 const store=open(t,location(t));
 assert.throws(()=>store.putRecord('앞으로가나',record({members:[member('앞으로가나')],
   inputs:[inputsOf('앞으로가나',{padding:'가'.repeat(INPUTS_LIMIT)})]})),/capacity/);
 // A roster cannot hold more than a hundred characters, so an oversized list is refused before its size matters.
 const many=Array.from({length:101},(_,i)=>`채움${String(i).padStart(3,'0')}`);
 assert.throws(()=>store.putRecord('앞으로가나',record({
   members:many.map(name=>member(name)),inputs:many.map(name=>inputsOf(name))})),/unavailable/);
 assert.equal(store.getRecord('앞으로가나'),null);
 assert.equal(store.getInputs('앞으로가나').size,0);
 assert.ok(MEMBERS_LIMIT<INPUTS_LIMIT);
});

test('a tampered record or an unexpected schema is refused instead of being read as a value',t=>{
 const path=location(t),store=open(t,path);
 store.putRecord('합성캐릭터4',{...record(),members:[member('합성캐릭터4')],inputs:[inputsOf('합성캐릭터4')]});
 store.close();
 const db=new DatabaseSync(path);
 db.exec("UPDATE roster_value_records SET record_gold=999999999 WHERE anchor_key='합성캐릭터4'");
 db.close();
 const reopened=open(t,path);
 assert.throws(()=>reopened.getRecord('합성캐릭터4'),/unavailable/);
 // The inputs are not part of the record hash, but a sheet that stopped being JSON is still refused.
 reopened.close();
 const broken=new DatabaseSync(path);
 broken.exec("UPDATE roster_value_record_inputs SET inputs_json='[' WHERE anchor_key='합성캐릭터4'");
 broken.close();
 const again=open(t,path);
 assert.throws(()=>again.getInputs('합성캐릭터4'),/unavailable/);
 again.close();
 const foreign=location(t);
 const other=new DatabaseSync(foreign);other.exec('CREATE TABLE notes (id INTEGER)');other.close();
 assert.throws(()=>createRosterRecordStore(foreign,{now:()=>time}),/unavailable/);
});
