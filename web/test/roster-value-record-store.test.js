import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AGGREGATE_LIMIT,createRosterValueRecordStore} from '../src/roster-value-record-store.js';

const time=1790000000000;
const key='a'.repeat(64);
const stores=new Map();
const aggregate=(characterName='앞으로가나')=>({characterName,serverName:'루페온',
  components:{engravings:{items:[{status:'ok',accountKey:'engraving:질풍',grade:'유물',level:3,marketReplacementGold:120000,checkedAt:time-1000,reason:null}],counts:{items:1,known:1,unknown:0}}},
  excludingSharedBooks:{knownMarketReplacementGold:5000000,knownExpectedAcquisitionGold:3000000,complete:true}});
const row=(extra={})=>({serverName:'루페온',itemLevel:1740,role:'dealer',targetKey:key,equipmentUpdatedAt:time-5000,
  status:'ok',knownGold:8000000,knownMarketGold:5000000,knownExpectedGold:3000000,complete:true,unknownItems:0,
  aggregate:aggregate(),computedAt:time-1000,...extra});
const roster=(extra={})=>({serverName:'루페온',members:[{characterName:'앞으로가나',serverName:'루페온',itemLevel:1740},
  {characterName:'뒤로가나',serverName:'루페온',itemLevel:1700}],...extra});
function location(t){const dir=mkdtempSync(join(tmpdir(),'roster-value-')),path=join(dir,'roster-values.sqlite');stores.set(path,new Set());
  t.after(()=>{for(const store of stores.get(path))store.close();stores.delete(path);assert(basename(dir).startsWith('roster-value-'));rmSync(dir,{recursive:true,force:true});});return path;}
function open(t,path,options={}){const store=createRosterValueRecordStore(path,{now:()=>time,...options});stores.get(path).add(store);return store;}

test('character and roster rows survive a restart and the newest calculation replaces the earlier one',t=>{
 const path=location(t),store=open(t,path);
 assert.equal(store.getCharacter('앞으로가나'),null);
 assert.equal(store.getRoster('앞으로가나'),null);
 const first=store.recordCharacter('앞으로가나',row());
 assert.equal(first.knownGold,8000000);assert.equal(first.checkedAt,time);assert.equal(first.computedAt,time-1000);
 // Unlike the score record, a later calculation always wins — the stored number tracks the current equipment.
 const lower=store.recordCharacter('앞으로가나',row({knownGold:20000,knownMarketGold:20000,knownExpectedGold:0,status:'partial',complete:false,unknownItems:3}));
 assert.equal(lower.knownGold,20000);assert.equal(lower.status,'partial');assert.equal(lower.complete,false);assert.equal(lower.unknownItems,3);
 const stored=store.recordRoster('앞으로가나',roster());
 assert.equal(stored.anchorName,'앞으로가나');assert.equal(stored.checkedAt,time);assert.equal(stored.members.length,2);
 store.close();
 const reopened=open(t,path);
 assert.deepEqual(reopened.getCharacter('앞으로가나'),lower);
 assert.deepEqual(reopened.getRoster('앞으로가나').members,stored.members);
 assert.deepEqual(reopened.getCharacter('앞으로가나').aggregate,aggregate());
 if(process.platform!=='win32')assert.equal(statSync(path).mode&0o777,0o600);
});

test('identity is normalized, touch only moves the freshness stamp and invalid rows are refused',t=>{
 let clock=time;const store=open(t,location(t),{now:()=>clock});
 store.recordCharacter('SatinaV',row({serverName:'니나브',role:'support'}));
 assert.equal(store.getCharacter('satinav').characterName,'SatinaV');
 assert.equal(store.getCharacter('satinav').role,'support');
 clock=time+90000;
 const touched=store.touch('satinav');
 assert.equal(touched.checkedAt,time+90000);assert.equal(touched.computedAt,time-1000);assert.equal(touched.knownGold,8000000);
 assert.equal(store.touch('없는캐릭터'),null);
 for(const bad of [row({status:'stale'}),row({role:'tank'}),row({targetKey:'zz'}),row({knownGold:-1}),row({computedAt:clock+1}),
   row({itemLevel:'1740'}),row({aggregate:[1,2]}),row({complete:1}),{...row(),extra:1},null,[]]) assert.throws(()=>store.recordCharacter('SatinaV',bad),/unavailable/);
 assert.throws(()=>store.recordCharacter('',row()),/unavailable/);
 for(const bad of [roster({members:[]}),roster({members:[{characterName:'남',serverName:'루페온',itemLevel:1700}]}),
   roster({members:[{characterName:'앞으로가나',serverName:'루페온',itemLevel:1740},{characterName:'앞으로가나',serverName:'루페온',itemLevel:1700}]}),
   roster({serverName:''}),{...roster(),extra:1}]) assert.throws(()=>store.recordRoster('앞으로가나',bad),/unavailable/);
 assert.equal(store.getCharacter('satinav').knownGold,8000000);
});

test('an oversized projection is refused as capacity instead of being trimmed to a wrong number',t=>{
 const store=open(t,location(t));
 const huge={...aggregate(),padding:'가'.repeat(AGGREGATE_LIMIT)};
 assert.throws(()=>store.recordCharacter('앞으로가나',row({aggregate:huge})),/capacity/);
 assert.equal(store.getCharacter('앞으로가나'),null);
 const members=Array.from({length:101},(_,i)=>({characterName:i===0?'앞으로가나':`채움${String(i).padStart(2,'0')}`,serverName:'루페온',itemLevel:1700}));
 assert.throws(()=>store.recordRoster('앞으로가나',{serverName:'루페온',members}),/unavailable/);
});

test('a tampered row or an unexpected schema is refused instead of being read as a value',t=>{
 const path=location(t),store=open(t,path);
 store.recordCharacter('합성캐릭터4',row());store.recordRoster('합성캐릭터4',{serverName:'루페온',members:[{characterName:'합성캐릭터4',serverName:'루페온',itemLevel:1740}]});
 store.close();
 const db=new DatabaseSync(path);
 db.exec("UPDATE roster_value_characters SET known_gold=999999999 WHERE name_key='합성캐릭터4'");
 db.exec("UPDATE roster_value_rosters SET server_name='카단' WHERE anchor_key='합성캐릭터4'");
 db.close();
 const reopened=open(t,path);
 assert.throws(()=>reopened.getCharacter('합성캐릭터4'),/unavailable/);
 assert.throws(()=>reopened.getRoster('합성캐릭터4'),/unavailable/);
 reopened.close();
 const foreign=join(location(t));
 const other=new DatabaseSync(foreign);other.exec('CREATE TABLE notes (id INTEGER)');other.close();
 assert.throws(()=>createRosterValueRecordStore(foreign,{now:()=>time}),/unavailable/);
});
