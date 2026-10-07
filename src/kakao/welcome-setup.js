import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { requireWelcome } from './welcome.js';

const page = String.raw`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>포근해용 입장 알림 연결</title><style>
:root{color-scheme:dark;font:16px/1.6 system-ui,sans-serif;background:#10141b;color:#e9edf4}body{max-width:620px;margin:6vh auto;padding:24px}
main{background:#19212d;border:1px solid #334155;border-radius:20px;padding:28px}h1{font-size:25px;margin:0 0 12px}p{color:#c4cedd}
label{display:block;margin:16px 0 6px}input:not([type=checkbox]){box-sizing:border-box;width:100%;padding:12px;background:#111827;color:inherit;border:1px solid #64748b;border-radius:8px;font:inherit}
button{cursor:pointer;margin:14px 8px 0 0;padding:11px 18px;border:0;border-radius:8px;font:inherit;background:#a7e6d5;color:#132f28}button:disabled{opacity:.45;cursor:wait}.secondary{background:#334155;color:#edf4ff}
#status{white-space:pre-wrap;border-left:3px solid #a7e6d5;padding-left:12px}small{color:#a8b6cc}fieldset{border:0;padding:0}#roomlist label{padding:9px 0}.hidden{display:none!important}
</style><main><h1>입장 알림 연결</h1><p>포근해용 봇 계정으로 연결해 주세요. 로그인 정보는 수신기에서 카카오톡 인증 서버로 전달되며, 비밀번호는 저장하지 않습니다.</p><p id="runtime"></p>
<div id="status" role="status" aria-live="polite">연결 상태를 확인하고 있습니다.</div>
<form id="login"><label for="email">봇 계정 이메일</label><input id="email" name="email" autocomplete="username" required>
<label for="password">비밀번호</label><input id="password" name="password" type="password" autocomplete="current-password" required><button>로그인</button></form>
<section id="verify" class="hidden"><p>수신기를 새 기기로 등록해야 합니다. 인증번호를 발급한 뒤 휴대전화의 공식 카카오톡 앱에서 승인해 주세요.</p><button id="request">인증번호 발급</button></section>
<section id="approval" class="hidden"><p>휴대전화의 공식 카카오톡 앱에 표시되는 새 기기 인증 안내에서 다음 코드를 확인하고 승인해 주세요.</p><output id="approval-code" style="display:block;font-size:36px;letter-spacing:.15em;font-weight:bold"></output><p id="approval-expiry"></p><small>승인 상태는 자동으로 확인합니다. 새 코드는 자동 발급하지 않습니다.</small><br><button id="cancel" class="secondary">인증 취소</button></section>
<section id="rooms" class="hidden"><p>입장을 감지할 오픈채팅방을 선택해 주세요.</p><fieldset id="roomlist"></fieldset><button id="start">수신 연결</button><p><small id="sendnote"></small></p></section>
<section id="listening" class="hidden"><p>선택한 방의 새 입장을 기다리고 있습니다. 창을 닫아도 수신기는 계속 실행됩니다.</p><small>실제 입장 수신과 환영 발송은 상태에서 따로 확인할 수 있습니다.</small></section>
<section id="disconnected" class="hidden"><p>수신 연결이 끊겼습니다. 저장된 봇 계정 인증으로 다시 연결할 수 있습니다.</p><button id="reconnect">다시 연결</button></section>
</main><script>
const $=id=>document.getElementById(id);
let busy=false,cancelPending=false,lastRooms='',passcodeBlocked=false,lastState={},approvalTimer;
let serverStamp,clockStamp,pollNotBefore=0,approvalPaused=false;
const passcodeNote='계정 확인은 완료했지만 현재 기기 인증번호 발급 방식이 동작하지 않습니다. 연결 방식을 수정할 때까지 다시 로그인하지 않아도 됩니다.';
const passcodeUnavailable=s=>s.stage==='passcode_unavailable'||/^AUTH_PASSCODE_HTTP_404(?:_STATUS_-?[0-9]+)?$/.test(s.error||'');
const notes={LOGIN_EXPIRED:'인증 시간이 만료되었습니다. 로그인부터 다시 진행해 주세요.',LOGIN_FIELDS_REQUIRED:'이메일과 비밀번호를 입력해 주세요.',LOGIN_BUSY:'앞선 요청을 처리 중입니다.',APPROVAL_CHECK_TOO_SOON:'정해진 확인 간격을 기다리고 있습니다.',AUTH_PASSCODE_INVALID:'발급된 인증번호 형식을 확인하지 못했습니다.',AUTH_CHALLENGE_INVALID:'인증번호의 유효 시간을 확인하지 못했습니다. 다시 로그인하지 말고 연결 상태를 확인해 주세요.',AUTH_APPROVAL_RESPONSE_INVALID:'승인 대기 응답 형식을 확인하지 못했습니다.',AUTH_STATUS_12:'비밀번호가 맞지 않습니다.','AUTH_STATUS_-101':'다른 PC 기기가 로그인 중입니다. 해당 봇 계정의 PC 로그인을 종료한 뒤 다시 시도해 주세요.',AUTH_STATUS_13:'로그인 시도 제한에 도달했습니다. 잠시 후 다시 시도해 주세요.',LOCO_CONNECT_FAILED:'계정 인증 후 수신 서버 연결이 실패했습니다.',LOCO_LOGIN_TIMEOUT:'수신 서버 연결 시간이 초과되었습니다.',ROOMS_REQUIRED:'연결할 오픈채팅방을 선택해 주세요.'};
function errorNote(code){if(passcodeUnavailable({error:code}))return passcodeNote;const http=/^AUTH_HTTP_([1-5][0-9]{2})(?:_STATUS_-?[0-9]+)?$/.exec(code||'');if(http)return '카카오톡 인증 서버가 요청을 완료하지 못했습니다. ('+code+')'+(http[1]==='429'?' 반복 시도를 멈추고 잠시 기다려 주세요.':' 이 번호로 연결 문제를 확인하겠습니다.');return notes[code]||(code==='AUTH_RESPONSE_INVALID'?'카카오톡 인증 서버의 응답 형식이 예상과 다릅니다.':code==='AUTH_CONNECTION_FAILED'?'카카오톡 인증 서버와의 연결에 실패했습니다.':'연결 오류: '+code)}
function updateButtons(){document.querySelectorAll('button').forEach(b=>b.disabled=busy||cancelPending||passcodeBlocked);$('cancel').disabled=cancelPending||passcodeBlocked;}
function scheduleApproval(){
  clearTimeout(approvalTimer);const c=lastState.challenge;
  if(busy||cancelPending||approvalPaused||passcodeBlocked||lastState.stage!=='awaiting_approval'||!c||!Number.isFinite(serverStamp))return;
  const expiry=clockStamp+Math.max(0,c.expiresAt-serverStamp);
  const next=clockStamp+Math.max(0,c.nextPollAt-serverStamp);
  const delay=Math.max(0,Math.min(expiry,Math.max(next,pollNotBefore))-performance.now());
  approvalTimer=setTimeout(()=>{
    if(performance.now()>=expiry){$('approval-code').textContent='';lastState={...lastState,challenge:undefined};$('status').textContent=notes.LOGIN_EXPIRED;}
    else call('check-approval');
  },delay);
}
function render(s,receivedAt=performance.now()){
  lastState=s;if(Number.isFinite(s.serverNow)){serverStamp=s.serverNow;clockStamp=receivedAt;}
  passcodeBlocked=passcodeUnavailable(s);const stage=passcodeBlocked?'passcode_unavailable':s.stage;
  if(stage!=='awaiting_approval')approvalPaused=false;
  for(const [id,visible]of [['login',stage==='login'],['verify',stage==='registration_required'],['approval',stage==='awaiting_approval'],['rooms',stage==='connected'],['listening',stage==='listening'],['disconnected',stage==='disconnected']])$(id).classList.toggle('hidden',!visible);
  if(stage!=='login')$('password').value='';
  const c=stage==='awaiting_approval'?s.challenge:undefined;
  const current=Number.isFinite(serverStamp)?serverStamp+performance.now()-clockStamp:Infinity;
  $('approval-code').textContent=c&&current<c.expiresAt?c.passcode:'';
  $('approval-expiry').textContent=c?'인증 유효 시간: '+new Date(c.expiresAt).toLocaleTimeString('ko-KR')+'까지':'';
  $('runtime').textContent=s.runtime==='server'?'입장 수신은 상시 서버에서 실행됩니다. 인증을 마치면 PC를 꺼도 계속 동작합니다.':'입장 수신은 이 PC에서 실행됩니다. PC를 끄면 중지됩니다.';
  $('sendnote').textContent=s.sending?'연결 후 새 입장부터 환영 메시지를 보냅니다.':'먼저 실제 입장 수신을 확인합니다. 이 단계에서는 채팅 메시지를 보내지 않습니다.';
  const key=JSON.stringify(s.rooms||[]);if(key!==lastRooms){lastRooms=key;$('roomlist').replaceChildren();for(const room of s.rooms||[]){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=room.id;input.checked=(s.rooms.length===1);label.append(input,document.createTextNode(' '+room.name));$('roomlist').append(label)}}
  const labels={login:'봇 계정 로그인이 필요합니다.',registration_required:'계정 확인 완료 · 새 기기 인증이 필요합니다.',awaiting_approval:'휴대전화에서 새 기기 승인을 기다리고 있습니다.',connected:'계정과 수신 서버 연결 완료',listening:'입장 수신 대기 중',disconnected:'수신 연결 끊김'};
  $('status').textContent=passcodeBlocked?passcodeNote:(labels[stage]||stage)+(s.receivedJoins!==undefined?'\n실제 입장 수신: '+s.receivedJoins+'건 · 환영 발송: '+(s.sending?'켜짐':'꺼짐'):'')+(s.error?'\n상태: '+errorNote(s.error):'');
  updateButtons();scheduleApproval();
}
async function cancelApproval(){
  if(cancelPending||passcodeBlocked)return;
  cancelPending=true;approvalPaused=true;clearTimeout(approvalTimer);$('approval-code').textContent='';updateButtons();
  try{
    const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'cancel'})});
    const s=await r.json();if(!r.ok)throw new Error(errorNote(s.error));
    render({...lastState,...s,challenge:undefined});
  }catch(e){$('status').textContent=e.message}
  finally{cancelPending=false;updateButtons();if(!busy)await refresh();}
}
async function call(action,body={}){
  if(action==='cancel')return cancelApproval();
  if(busy||cancelPending||passcodeBlocked)return;
  busy=true;clearTimeout(approvalTimer);if(action==='check-approval')pollNotBefore=performance.now()+3000;updateButtons();
  let reload=false;
  try{
    const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...body})});
    const s=await r.json();
    if(!r.ok){
      if(passcodeUnavailable(s)){render({...lastState,stage:'passcode_unavailable',challenge:undefined,error:s.error});return;}
      if(s.error==='APPROVAL_CHECK_TOO_SOON')pollNotBefore=performance.now()+3000;
      reload=true;throw new Error(errorNote(s.error));
    }
    reload=true;
  }catch(e){$('status').textContent=e.message}
  finally{busy=false;updateButtons();if(reload&&!cancelPending)await refresh();}
}
$('login').onsubmit=e=>{e.preventDefault();const password=$('password').value;$('password').value='';call('login',{email:$('email').value,password})};
$('request').onclick=()=>call('request-code');$('cancel').onclick=()=>call('cancel');$('start').onclick=()=>call('start',{rooms:[...$('roomlist').querySelectorAll('input:checked')].map(i=>i.value)});$('reconnect').onclick=()=>call('reconnect');
async function refresh(){if(busy||cancelPending)return;try{const started=performance.now();const r=await fetch(location.pathname+'?status');if(r.ok)render(await r.json(),started)}catch{}}
refresh();setInterval(refresh,5000);
</script></html>`;

export function createWelcomeSetup({ status, action, token = randomBytes(32).toString('hex') }) {
  requireWelcome(/^[a-f0-9]{64}$/.test(token), 'INVALID_SETUP_TOKEN');
  const path = `/setup/${token}`;
  const encoded = Buffer.from(path);
  let origin;
  let pending = false;
  const server = createServer(async (req, res) => {
    const respond = (code, data, html = false) => {
      res.writeHead(code, { 'content-type': html ? 'text/html; charset=utf-8' : 'application/json',
        'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
      res.end(html ? data : JSON.stringify(data));
    };
    const base = req.url?.split('?')[0] ?? '';
    const bytes = Buffer.from(base);
    if (req.headers.host !== new URL(origin).host || bytes.length !== encoded.length || !timingSafeEqual(bytes, encoded))
      return respond(404, { error: 'NOT_FOUND' });
    if (req.method === 'GET') return req.url === path ? respond(200, page, true)
      : req.url === path + '?status' ? respond(200, status()) : respond(404, { error: 'NOT_FOUND' });
    if (req.method !== 'POST' || req.url !== path) return respond(404, { error: 'NOT_FOUND' });
    if (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? ''))
      return respond(403, { error: 'ORIGIN_REQUIRED' });
    let ownsPending = false;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; requireWelcome(size <= 8192, 'SETUP_BODY_TOO_LARGE'); chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('INVALID_SETUP_JSON'); }
      requireWelcome(body && typeof body === 'object' && !Array.isArray(body), 'INVALID_SETUP_JSON');
      if (pending && body.action !== 'cancel') return respond(409, { error: 'LOGIN_BUSY' });
      if (body.action !== 'cancel') { pending = true; ownsPending = true; }
      await action(body.action, body);
      const { challenge, ...ordinaryStatus } = status();
      respond(200, ordinaryStatus);
    } catch (error) {
      respond(400, { error: /^[A-Z][A-Z0-9_-]{0,79}$/.test(error.code ?? '') ? error.code : 'SETUP_REQUEST_FAILED' });
    } finally { if (ownsPending) pending = false; }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return {
    async listen(port = 0) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      origin = `http://127.0.0.1:${server.address().port}`;
      return `${origin}${path}`;
    },
    close: () => new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())),
  };
}
