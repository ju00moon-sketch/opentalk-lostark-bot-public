import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.js';
import { createWebServer } from '../src/server.js';
import { verifyOwnership } from './helpers/access.js';

const origin='https://opentalk.example.invalid';
const baseRoute='/api/auth/characters';
const hash=value=>createHash('sha256').update(value).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const row=(name,server='루페온',level='1,740.00')=>({CharacterName:name,ServerName:server,CharacterClassName:'바드',ItemAvgLevel:level});
function supportDetails(name='인증한바드'){
  const tip=parts=>JSON.stringify(Object.fromEntries(parts.map(([title,body],index)=>['Element_'+index,{type:'ItemPartBox',value:{Element_000:title,Element_001:body}}])));
  const item=(Type,basic,extra=[])=>({Type,Grade:'고대',Tooltip:tip([['기본 효과',basic],...extra])});
  return {ArmoryProfile:{...row(name),CharacterClassName:'도화가',Stats:[{Type:'특화',Value:'600'},{Type:'신속',Value:'1800'}]},
    ArmoryEquipment:[...['투구','상의','하의','장갑','어깨'].map(type=>item(type,'지능 +100000')),item('무기','무기 공격력 +200000'),item('완갑','지능 +30000<br>무기 공격력 +10000<br>기본 공격력 +1000'),...['목걸이','귀걸이','귀걸이','반지','반지'].map(type=>item(type,'지능 +20000',[['연마 효과','']])),item('어빌리티 스톤','체력 +20000'),
      {Type:'팔찌',Grade:'고대',Tooltip:JSON.stringify({title:{type:'ItemTitle',value:{leftStr2:'아이템 티어 4'}},effect:{type:'ItemPartBox',value:{Element_000:'팔찌 효과',Element_001:"<img src='emoticon_tooltip_bracelet_locked'></img>신속 +100<br><img src='emoticon_tooltip_bracelet_changeable'></img>최대 생명력 +14000"}}})}],
    ArmoryAvatars:[],ArmoryEngraving:{ArkPassiveEffects:[{Name:'마나의 흐름',Grade:'유물',Level:4,AbilityStoneLevel:null},{Name:'각성',Grade:'유물',Level:4,AbilityStoneLevel:2}]},
    ArkPassive:{Effects:[['진화','정열의 춤사위',2],['진화','선각자',1],['진화','기원',1],['진화','입식 타격가',2],['깨달음','만개',3],['깨달음','묵법 : 접무',3]].map(([Name,name,level])=>({Name,Description:`${Name} 2티어 ${name} Lv.${level}`})),Points:[{Name:'깨달음',Description:'6랭크 30레벨'},{Name:'진화',Description:'6랭크 20레벨'}]},
    ArmorySkills:[{Name:'묵법 : 해우물',Level:10,Tripods:[{Name:'빠른 준비',IsSelected:true}]}],ArmoryGem:{Gems:null,Effects:{Description:'',Skills:[]}},ArkGrid:{Slots:[],Effects:[]}};
}

async function setup(t){
  const dir=await mkdtemp(join(tmpdir(),'member-character-http-')),path=join(dir,'auth.sqlite');
  const store=createStore(path),db=new DatabaseSync(path),accounts={};let now=1790000000000;
  db.exec('PRAGMA foreign_keys=ON');
  for(const [i,name] of ['owner','member','other','pending'].entries()){
    const token=randomBytes(32).toString('base64url'),tokenHash=hash(token);
    store.createSession({provider:name==='member'?'kakao':'discord',providerId:String(90000+i),displayName:name,
      tokenHash,expiresAt:now+86400000,epoch:0},now);
    accounts[name]={...store.getSession(tokenHash,now),token,tokenHash};
  }
  store.guild.bootstrapOwner(accounts.owner.id,now);
  store.signup.complete(accounts.member.id,'가입닉네임',{characterName:'가입정보캐릭터',serverName:'루페온',characterClass:'바드',itemLevel:1700},now);
  for(const [account,name] of [[accounts.member,'인증한바드'],[accounts.other,'다른인증']]){
    verifyOwnership(store,account,name,now);store.guild.apply(account.id,name,now);
    store.guild.review(accounts.owner.id,account.id,'approved',1,now);
  }
  const control={calls:[],hook:null,details:null,rosters:{
    '인증한바드':[row('인증한바드'),row('다른서버바드','카마인','1,750.83'),row('부캐바드','루페온','1,650.00')],
    '다른인증':[row('다른인증'),row('외부캐릭터')],
  }};
  const fetchImpl=async(input,init)=>{
    const url=new URL(input);control.calls.push({path:url.pathname,method:init.method});
    if(control.hook){const response=await control.hook(url,init);if(response)return response;}
    if(url.pathname.endsWith('/siblings'))return Response.json(control.rosters[decodeURIComponent(url.pathname.split('/')[2])]||[]);
    if(url.pathname.endsWith('/profiles')){
      const name=decodeURIComponent(url.pathname.split('/')[3]);
      const found=Object.values(control.rosters).flat().find(r=>r.CharacterName===name);
      return Response.json({...found,CombatPower:'12,345.67',CharacterImage:'https://cdn-lostark.game.onstove.com/armory/profile/example.png'});
    }
    if(/^\/armories\/characters\/[^/]+$/.test(url.pathname))return control.details
      ?Response.json(control.details):Response.json({error:'unavailable'},{status:503});
    throw new Error('Unexpected external request');
  };
  const service=createWebServer({config:{origin,host:'127.0.0.1',port:0,dbPath:path,
    providers:{discord:{clientId:'12345678',clientSecret:'synthetic-secret'}},
    automaticApproval:{enabled:true,discordGuildId:'123456',discordRoleId:'12345',lostArkApiKey:'synthetic-key'}},fetchImpl,now:()=>now});
  service.server.listen(0,'127.0.0.1');await once(service.server,'listening');
  const base=`http://127.0.0.1:${service.server.address().port}`;
  t.after(async()=>{await service.close();db.close();store.close();assert(basename(dir).startsWith('member-character-http-'));await rm(dir,{recursive:true,force:true});});
  async function request(route='',{user=accounts.member,body,headers={},method=body===undefined?'GET':'POST'}={}){
    const response=await fetch(base+baseRoute+route,{method,redirect:'manual',headers:{
      ...(user?{Cookie:`__Host-web_session=${user.token}`,Origin:origin,'X-CSRF-Token':createHash('sha256').update(`web-csrf:${user.token}`).digest('base64url')} : {}),
      ...(body===undefined?{}:{'Content-Type':'application/json'}),...headers,
    },...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,headers:response.headers,data:await response.json()};
  }
  function selection(characterName='다른서버바드',user=accounts.member){
    const snapshot=store.characterPreferences.capture(user.id,user.tokenHash,now);
    return {characterName,revision:snapshot.preferenceRevision,anchorFingerprint:snapshot.anchorFingerprint};
  }
  return {store,db,accounts,control,request,selection,now:()=>now,advance:ms=>{now+=ms;}};
}

test('member character endpoints reject anonymous and pending users before upstream work',async t=>{
  const h=await setup(t);
  for(const path of ['', '/profile','/representative']){
    const body=path==='/representative'?{characterName:'임의캐릭터',revision:0,anchorFingerprint:'a'.repeat(64)}:undefined;
    assert.equal((await h.request(path,{user:null,body})).status,401);
    assert.equal((await h.request(path,{user:h.accounts.pending,body})).status,403);
  }
  assert.equal(h.control.calls.length,0);
});

test('the account gets server-grouped official siblings from its verified anchor without private snapshot fields',async t=>{
  const h=await setup(t),result=await h.request();
  assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
  assert.equal(result.data.anchor.characterName,'인증한바드');assert.equal(result.data.anchor.source,'verified');
  assert.equal(result.data.representative.characterName,'인증한바드');assert.equal(result.data.selected,null);
  assert.deepEqual(result.data.groups.map(g=>g.serverName),['루페온','카마인']);
  assert.equal(result.data.characters.length,3);
  assert.equal(h.control.calls[0].path,'/characters/'+encodeURIComponent('인증한바드')+'/siblings');
  const encoded=JSON.stringify(result.data);for(const forbidden of ['sessionHash','stoveAccountId','synthetic-key',h.accounts.member.tokenHash])assert(!encoded.includes(forbidden));
});

test('saving a same-account character from another server leaves approval ownership and signup unchanged',async t=>{
  const h=await setup(t),id=h.accounts.member.id;
  const before={guild:h.store.guild.state(id),ownership:h.store.ownership.summary(id),signup:h.store.signup.state(id)};
  const result=await h.request('/representative',{body:h.selection()});
  assert.equal(result.status,200);assert.equal(result.data.selected.characterName,'다른서버바드');
  assert.equal(result.data.selected.serverName,'카마인');assert.equal(result.data.revision,1);
  assert.deepEqual({guild:h.store.guild.state(id),ownership:h.store.ownership.summary(id),signup:h.store.signup.state(id)},before);
  assert.equal((await h.request()).data.representative.characterName,'다른서버바드');
});

test('foreign-account snapshots external names and injected profile fields cannot change the preference',async t=>{
  const h=await setup(t);
  const other=await h.request('/representative',{user:h.accounts.other,body:h.selection()});assert.equal(other.status,409);
  const external=await h.request('/representative',{body:h.selection('외부캐릭터')});assert.equal(external.status,422);
  const calls=h.control.calls.length;
  for(const extra of [{userId:h.accounts.other.id},{itemLevel:9999},{anchor:'외부캐릭터'}])assert.equal((await h.request('/representative',{body:{...h.selection(),...extra}})).status,400);
  assert.equal(h.control.calls.length,calls);assert.equal(h.store.characterPreferences.capture(h.accounts.member.id,h.accounts.member.tokenHash,h.now()).selected,null);
});

test('origin CSRF query and method checks run before official requests',async t=>{
  const h=await setup(t);
  for(const path of ['', '/profile']){
    assert.equal((await h.request(path,{headers:{Origin:'https://evil.invalid'}})).status,403);
    assert.equal((await h.request(path,{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  }
  assert.equal((await h.request('/representative',{body:h.selection(),headers:{'X-CSRF-Token':'wrong'}})).status,403);
  assert.equal((await h.request('/representative',{body:h.selection(),headers:{Origin:''}})).status,403);
  assert.equal((await h.request('?name=외부캐릭터')).status,400);
  const wrong=await h.request('/representative');assert.equal(wrong.status,405);assert.equal(wrong.headers.get('allow'),'POST');
  assert.equal(h.control.calls.length,0);
});

test('POST bypasses cached siblings and will not save a character removed since the list was shown',async t=>{
  const h=await setup(t);assert.equal((await h.request()).status,200);
  h.control.rosters['인증한바드']=h.control.rosters['인증한바드'].filter(r=>r.CharacterName!=='다른서버바드');
  const result=await h.request('/representative',{body:h.selection()});assert.equal(result.status,422);
  assert.equal(h.control.calls.filter(c=>c.path.endsWith('/siblings')).length,2);
  assert.equal(h.store.characterPreferences.capture(h.accounts.member.id,h.accounts.member.tokenHash,h.now()).preferenceRevision,0);
});

test('simultaneous duplicate POSTs commit one representative and reject the stale revision',async t=>{
  const h=await setup(t),started=deferred(),release=deferred();let count=0;
  h.control.hook=async url=>{if(url.pathname.endsWith('/siblings')){if(++count===2)started.resolve();await release.promise;}};
  const body=h.selection(),first=h.request('/representative',{body}),second=h.request('/representative',{body});
  await started.promise;release.resolve();const results=await Promise.all([first,second]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal(h.store.characterPreferences.capture(h.accounts.member.id,h.accounts.member.tokenHash,h.now()).preferenceRevision,1);
});

test('approval revocation during fresh lookup prevents a delayed representative write',async t=>{
  const h=await setup(t),started=deferred(),release=deferred();
  h.control.hook=async url=>{if(url.pathname.endsWith('/siblings')){started.resolve();await release.promise;}};
  const result=h.request('/representative',{body:h.selection()});await started.promise;
  const membership=h.store.guild.state(h.accounts.member.id).membership;
  h.store.guild.review(h.accounts.owner.id,h.accounts.member.id,'revoked',membership.revision,h.now());
  release.resolve();assert.equal((await result).status,403);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM user_character_preferences').get().n,0);
});

test('session removal while a profile loads returns no extended representative data',async t=>{
  const h=await setup(t),started=deferred(),release=deferred();
  h.control.hook=async url=>{if(url.pathname.endsWith('/profiles')){started.resolve();await release.promise;}};
  const result=h.request('/profile');await started.promise;h.store.deleteSession(h.accounts.member.tokenHash);release.resolve();
  const response=await result;assert.equal(response.status,401);assert.deepEqual(response.data,{error:'login_required'});
});

test('a representative changed during profile loading invalidates the earlier response',async t=>{
  const h=await setup(t),started=deferred(),release=deferred();
  h.control.hook=async url=>{if(url.pathname.endsWith('/profiles')){started.resolve();await release.promise;}};
  const old=h.request('/profile');await started.promise;
  assert.equal((await h.request('/representative',{body:h.selection()})).status,200);
  release.resolve();const response=await old;assert.equal(response.status,409);assert.deepEqual(response.data,{error:'member_character_changed'});
});

test('profile enrichment uses the chosen representative and degrades to its basic official summary',async t=>{
  const h=await setup(t);assert.equal((await h.request('/representative',{body:h.selection()})).status,200);
  const full=await h.request('/profile');assert.equal(full.status,200);assert.equal(full.data.profileAvailable,true);
  assert.equal(full.data.representative.characterName,'다른서버바드');assert.equal(full.data.representative.combatPower,12345.67);
  assert.equal(full.data.configured,true);
  h.advance(300001);h.control.hook=async url=>url.pathname.endsWith('/profiles')?Response.json({error:'temporary'},{status:503}):undefined;
  const fallback=await h.request('/profile');assert.equal(fallback.status,200);assert.equal(fallback.data.profileAvailable,false);
  assert.equal(fallback.data.representative.characterName,'다른서버바드');
});

test('profile score is calculated from official details and preserves an unavailable score explicitly',async t=>{
  const h=await setup(t);h.control.details=supportDetails();h.control.rosters['인증한바드'][0].CharacterClassName='도화가';
  const calculated=await h.request('/profile');
  assert.equal(calculated.status,200);assert.equal(calculated.data.profileAvailable,true);
  assert.equal(calculated.data.score.status,'ok');assert.equal(calculated.data.score.role,'support');
  assert(Math.abs(calculated.data.score.score-1582.008906500492)<1e-8);
  assert.equal(calculated.headers.get('cache-control'),'no-store');
  h.advance(300001);h.control.details.ArmoryAvatars={};
  const missing=await h.request('/profile');
  assert.equal(missing.status,200);assert.equal(missing.data.profileAvailable,true);
  assert.equal(missing.data.score.status,'unavailable');assert.equal(missing.data.score.score,null);
  assert(missing.data.score.omitted.length);
  h.advance(300001);h.control.details=null;
  const failed=await h.request('/profile');
  assert.equal(failed.status,200);assert.equal(failed.data.profileAvailable,true);assert.equal(failed.data.score,null);
});

test('details cannot expose a score without a validated representative profile',async t=>{
  const h=await setup(t);h.control.details=supportDetails();
  h.control.hook=async url=>url.pathname.endsWith('/profiles')?Response.json({error:'temporary'},{status:503}):undefined;
  const unavailable=await h.request('/profile');
  assert.equal(unavailable.status,200);assert.equal(unavailable.data.profileAvailable,false);assert.equal(unavailable.data.score,null);
  h.advance(300001);
  h.control.hook=async url=>url.pathname.endsWith('/profiles')?Response.json(row('인증한바드','카마인')):undefined;
  const changed=await h.request('/profile');
  assert.equal(changed.status,409);assert.deepEqual(changed.data,{error:'member_character_changed'});
});

test('a score finishing after session deletion or approval revocation is never returned',async t=>{
  for(const action of ['session','approval']){
    const h=await setup(t),started=deferred(),release=deferred();h.control.details=supportDetails();
    h.control.hook=async url=>{if(/^\/armories\/characters\/[^/]+$/.test(url.pathname)){started.resolve();await release.promise;}};
    const pending=h.request('/profile');await started.promise;
    if(action==='session')h.store.deleteSession(h.accounts.member.tokenHash);
    else {const membership=h.store.guild.state(h.accounts.member.id).membership;h.store.guild.review(h.accounts.owner.id,h.accounts.member.id,'revoked',membership.revision,h.now());}
    release.resolve();const response=await pending;
    assert.equal(response.status,action==='session'?401:403);
    assert.deepEqual(response.data,{error:action==='session'?'login_required':'approval_required'});
  }
});

test('legacy approved anchors remain usable and an owner without a character is not given an invented anchor',async t=>{
  const h=await setup(t);h.db.prepare('DELETE FROM character_ownership WHERE user_id=?').run(h.accounts.member.id);
  const legacy=await h.request();assert.equal(legacy.status,200);assert.equal(legacy.data.anchor.source,'legacy-approved');
  assert.equal(h.store.ownership.summary(h.accounts.member.id).state,'none');
  const calls=h.control.calls.length,blank=await h.request('',{user:h.accounts.owner});
  assert.equal(blank.status,409);assert.deepEqual(blank.data,{error:'anchor_required'});assert.equal(h.control.calls.length,calls);
});

test('malformed official roster duplicates and a missing anchor cannot become selection candidates',async t=>{
  const h=await setup(t);
  for(const rows of [[row('다른서버바드')],[row('인증한바드'),row('인증한바드')],[{...row('인증한바드'),ItemAvgLevel:'NaN'}]]){
    h.control.rosters['인증한바드']=rows;
    const response=await h.request('/representative',{body:h.selection()});assert.equal(response.status,502);
  }
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM user_character_preferences').get().n,0);
});
