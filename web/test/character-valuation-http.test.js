import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createWebServer} from '../src/server.js';
import {approvedRequester} from './helpers/access.js';

test('valuation is public, validates query, and keeps answering after a logout mid-request',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'valuation-http-')),dbPath=join(dir,'auth.sqlite'),now=1790000000000;
  let calls=0,release,entered;const enteredPromise=new Promise(resolve=>{entered=resolve;});
  const block=new Promise(resolve=>{release=resolve;});
  const profile={CharacterName:'테스트바드',ServerName:'루페온',CharacterClassName:'바드',ItemAvgLevel:'1740'};
  const app=createWebServer({config:{origin:'https://opentalk.example.invalid',host:'127.0.0.1',port:0,dbPath,providers:{},automaticApproval:{lostArkApiKey:'synthetic'}},now:()=>now,
    fetchImpl:async()=>{calls++;entered();await block;return Response.json({ArmoryProfile:profile,ArmoryEquipment:[],ArmoryGem:{Gems:[]},ArmoryEngraving:{ArkPassiveEffects:[]},ArkGrid:{Slots:[]}});}});
  t.after(async()=>{release();await app.close();await rm(dir,{recursive:true,force:true});});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const base=`http://127.0.0.1:${app.server.address().port}`,url=base+'/api/character/valuation?name='+encodeURIComponent('테스트바드')+'&scope=character';
  assert.equal((await fetch(url+'&scope=character')).status,400);assert.equal(calls,0);
  const request=approvedRequester(dbPath,now);
  for(const suffix of ['&scope=character','&refresh=2','&unknown=1'])assert.equal((await request(url+suffix)).status,400);
  assert.equal((await request(url,{headers:{Origin:'https://foreign.invalid'}})).status,403);assert.equal(calls,0);
  const pending=request(url);await enteredPromise;
  const session=await(await request(base+'/api/auth/session')).json();
  const loggedOut=await request(base+'/api/auth/logout',{method:'POST',headers:{Origin:'https://opentalk.example.invalid','X-CSRF-Token':session.csrfToken}});
  assert.equal(loggedOut.status,204);release();
  const response=await pending;assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(url)).status,200,'anonymous visitors read the same public valuation');
});

test('details snapshots exclude price inputs and still survive restart after valuation parsing',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'valuation-snapshot-')),dbPath=join(dir,'auth.sqlite');
  const now=1790000000000,config={origin:'https://opentalk.example.invalid',host:'127.0.0.1',port:0,dbPath,providers:{},automaticApproval:{lostArkApiKey:'synthetic'}};
  const payload={ArmoryProfile:{CharacterName:'테스트바드',ServerName:'루페온',CharacterClassName:'바드',ItemAvgLevel:'1740'},ArmoryEquipment:[],ArmoryGem:{Gems:[]},ArmoryEngraving:{ArkPassiveEffects:[]},ArkGrid:{Slots:[]}};
  let app; t.after(async()=>{await app?.close();await rm(dir,{recursive:true,force:true});});
  async function start(fetchImpl){app=createWebServer({config,now:()=>now,fetchImpl});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');return `http://127.0.0.1:${app.server.address().port}`;}
  let base=await start(async()=>Response.json(payload));const request=approvedRequester(dbPath,now),query='/api/character/spec?name='+encodeURIComponent('테스트바드')+'&section=details&refresh=1';
  const live=await(await request(base+query)).json();assert.equal(live.source,'live');assert.equal(live.valuationTargets,undefined);
  await app.close();base=await start(async()=>Response.json({},{status:503}));
  const response=await request(base+query),saved=await response.json();assert.equal(response.status,200);assert.equal(saved.source,'saved');assert.equal(saved.valuationTargets,undefined);
});
