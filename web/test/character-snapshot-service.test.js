import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCharacterSnapshotStore } from '../src/character-snapshot-store.js';
import { createCharacterSpecService } from '../src/character-spec.js';

const at=1790000000000,name='테스트바드';
const profile=()=>({CharacterName:name,ServerName:'루페온',CharacterClassName:'바드',ItemAvgLevel:'1740.00'});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function fixture(t,options={}){
  const dir=mkdtempSync(join(tmpdir(),'character-snapshot-service-')),path=join(dir,'snapshots.sqlite');let time=at;
  const store=createCharacterSnapshotStore(path,{now:()=>time});
  const state={status:200,level:'1740.00',calls:[],hook:null,gridFail:false};
  const fetchImpl=async(input,init)=>{const url=new URL(input);state.calls.push(url.pathname);if(state.hook){const value=await state.hook(url,init);if(value)return value;}
    if(state.status!==200)return Response.json({error:'private'}, {status:state.status});
    if(url.pathname.endsWith('/profiles'))return Response.json({...profile(),ItemAvgLevel:state.level});
    if(url.pathname.endsWith('/siblings'))return Response.json([{...profile(),ItemAvgLevel:state.level}]);
    if(url.pathname.endsWith('/arkgrid'))return state.gridFail?Response.json({}, {status:503}):Response.json({Slots:[{Index:0,Grade:'고대',Point:20}]});
    return Response.json({ArmoryProfile:profile(),ArmoryEquipment:[],ArmorySkills:[],ArmoryGem:{Gems:[]},ArmoryEngraving:{ArkPassiveEffects:[]},ArkPassive:{Effects:[],Points:[]}});
  };
  const make=()=>createCharacterSpecService({config:{automaticApproval:{lostArkApiKey:'synthetic'}},fetchImpl,snapshotStore:store,now:()=>time,...options});
  let service=make();t.after(()=>{service.close();store.close();assert(basename(dir).startsWith('character-snapshot-service-'));rmSync(dir,{recursive:true,force:true});});
  return {store,path,state,get service(){return service;},advance:ms=>time+=ms,restart(){service.close();service=make();}};
}

test('display refresh saves successes and restart failures show captured data while get stays strict',async t=>{
  const f=fixture(t);const first=await f.service.getForDisplay(name,'profile',{refresh:true});assert.equal(first.source,'live');assert.equal(first.capturedAt,at);assert.equal(first.refreshFailed,null);
  f.advance(1000);f.state.level='1750.00';const second=await f.service.getForDisplay(name,'profile',{refresh:true});assert.equal(second.profile.itemLevel,1750);assert.equal(f.state.calls.length,2);
  f.restart();f.state.status=503;f.advance(1000);const saved=await f.service.getForDisplay(name,'profile',{refresh:true});
  assert.equal(saved.source,'saved');assert.equal(saved.capturedAt,at+1000);assert.equal(saved.updatedAt,at+1000);assert.equal(saved.refreshFailed,'official_unavailable');
  await assert.rejects(f.service.get(name,'profile'),error=>error.status===502);
});

test('display refresh bypasses nested roster and grid caches and partial results never replace a complete snapshot',async t=>{
  const f=fixture(t);const first=await f.service.getForDisplay(name,'arkgrid',{refresh:true});assert.equal(first.source,'live');assert.equal(first.arkgrid.totals.points,20);
  const count=f.state.calls.length;f.state.gridFail=true;f.advance(1000);
  const next=await f.service.getForDisplay(name,'arkgrid',{refresh:true});assert.equal(next.source,'saved');assert.equal(next.refreshFailed,'partial_upstream');assert.equal(next.arkgrid.partial,false);assert.equal(next.updatedAt,at);
  assert.equal(f.state.calls.length-count,2);assert.equal(f.store.get(name,'arkgrid').updatedAt,at);
});

test('404 invalidates all prior sections and blocks a delayed older successful display write',async t=>{
  const f=fixture(t);await f.service.getForDisplay(name,'profile',{refresh:true});await f.service.getForDisplay(name,'details',{refresh:true});
  const start=deferred(),release=deferred();f.state.hook=async url=>{if(url.pathname.endsWith('/profiles')){start.resolve();await release.promise;return Response.json(profile());}return Response.json(null);};
  const old=f.service.getForDisplay(name,'profile',{refresh:true});await start.promise;
  await assert.rejects(f.service.getForDisplay(name,'details',{refresh:true}),error=>error.status===404);
  release.resolve();await assert.rejects(old,error=>error.status===404);
  assert.equal(f.store.get(name,'profile'),null);assert.equal(f.store.get(name,'details'),null);
});

test('concurrent normalized display refreshes share work and metadata without altering the strict payload',async t=>{
  const f=fixture(t),start=deferred(),release=deferred();f.state.hook=async()=>{start.resolve();await release.promise;};
  const one=f.service.getForDisplay('TestBard','profile',{refresh:true});
  // The fake server must return the requested identity.
  f.state.hook=async url=>{start.resolve();await release.promise;return Response.json({...profile(),CharacterName:decodeURIComponent(url.pathname.split('/')[3])});};
  const two=f.service.getForDisplay(' testbard ','profile',{refresh:true});await start.promise;release.resolve();assert.deepEqual(await one,await two);assert.equal(f.state.calls.length,1);
  const raw=await f.service.get('TestBard','profile');assert(!Object.hasOwn(raw,'source'));assert(!Object.hasOwn(raw,'capturedAt'));
});

test('snapshot IO errors never fail a live response and service close never revives saved data',async t=>{
  const broken={beginAttempt(){throw Error('private');},get(){throw Error('private');},putSuccess(){throw Error('private');},endAttempt(){throw Error('private');}};
  const f=fixture(t,{snapshotStore:broken});assert.equal((await f.service.getForDisplay(name,'profile',{refresh:true})).source,'live');
  f.service.close();await assert.rejects(f.service.getForDisplay(name,'profile'),error=>error.status===502);
});

test('an older delayed 404 does not invalidate a newer successful section or its cache',async t=>{
  const f=fixture(t),started=deferred(),release=deferred();
  f.state.hook=async url=>{if(!url.pathname.endsWith('/profiles')){started.resolve();await release.promise;return Response.json(null);}};
  const missing=f.service.getForDisplay(name,'details',{refresh:true});await started.promise;
  const latest=await f.service.getForDisplay(name,'profile',{refresh:true});
  release.resolve();await assert.rejects(missing,error=>error.status===404);
  assert.deepEqual(f.store.get(name,'profile').profile,latest.profile);
  f.state.status=503;assert.equal((await f.service.get(name,'profile')).profile.itemLevel,1740);
});

test('late display subscribers inherit the original strict request ordering for memory and persisted invalidation',async t=>{
  const f=fixture(t),started=deferred(),release=deferred();
  f.state.hook=async url=>{if(!url.pathname.endsWith('/profiles')){started.resolve();await release.promise;return Response.json(null);}};
  const strict=f.service.get(name,'details').catch(error=>error.status);await started.promise;
  const newer=await f.service.getForDisplay(name,'profile',{refresh:true});
  const joined=f.service.getForDisplay(name,'details',{refresh:true}).catch(error=>error.status);
  release.resolve();assert.equal(await strict,404);assert.equal(await joined,404);
  assert.deepEqual(f.store.get(name,'profile')?.profile,newer.profile);
  f.state.status=503;assert.equal((await f.service.get(name,'profile')).profile.itemLevel,1740);
});

test('null siblings definitively removes earlier snapshots while null individual grids remain empty',async t=>{
  const f=fixture(t);await f.service.getForDisplay(name,'profile',{refresh:true});await f.service.getForDisplay(name,'roster',{refresh:true});
  f.state.hook=async url=>url.pathname.endsWith('/siblings')?Response.json(null):undefined;
  await assert.rejects(f.service.getForDisplay(name,'roster',{refresh:true}),error=>error.status===404);
  assert.equal(f.store.get(name,'profile'),null);assert.equal(f.store.get(name,'roster'),null);
  f.state.hook=async url=>url.pathname.endsWith('/arkgrid')?Response.json(null):undefined;
  const empty=await f.service.getForDisplay(name,'arkgrid',{refresh:true});
  assert.equal(empty.source,'live');assert.equal(empty.arkgrid.partial,false);assert.deepEqual(empty.arkgrid.characters,[]);
});

test('a late display of a strict cached result retains its original order when a newer 404 arrives',async t=>{
  const f=fixture(t),started=deferred(),release=deferred();
  await f.service.get(name,'profile');
  f.state.hook=async url=>{if(!url.pathname.endsWith('/profiles')){started.resolve();await release.promise;return Response.json(null);}};
  const missing=f.service.getForDisplay(name,'details',{refresh:true}).catch(error=>error.status);await started.promise;
  await f.service.getForDisplay(name,'profile');assert(f.store.get(name,'profile'));
  release.resolve();assert.equal(await missing,404);assert.equal(f.store.get(name,'profile'),null);
});

test('a late aggregation preserves the original shared siblings failure order',async t=>{
  const f=fixture(t),started=deferred(),release=deferred();
  f.state.hook=async url=>{if(url.pathname.endsWith('/siblings')){started.resolve();await release.promise;return Response.json(null);}};
  const strict=f.service.get(name,'roster').catch(error=>error.status);await started.promise;
  const newer=await f.service.getForDisplay(name,'profile',{refresh:true});
  const joined=f.service.getForDisplay(name,'arkgrid',{refresh:true}).catch(error=>error.status);
  release.resolve();assert.equal(await strict,404);assert.equal(await joined,404);
  assert.deepEqual(f.store.get(name,'profile')?.profile,newer.profile);
});

test('cache leases survive more than 64 entries, release on eviction, and all end on close',async t=>{
  let actual,peak=0;const leases=new Set();
  const wrapper={beginAttempt:(...args)=>{const value=actual.beginAttempt(...args);leases.add(value);peak=Math.max(peak,leases.size);return value;},endAttempt:value=>{leases.delete(value);actual.endAttempt(value);},get:(...args)=>actual.get(...args),putSuccess:(...args)=>actual.putSuccess(...args),invalidateNotFound:(...args)=>actual.invalidateNotFound(...args)};
  const f=fixture(t,{snapshotStore:wrapper,upstreamPerMinute:1000});actual=f.store;
  f.state.hook=async url=>Response.json({...profile(),CharacterName:decodeURIComponent(url.pathname.split('/')[3])});
  for(let index=0;index<300;index++){
    const character=`캐릭터${index}`;await f.service.getForDisplay(character,'profile',{refresh:true});
    assert.equal(actual.get(character,'profile')?.profile.characterName,character);
  }
  assert.equal(leases.size,128);assert(peak<=129);
  const displaying=f.service.getForDisplay('캐릭터299','profile');
  await Promise.resolve();f.service.close();assert.equal(leases.size,1);
  await assert.rejects(displaying,error=>error.status===502);assert.equal(leases.size,0);
});

test('official throttling and actual request timeout reuse a snapshot without changing its capture time',async t=>{
  const f=fixture(t,{requestTimeoutMs:20});await f.service.getForDisplay(name,'profile',{refresh:true});f.advance(1000);f.state.status=429;
  const limited=await f.service.getForDisplay(name,'profile',{refresh:true});assert.equal(limited.source,'saved');assert.equal(limited.refreshFailed,'rate_limited');assert.equal(limited.capturedAt,at);
  const count=f.state.calls.length;await f.service.getForDisplay(name,'profile',{refresh:true});assert.equal(f.state.calls.length,count);
  f.restart();f.state.status=200;f.state.hook=async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('private timeout')),{once:true}));
  const timed=await f.service.getForDisplay(name,'profile',{refresh:true});assert.equal(timed.source,'saved');assert.equal(timed.refreshFailed,'official_unavailable');assert.equal(timed.updatedAt,at);
});

test('a real SQLite write failure preserves the last snapshot while a live response succeeds',async t=>{
  const f=fixture(t);await f.service.getForDisplay(name,'profile',{refresh:true});f.advance(1000);f.state.level='1760.00';
  const db=new DatabaseSync(f.path);db.exec("CREATE TRIGGER reject_write BEFORE INSERT ON snapshots BEGIN SELECT RAISE(ABORT,'synthetic full'); END;");
  const live=await f.service.getForDisplay(name,'profile',{refresh:true});assert.equal(live.source,'live');assert.equal(live.profile.itemLevel,1760);
  db.exec('DROP TRIGGER reject_write');db.close();assert.equal(f.store.get(name,'profile').profile.itemLevel,1740);
  f.state.status=503;const saved=await f.service.getForDisplay(name,'profile',{refresh:true});assert.equal(saved.source,'saved');assert.equal(saved.profile.itemLevel,1740);
  f.state.status=200;f.advance(1000);await f.service.getForDisplay(name,'profile',{refresh:true});assert.equal(f.store.get(name,'profile').profile.itemLevel,1760);
});

test('a failed definitive deletion disables saved fallback so a missing character cannot return later',async t=>{
  for(const failAt of ['delete','attempt']){
    let actual,failed=false;
    const wrapper={beginAttempt:(...args)=>{if(failed&&failAt==='attempt')throw Error('synthetic attempt failure');return actual.beginAttempt(...args);},endAttempt:(...args)=>actual.endAttempt(...args),get:(...args)=>actual.get(...args),putSuccess:(...args)=>actual.putSuccess(...args),invalidateNotFound:(...args)=>{if(failAt==='delete')throw Error('synthetic disk failure');return actual.invalidateNotFound(...args);}};
    const f=fixture(t,{snapshotStore:wrapper});actual=f.store;await f.service.getForDisplay(name,'profile',{refresh:true});
    failed=true;f.state.status=404;await assert.rejects(f.service.getForDisplay(name,'profile',{refresh:true}),error=>error.status===404);
    assert(f.store.get(name,'profile'));failed=false;f.state.status=503;
    await assert.rejects(f.service.getForDisplay(name,'profile',{refresh:true}),error=>error.status===502);
  }
});

test('closing during a delayed successful upstream response neither returns nor saves stale fallback',async t=>{
  const f=fixture(t);await f.service.getForDisplay(name,'profile',{refresh:true});const started=deferred(),release=deferred();
  f.state.hook=async()=>{started.resolve();await release.promise;};f.advance(1000);f.state.level='1770.00';
  const pending=f.service.getForDisplay(name,'profile',{refresh:true});await started.promise;f.service.close();release.resolve();
  await assert.rejects(pending,error=>error.status===502);assert.equal(f.store.get(name,'profile').profile.itemLevel,1740);
});
