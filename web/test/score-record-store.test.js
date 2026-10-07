import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createScoreRecordStore} from '../src/score-record-store.js';
import {createCharacterSpecService} from '../src/character-spec.js';
import {fixture as armory,tooltip} from '../../tests/helpers/native-efficiency-fixture.mjs';
import {analyzeNativeSpecScore} from '../../src/native-spec-score.js';

const time=1790000000000;
const stores=new Map();
const candidate=(score=4238.59,at=time,extra={})=>({score,role:'dealer',modelVersion:'2026-09-16.1',recordedAt:at,...extra});
function location(t){const dir=mkdtempSync(join(tmpdir(),'score-record-')),path=join(dir,'scores.sqlite');stores.set(path,new Set());t.after(()=>{for(const store of stores.get(path))store.close();stores.delete(path);assert(basename(dir).startsWith('score-record-'));rmSync(dir,{recursive:true,force:true});});return path;}
function open(t,path,options={}){const store=createScoreRecordStore(path,{now:()=>time,...options});stores.get(path).add(store);return store;}

test('best score survives restart while equal or lower scores keep the earlier record and time',t=>{
 const path=location(t),store=open(t,path);assert.equal(store.get('앞으로가나'),null);
 const first=store.record('앞으로가나',candidate(4238.59,time-100));
 assert.deepEqual(first,{characterName:'앞으로가나',score:4238.59,role:'dealer',modelVersion:'2026-09-16.1',recordedAt:time-100});
 assert.deepEqual(store.record('앞으로가나',candidate(4238.59)),first);
 assert.deepEqual(store.record('앞으로가나',candidate(4020.23)),first);
 const high=store.record('앞으로가나',candidate(8428.22,time,{role:'dealer'}));assert.equal(high.score,8428.22);assert.equal(high.recordedAt,time);
 store.close();const reopened=open(t,path);assert.deepEqual(reopened.get('앞으로가나'),high);
 const isolated=reopened.get('앞으로가나');isolated.score=1;assert.equal(reopened.get('앞으로가나').score,8428.22);
 if(process.platform!=='win32')assert.equal(statSync(path).mode&0o777,0o600);
});

test('identity is normalized, roles are kept with the record, and invalid candidates are refused',t=>{
 const store=open(t,location(t));store.record('SatinaV',candidate(5000,time,{role:'support'}));
 assert.equal(store.get('satinav').characterName,'SatinaV');assert.equal(store.get('satinav').role,'support');
 assert.equal(store.get('없는캐릭터'),null);
 for(const bad of [candidate(0),candidate(-1),candidate(Number.NaN),candidate(4000,time+1),candidate(4000,time,{role:'tank'}),
   candidate(4000,time,{modelVersion:''}),{...candidate(),extra:1},null,[]]) assert.throws(()=>store.record('SatinaV',bad),/unavailable/);
 assert.throws(()=>store.record('',candidate()),/unavailable/);
 assert.equal(store.get('satinav').score,5000);
});

test('a tampered row is refused instead of being shown as a record',t=>{
 const path=location(t),store=open(t,path);store.record('합성캐릭터4',candidate(5115.78));store.close();
 const db=new DatabaseSync(path);db.exec("UPDATE score_records SET score=9999 WHERE name_key='합성캐릭터4'");db.close();
 const reopened=open(t,path);assert.throws(()=>reopened.get('합성캐릭터4'),/unavailable/);
});

test('a details refresh records the current score and only raises the record afterwards',async t=>{
 let clock=time,level=140,rank=0;
 const path=location(t),store=open(t,path,{now:()=>clock});
 const raw=armory();raw.ArmoryEquipment[0].Grade='고대';Object.assign(raw.ArmoryProfile,{ServerName:'루페온',ItemAvgLevel:'1,700.00'});
 for(const type of ['목걸이','반지','반지'])raw.ArmoryEquipment.push({Type:type,Grade:'고대',Tooltip:tooltip({'기본 효과':'민첩 +0','연마 효과':''})});
 raw.ArkPassive.IsArkPassive=true;raw.ArkPassive.Points=['진화','깨달음','도약'].map((Name,i)=>({Name,Value:[140,100,70][i],Description:'0랭크 0레벨'}));
 raw.ArmoryGem={Gems:[],Effects:{Description:'',Skills:[]}};
 const expected=analyzeNativeSpecScore(raw);assert.equal(expected.status,'ok');
 const fetchImpl=async input=>{const url=new URL(input);
   if(url.pathname.endsWith('/profiles'))return Response.json(raw.ArmoryProfile);
   if(url.pathname.endsWith('/siblings'))return Response.json([raw.ArmoryProfile]);
   if(url.pathname.endsWith('/arkgrid'))return Response.json({Slots:[]});
   const body=structuredClone(raw);body.ArkPassive.Points[0].Value=level;body.ArkPassive.Points[0].Description=`${rank}랭크 0레벨`;return Response.json(body);};
 const service=createCharacterSpecService({config:{automaticApproval:{lostArkApiKey:'synthetic'}},fetchImpl,scoreRecordStore:store,now:()=>clock});
 t.after(()=>service.close());
 const name=raw.ArmoryProfile.CharacterName;
 const details=await service.get(name,'details');
 assert.equal(details.efficiency.score.status,'ok');
 assert.deepEqual(store.get(name),{characterName:name,score:details.efficiency.score.score,role:'dealer',modelVersion:details.efficiency.score.modelVersion,recordedAt:time});
 // A weaker refresh (fewer evolution points) leaves the record untouched; a stronger one raises it.
 clock+=400000;level=120;const weaker=await service.get(name,'details');assert(weaker.efficiency.score.score<details.efficiency.score.score);
 assert.equal(store.get(name).score,details.efficiency.score.score);assert.equal(store.get(name).recordedAt,time);
 clock+=400000;level=140;rank=2;const stronger=await service.get(name,'details');assert(stronger.efficiency.score.score>details.efficiency.score.score);
 assert.deepEqual(store.get(name),{characterName:name,score:stronger.efficiency.score.score,role:'dealer',modelVersion:stronger.efficiency.score.modelVersion,recordedAt:clock});
});
