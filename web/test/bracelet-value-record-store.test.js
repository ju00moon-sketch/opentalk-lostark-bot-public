import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {createBraceletValueRecordStore,BRACELET_VALUE_RECORD_POLICY as POLICY,BRACELET_T3_VALUE_RECORD_POLICY as T3_POLICY} from '../src/bracelet-value-record-store.js';

const time=1790000000000,target='a'.repeat(64),other='b'.repeat(64);
const stores=new Map();
const candidate=(price=15000,at=time)=>({costExpectedGold:price*4,recordedAt:at,basePriceGold:price,
  expectedStartingBracelets:4,successProbability:.25,expectedReconversionTicketsUntilSuccess:4.25});
function location(t){const dir=mkdtempSync(join(tmpdir(),'bracelet-record-')),path=join(dir,'values.sqlite');stores.set(path,new Set());t.after(()=>{for(const store of stores.get(path))store.close();stores.delete(path);assert.equal(resolve(dirname(dir)),resolve(tmpdir()));assert(basename(dir).startsWith('bracelet-record-'));rmSync(dir,{recursive:true,force:true});});return path;}
function open(t,path,options={}){const store=createBraceletValueRecordStore(path,{now:()=>time,...options});stores.get(path).add(store);return store;}

test('maximum survives restart; equal or lower observations preserve every prior field and time',t=>{
 const path=location(t),store=open(t,path);assert.equal(store.get('합성캐릭터4',target,POLICY),null);
 const first=store.record('합성캐릭터4',target,POLICY,candidate(15000,time-100));
 assert.deepEqual(store.record('합성캐릭터4',target,POLICY,candidate(15000)),first);
 assert.deepEqual(store.record('합성캐릭터4',target,POLICY,candidate(10000)),first);
 const high=store.record('합성캐릭터4',target,POLICY,candidate(15000.125));assert.equal(high.costExpectedGold,60000.5);
 store.close();const reopened=open(t,path);assert.deepEqual(reopened.get('합성캐릭터4',target,POLICY),high);
 const isolated=reopened.get('합성캐릭터4',target,POLICY);isolated.costExpectedGold=1;assert.equal(reopened.get('합성캐릭터4',target,POLICY).costExpectedGold,60000.5);
 if(process.platform!=='win32')assert.equal(statSync(path).mode&0o777,0o600);
});

test('identity is normalized while equipment fingerprints and model policies are isolated',t=>{
 const store=open(t,location(t));store.record('SatinaV',target,POLICY,candidate());
 assert.equal(store.get('satinav',target,POLICY).characterName,'SatinaV');
 assert.equal(store.get('SATINAV',other,POLICY),null);assert.equal(store.get('SatinaV',target,'bracelet-model-v3'),null);
 store.record('SatinaV',other,POLICY,candidate(5000));store.record('SatinaV',target,'bracelet-model-v3',candidate(8000));
 assert.equal(store.get('satinav',target,POLICY).costExpectedGold,60000);
 assert.equal(store.get('satinav',other,POLICY).costExpectedGold,20000);
 store.record('합성캐릭터4'.normalize('NFD'),target,POLICY,candidate());assert.equal(store.get('합성캐릭터4',target,POLICY).characterName,'합성캐릭터4');
});

test('invalid, nonfinite, future or inconsistent values cannot overwrite a valid record',t=>{
 const store=open(t,location(t)),first=store.record('합성캐릭터4',target,POLICY,candidate());
 for(const mutate of [x=>x.costExpectedGold=Infinity,x=>x.basePriceGold=0,x=>x.recordedAt=time+1,x=>x.recordedAt=-1,
  x=>x.expectedStartingBracelets=.5,x=>x.successProbability=0,x=>x.successProbability=.5,
  x=>x.expectedReconversionTicketsUntilSuccess=13,x=>x.expectedReconversionTicketsUntilSuccess=null,
  x=>x.costExpectedGold=999999,x=>x.costExpectedGold='60000',x=>x.extra='unexpected']){
  const value=candidate();mutate(value);assert.throws(()=>store.record('합성캐릭터4',target,POLICY,value),{code:'bracelet_record_unavailable'});
 }
 for(const [name,key,policy] of [['!',target,POLICY],['합성캐릭터4','wrong',POLICY],['합성캐릭터4',target,'x\n']])assert.throws(()=>store.get(name,key,policy));
 assert.deepEqual(store.get('합성캐릭터4',target,POLICY),first);
});

test('record limit refuses new identities without eviction and still allows existing peak increases',t=>{
 const store=open(t,location(t),{maxRecords:1});const first=store.record('합성캐릭터4',target,POLICY,candidate());
 assert.throws(()=>store.record('다른캐릭터',target,POLICY,candidate()),{code:'bracelet_record_capacity'});
 assert.deepEqual(store.get('합성캐릭터4',target,POLICY),first);assert.equal(store.get('다른캐릭터',target,POLICY),null);
 assert.equal(store.record('합성캐릭터4',target,POLICY,candidate(20000)).costExpectedGold,80000);
});

test('foreign database is not migrated and stored corruption fails closed',t=>{
 const path=location(t),foreign=new DatabaseSync(path);foreign.exec('CREATE TABLE private_data(value TEXT); INSERT INTO private_data VALUES (\'keep\'); PRAGMA user_version=8;');foreign.close();
 assert.throws(()=>createBraceletValueRecordStore(path),{code:'bracelet_record_unavailable'});
 const retained=new DatabaseSync(path);assert.equal(retained.prepare('SELECT value FROM private_data').get().value,'keep');assert.equal(retained.prepare('PRAGMA user_version').get().user_version,8);retained.close();
 const second=location(t),store=open(t,second);store.record('합성캐릭터4',target,POLICY,candidate());
 const damage=new DatabaseSync(second);damage.prepare('UPDATE bracelet_value_records SET cost_expected_gold=?').run(70000);damage.close();
 assert.throws(()=>store.get('합성캐릭터4',target,POLICY),{code:'bracelet_record_unavailable'});
 assert.throws(()=>store.record('합성캐릭터4',target,POLICY,candidate(30000)),{code:'bracelet_record_unavailable'});
});

test('closed store rejects reads and writes and close is idempotent',t=>{
 const store=open(t,location(t));store.record('합성캐릭터4',target,POLICY,candidate());store.close();store.close();
 assert.throws(()=>store.get('합성캐릭터4',target,POLICY),{code:'bracelet_record_unavailable'});
 assert.throws(()=>store.record('합성캐릭터4',target,POLICY,candidate(20000)),{code:'bracelet_record_unavailable'});
});

test('independent SQLite connections atomically preserve the greatest concurrent observation',async t=>{
 const path=location(t),store=open(t,path);store.record('합성캐릭터4',target,POLICY,candidate(100));
 const moduleUrl=new URL('../src/bracelet-value-record-store.js',import.meta.url).href;
 const barrier=new SharedArrayBuffer(4),gate=new Int32Array(barrier);
 const workers=[30000,20000,50000,40000].map(price=>new Worker(`
  const {parentPort,workerData}=require('node:worker_threads');
  (async()=>{const mod=await import(workerData.url);const store=mod.createBraceletValueRecordStore(workerData.path,{now:()=>workerData.time});parentPort.postMessage('ready');Atomics.wait(new Int32Array(workerData.barrier),0,0);store.record('합성캐릭터4',workerData.target,mod.BRACELET_VALUE_RECORD_POLICY,workerData.value);store.close();parentPort.postMessage('done');})().catch(error=>{parentPort.postMessage({error:error.message});process.exitCode=1;});
 `,{eval:true,env:{},workerData:{url:moduleUrl,path,time,target,barrier,value:candidate(price)}}));
 t.after(()=>Promise.all(workers.map(worker=>worker.terminate())));
 const completed=workers.map(worker=>new Promise((resolve,reject)=>{worker.on('message',value=>{if(value==='done')resolve();else if(value?.error)reject(Error(value.error));});worker.on('error',reject);}));
 await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{worker.on('message',value=>{if(value==='ready')resolve();else if(value?.error)reject(Error(value.error));});worker.on('error',reject);})));
 Atomics.store(gate,0,1);Atomics.notify(gate,0);await Promise.all(completed);
  assert.equal(store.get('합성캐릭터4',target,POLICY).costExpectedGold,200000);
});

test('physical database limit fails new writes without deleting previously saved maxima',t=>{
 const path=location(t),store=open(t,path,{maxFileBytes:65536});const first=store.record('합성캐릭터4',target,POLICY,candidate());
 let full=false;
 for(let i=0;i<1000;i++){
  try{store.record('합성캐릭터4',i.toString(16).padStart(64,'0'),POLICY,candidate());}
  catch(error){assert.equal(error.code,'bracelet_record_capacity');full=true;break;}
 }
 assert.equal(full,true);assert(statSync(path).size<=65536);assert.deepEqual(store.get('합성캐릭터4',target,POLICY),first);
});

test('linked data directories fail closed rather than opening the referenced record database',t=>{
 const path=location(t),store=open(t,path);store.record('합성캐릭터4',target,POLICY,candidate());store.close();
 const alias=dirname(path)+'-link';assert.equal(resolve(dirname(alias)),resolve(tmpdir()));
 symlinkSync(dirname(path),alias,process.platform==='win32'?'junction':'dir');t.after(()=>rmSync(alias,{force:true}));
 assert.throws(()=>createBraceletValueRecordStore(join(alias,'values.sqlite')),{code:'bracelet_record_unavailable'});
 assert.equal(open(t,path).get('합성캐릭터4',target,POLICY).costExpectedGold,60000);
});

test('tier-three no-ticket policy is separate and accepts zero expected tickets without changing tier-four',t=>{
 const store=open(t,location(t));store.record('합성캐릭터4',target,POLICY,candidate());
 const tier3={...candidate(10000),expectedReconversionTicketsUntilSuccess:0};
 assert.equal(store.record('합성캐릭터4',target,T3_POLICY,tier3).expectedReconversionTicketsUntilSuccess,0);
 assert.equal(store.get('합성캐릭터4',target,T3_POLICY).costExpectedGold,40000);
 assert.equal(store.get('합성캐릭터4',target,POLICY).costExpectedGold,60000);
});
