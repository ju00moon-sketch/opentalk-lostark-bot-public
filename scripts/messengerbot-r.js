// 포근해용 — 카카오톡 오픈채팅방 브리지 (메신저봇R 스크립트)
//
// 승인된 기기 배포에서 기존 SERVER·ROOMS·ALLOWED_ROOM_IDS를 보존해 교체한다. 재컴파일·재개는 별도 절차다.
// 같은 브리지 스크립트를 여러 개 활성화하지 않는다.
//   1) SERVER : 봇 서버 주소 + 비밀 경로   예: "http://서버주소/bridge/message/비밀경로"
//   2) ROOMS  : (선택) 허용한 단체방의 제목을 추가로 제한한다. 빈 배열이어도 ID 허용 목록은 필요하다.
//   3) ALLOWED_ROOM_IDS : 수신에 동의한 단체방의 conversation shortcut ID 문자열 목록. 기본값은 빈 목록이다.
//
// 동작: "/"·"."로 시작하는 커맨드, 접두사 없는 "ㅂㅂㄱ"·"ㄱㅁㄱ"·"ㄱㅁ"·"ㅂㅆㅇㄱ"·"ㄱㅁㅈ"·"ㅊㅊ"·"ㅊㅊㅎㅎ"·"ㄱㄹㄷ"와 단독 "한마디"·"ㅎㅁㄷ"·"ㅈㅁㅊ", "A vs B" 비교와 "["로 시작하는 이모티콘만 서버에 보내고,
//       그룹 여부와 ID 허용 조건을 통과한 요청만 서버에 보낸다. 연결 후 응답은 최대 30초까지 기다린다.
//       이미지(캐릭터·체방 차트·이모티콘)는 폰 봇이 그림을 못 보내므로 미리보기 카드 링크(link)로 먼저 보내고 본문(messages 또는 text)을 이어 보낸다.
//       /등록은 보낸 사람의 카톡 닉네임에 묶인다 — 닉네임을 바꾸면 다시 /등록.
//       자동 알림은 기본으로 꺼져 있다. 별도로 켜면 한국 시간 수요일 당일 공지를 60초마다 조회한다.
//       허용한 ID의 단체방만 기억하며, 응답과 같은 발신 예산·시도 기록을 적용한다.
//       한 메시지는 1,500자 이하이며 묶음 안에서 최신 공지가 위에 온다. 다른 날짜의 공지는 보내지 않는다.
//       방별 진행 기록은 앱 내부에 저장한다. Android 12 이상은 재컴파일·재부팅 후 방 알림을 다시 받아야 답장할 수 있다.
//       발신 기록 저장 오류는 모든 응답을, 공지 기록 저장 오류는 자동 알림을 중단한다. 기록을 임의로 지우지 않는다.
//       AUTO_UPDATES 변경과 폰 스크립트 교체만으로 기기에서 재컴파일·재개가 완료되는 것은 아니다.
//
// 폰 준비:
//   메신저봇R 설치 → 앱에서 알림 접근 권한 허용 → 카카오톡 알림(내용 미리보기 포함) 켜기 →
//   봇 계정으로 오픈채팅방 참여(방 알림도 켜 두기) → 배터리 최적화에서 메신저봇R·카카오톡 제외(안 하면 화면 꺼진 뒤 멈춘다)
//   절전 최적화 제외 필요: 제외하지 않으면 60초 주기 자동 조회가 절전 중 멈추고, 방에 메시지가 와서 앱이 깨어날 때만 다시 돈다.

var SERVER = "http://서버주소/bridge/message/비밀경로";
var ROOMS = [];
// 동의한 단체방의 conversation shortcut ID 문자열. 빈 목록은 모든 방에서 응답하지 않는다.
var ALLOWED_ROOM_IDS = [];
// 요청 없는 공지는 기본으로 보내지 않는다. 카톡만 쓰면 수요일 공지의 즉시성은 줄어든다.
var AUTO_UPDATES = false;
// 수신자의 읽기 부담과 연속 사용을 고려한 기본 설정. 허용 응답의 deliveryPolicy로 갱신할 수 있다.
var DELIVERY_POLICY = {
  requestMessages: 2, requestChars: 2600, roomIntervalMs: 2000, userIntervalMs: 3000,
  repeatIntervalMs: 15000, windowMs: 60000, roomMessages: 12, roomChars: 9000,
  userMessages: 6, userChars: 4500, attemptTtlMs: 86400000, attemptLimit: 2048
};
var DELIVERY_LIMIT_NOTICE = "답이 한꺼번에 너무 많이 나가서 잠시 쉬어 갈게요. 조금 뒤에 다시 불러 주세요.";
var deliveryLock = null;
var deliveryPrefs = null;
var deliveryState = null;
var deliveryBlocked = false;
var deliveryPending = {};
var DELIVERY_MAX_STORE = 1048576;

var TIMEOUT_MS = 30000; // 연결 후 응답을 기다리는 소켓 읽기 제한

// SERVER를 아직 안 채웠으면 방에 그 사실을 알린다 — 파일을 그대로 붙여 넣으면 자리표시자가 남는다
var SERVER_NOT_SET = SERVER.indexOf("서버주소") !== -1 || SERVER.indexOf("비밀경로") !== -1;

var UPDATE_INTERVAL_MS = 60000;
var UPDATE_TIMEOUT_MS = 10000;
var UPDATE_MAX_BODY = 1048576;
var UPDATE_MAX_MESSAGE = 1500;
var UPDATE_HEADER = "❕ 로스트아크 공지사항\n\n";
var updateTimer = null;
var updateLock = null;
var updateBusy = null;
var updateStopped = null;
var updatePrefs = null;
var updateState = null;
var updateBlocked = false;
var lastUpdatePollAt = 0; // 마지막 조회 시작 시각(ms). 메시지 수신 시 이 값으로부터 60초가 지났을 때만 추가 조회한다.
var UPDATE_WAKE_MIN_MS = 60000;

function updateLog(message) {
  try { Log.e("포근해용 업데이트 알림: " + message); } catch (ignored) {}
}

// 한국 시간 HH:MM — 로그에서 조회가 언제 돌았는지 볼 수 있게 한다.
function updateClock() {
  try {
    var kst = new Date(new Date().getTime() + 9 * 60 * 60 * 1000);
    var hours = kst.getUTCHours();
    var minutes = kst.getUTCMinutes();
    return (hours < 10 ? "0" : "") + hours + ":" + (minutes < 10 ? "0" : "") + minutes;
  } catch (ignored) { return "--:--"; }
}

function updateInteger(value) {
  return typeof value === "number" && isFinite(value) && value >= 0 && value <= 9007199254740991 && Math.floor(value) === value;
}

function updateRoomAllowed(room) {
  return typeof room === "string" && room.length > 0 && (ROOMS.length === 0 || ROOMS.indexOf(room) !== -1);
}

function bridgeRoomAllowed(room, isGroupChat, identity) {
  if (isGroupChat !== true || !identity || identity.source !== "android-conversation-shortcut-v1"
    || !Array.isArray(ALLOWED_ROOM_IDS) || ALLOWED_ROOM_IDS.length > 128 || !updateRoomAllowed(room)) return false;
  var valid = function (id) { return typeof id === "string" && id.trim().length > 0
    && id.length <= 512 && !/[\x00-\x1f\x7f-\x9f]/.test(id); };
  if (!valid(identity.roomId)) return false;
  for (var i = 0; i < ALLOWED_ROOM_IDS.length; i++) if (!valid(ALLOWED_ROOM_IDS[i])) return false;
  return ALLOWED_ROOM_IDS.indexOf(identity.roomId) !== -1;
}

function deliveryPolicyValid(value) {
  var countMax = { requestMessages: 5, requestChars: 4000, roomMessages: 60, roomChars: 30000, userMessages: 30, userChars: 15000 };
  var keys = ["requestMessages", "requestChars", "roomIntervalMs", "userIntervalMs", "repeatIntervalMs",
    "windowMs", "roomMessages", "roomChars", "userMessages", "userChars", "attemptTtlMs", "attemptLimit"];
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (var name in value) if (Object.prototype.hasOwnProperty.call(value, name) && keys.indexOf(name) === -1) return false;
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var maximum = /Ms$/.test(key) ? 7 * 86400000 : key === "attemptLimit" ? 4096 : countMax[key];
    if (!updateInteger(value[key]) || value[key] < 1 || value[key] > maximum) return false;
  }
  return value.attemptTtlMs >= Math.max(value.windowMs, value.repeatIntervalMs, value.roomIntervalMs, value.userIntervalMs);
}

function deliveryLog() {
  try { Log.e("포근해용 발신 기록을 확인할 수 없어 응답을 중단했습니다."); } catch (ignored) {}
}

function deliveryLoad() {
  if (deliveryBlocked || !deliveryPolicyValid(DELIVERY_POLICY) || !deliveryLock) return false;
  deliveryLock.lock();
  try {
    if (deliveryState !== null) return true;
    deliveryPrefs = Api.getContext().getSharedPreferences("pogeun-delivery", 0);
    var raw = deliveryPrefs.getString("state", null);
    if (raw === null) { deliveryState = { version: 1, events: [] }; return true; }
    raw = String(raw);
    if (raw.length > DELIVERY_MAX_STORE) throw new Error("size");
    var state = JSON.parse(raw);
    if (!state || state.version !== 1 || !Array.isArray(state.events) || state.events.length > 4096) throw new Error("format");
    for (var field in state) if (Object.prototype.hasOwnProperty.call(state, field) && field !== "version" && field !== "events") throw new Error("field");
    var seen = {};
    var fields = ["id", "room", "user", "command", "at", "expires", "messages", "chars", "notice"];
    var hash = function (value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); };
    for (var i = 0; i < state.events.length; i++) {
      var item = state.events[i];
      if (!item || !hash(item.id) || !hash(item.room) || !hash(item.user) || !hash(item.command)
        || !updateInteger(item.at) || !updateInteger(item.expires) || item.expires <= item.at
        || !updateInteger(item.messages) || item.messages < 1 || item.messages > 1000000
        || !updateInteger(item.chars) || item.chars > 1000000 || typeof item.notice !== "boolean" || seen[item.id]) throw new Error("event");
      for (var key in item) if (Object.prototype.hasOwnProperty.call(item, key) && fields.indexOf(key) === -1) throw new Error("field");
      seen[item.id] = true;
    }
    deliveryState = state;
    return true;
  } catch (ignored) { deliveryBlocked = true; deliveryLog(); return false; }
  finally { deliveryLock.unlock(); }
}

function deliverySave() {
  try {
    var raw = JSON.stringify(deliveryState);
    if (raw.length > DELIVERY_MAX_STORE || !deliveryPrefs.edit().putString("state", raw).commit()) throw new Error("write");
    return true;
  } catch (ignored) { deliveryBlocked = true; deliveryLog(); return false; }
}

function deliveryPrune(now) {
  // A backwards clock does not expire future-dated attempts.
  var kept = [];
  for (var i = 0; i < deliveryState.events.length; i++) if (deliveryState.events[i].expires > now) kept.push(deliveryState.events[i]);
  deliveryState.events = kept;
}

function deliveryHash(value) {
  var bytes = new java.lang.String(value).getBytes("UTF-8");
  var digest = java.security.MessageDigest.getInstance("SHA-256").digest(bytes);
  var result = "";
  for (var i = 0; i < digest.length; i++) result += ("0" + (digest[i] & 255).toString(16)).slice(-2);
  return result;
}

function deliveryContext(room, group, identity, person, msg, eventKey, kind) {
  if (!bridgeRoomAllowed(room, group, identity) || typeof eventKey !== "string" || !eventKey || eventKey.length > 32768) return null;
  try {
    var user = "unknown-person";
    if (kind === "update") user = "automatic-notices";
    else if (person && person.source === "android-person-key-v1" && person.roomId === identity.roomId
      && typeof person.userId === "string" && person.userId.trim() && person.userId.length <= 512
      && !/[\x00-\x1f\x7f-\x9f]/.test(person.userId)) user = person.userId;
    return { id: deliveryHash(eventKey), room: deliveryHash(identity.roomId),
      user: deliveryHash(JSON.stringify([identity.roomId, user])),
      command: deliveryHash(String(msg).trim().replace(/^[./]/, "").replace(/\s+/g, " ")),
      roomName: room, identity: identity, group: group, kind: kind || "reply" };
  } catch (ignored) { deliveryBlocked = true; deliveryLog(); return null; }
}

function deliveryRoomCurrent(context) {
  if (!context || !bridgeRoomAllowed(context.roomName, context.group, context.identity)) return false;
  if (bridgeRawEnabled && (!bridgeStopped || bridgeStopped.get())) return false;
  if (context.kind === "update" && !AUTO_UPDATES) return false;
  if (bridgeRawEnabled) {
    if (!bridgeLock) return false;
    bridgeLock.lock();
    try {
      for (var i = 0; i < bridgeSessions.length; i++) {
        var session = bridgeSessions[i];
        // Interactive replies use the captured notification action. Renames still block cached automatic replies.
        if (session.id === context.identity.roomId && session.name === context.roomName) return session.group && (context.kind !== "update" || !session.blocked);
      }
      return false;
    } finally { bridgeLock.unlock(); }
  }
  return false; // The older callback has no independently verified conversation identity.
}

function deliveryUsage(context, now) {
  var usage = { roomMessages: 0, roomChars: 0, userMessages: 0, userChars: 0,
    roomAt: null, userAt: null, repeated: false, notice: false, duplicate: false };
  for (var i = 0; i < deliveryState.events.length; i++) {
    var event = deliveryState.events[i];
    if (event.id === context.id) usage.duplicate = true;
    if (event.room !== context.room) continue;
    if (event.messages > 0) usage.roomAt = usage.roomAt === null ? event.at : Math.max(usage.roomAt, event.at);
    var age = now - event.at;
    if (age < DELIVERY_POLICY.windowMs) {
      usage.roomMessages += event.messages; usage.roomChars += event.chars;
      if (event.notice) usage.notice = true;
    }
    if (event.user !== context.user) continue;
    if (event.messages > 0) usage.userAt = usage.userAt === null ? event.at : Math.max(usage.userAt, event.at);
    if (age < DELIVERY_POLICY.windowMs) { usage.userMessages += event.messages; usage.userChars += event.chars; }
    if (!event.notice && event.command === context.command && age < DELIVERY_POLICY.repeatIntervalMs) usage.repeated = true;
  }
  return usage;
}

function deliveryFits(usage, now, count, chars, notice) {
  var policy = DELIVERY_POLICY;
  if (usage.roomAt !== null && now - usage.roomAt < policy.roomIntervalMs) return false;
  if (!notice && ((usage.userAt !== null && now - usage.userAt < policy.userIntervalMs) || usage.repeated)) return false;
  return usage.roomMessages + count <= policy.roomMessages && usage.roomChars + chars <= policy.roomChars
    && usage.userMessages + count <= policy.userMessages && usage.userChars + chars <= policy.userChars;
}

function deliveryBegin(context) {
  if (!deliveryRoomCurrent(context) || !deliveryLoad()) return "blocked";
  deliveryLock.lock();
  try {
    if (deliveryBlocked || !deliveryRoomCurrent(context)) return "blocked";
    var now = new Date().getTime();
    deliveryPrune(now);
    var usage = deliveryUsage(context, now);
    if (usage.duplicate || deliveryPending[context.id]) return "duplicate";
    if (deliveryState.events.length >= DELIVERY_POLICY.attemptLimit) return "blocked";
    for (var key in deliveryPending) {
      var pending = deliveryPending[key];
      if (pending.room === context.room && pending.user === context.user && pending.command === context.command) return "duplicate";
    }
    if (!deliveryFits(usage, now, 1, 0, false)) return "limited";
    deliveryPending[context.id] = context;
    return "ready";
  } finally { deliveryLock.unlock(); }
}

function deliveryEnd(context) {
  if (!context || !deliveryLock) return;
  deliveryLock.lock();
  try { delete deliveryPending[context.id]; } finally { deliveryLock.unlock(); }
}

function deliveryApplyPolicy(policy) {
  if (!deliveryPolicyValid(policy) || !deliveryLoad()) return false;
  deliveryLock.lock();
  try { DELIVERY_POLICY = JSON.parse(JSON.stringify(policy)); return true; } finally { deliveryLock.unlock(); }
}

function deliverySend(context, texts, replier, notice, beforeAttempt) {
  if (!deliveryRoomCurrent(context) || !deliveryLoad() || !Array.isArray(texts) || !texts.length) return "blocked";
  var chars = 0;
  for (var i = 0; i < texts.length; i++) {
    if (typeof texts[i] !== "string" || !texts[i].trim()) return "blocked";
    chars += texts[i].replace(/\u200b/g, "").length;
  }
  deliveryLock.lock();
  try {
    if (deliveryBlocked || !deliveryRoomCurrent(context) || !deliveryPolicyValid(DELIVERY_POLICY)) return "blocked";
    if (texts.length > DELIVERY_POLICY.requestMessages || chars > DELIVERY_POLICY.requestChars) return "blocked";
    var now = new Date().getTime();
    deliveryPrune(now);
    var usage = deliveryUsage(context, now);
    if (usage.duplicate) return "duplicate";
    if (deliveryState.events.length >= DELIVERY_POLICY.attemptLimit) return "blocked";
    if ((notice && usage.notice) || !deliveryFits(usage, now, texts.length, chars, notice)) return "limited";
    var event = { id: context.id, room: context.room, user: context.user, command: context.command,
      at: now, expires: now + DELIVERY_POLICY.attemptTtlMs, messages: 0, chars: 0, notice: !!notice };
    for (var j = 0; j < texts.length; j++) {
      if (!deliveryRoomCurrent(context)) return "failed";
      if (j === 0) deliveryState.events.push(event);
      // Reserve each actual call before issuing it. A crash here can omit an answer; it cannot trigger a retry.
      event.messages++; event.chars += texts[j].replace(/\u200b/g, "").length;
      if (!deliverySave()) return "failed";
      if (j === 0 && beforeAttempt && !beforeAttempt()) return "failed";
      if (!deliveryRoomCurrent(context)) return "failed";
      try { if (replier.reply(texts[j]) === false) return "failed"; }
      catch (ignored) { return "failed"; }
    }
    return "sent";
  } finally { deliveryLock.unlock(); }
}

function deliveryNotice(context, replier) {
  if (context && context.kind !== "update") deliverySend(context, [DELIVERY_LIMIT_NOTICE], replier, true);
}

// 이 함수와 저장·발송은 updateLock을 잡은 상태에서만 실행한다.
function loadUpdateState() {
  if (updateBlocked) return false;
  if (updateState !== null) return true;
  try {
    updatePrefs = Api.getContext().getSharedPreferences("pogeun-update-notify", 0);
    var raw = updatePrefs.getString("state", null);
    if (raw === null) {
      updateState = { version: 1, rooms: [] };
      return true;
    }
    raw = String(raw);
    if (raw.length > UPDATE_MAX_BODY) throw new Error("state-size");
    var state = JSON.parse(raw);
    if (!state || state.version !== 1 || !Array.isArray(state.rooms)) throw new Error("state-format");
    for (var i = 0; i < state.rooms.length; i++) {
      var item = state.rooms[i];
      if (!item || typeof item.name !== "string" || !item.name.length || !updateInteger(item.cursor)
        || (item.roomId !== undefined && (typeof item.roomId !== "string" || !item.roomId.trim()
          || item.roomId.length > 512 || /[\x00-\x1f\x7f-\x9f]/.test(item.roomId)))
        || (item.blocked !== undefined && typeof item.blocked !== "boolean")) throw new Error("state-room");
      for (var j = 0; j < i; j++) if (item.roomId ? state.rooms[j].roomId === item.roomId : !state.rooms[j].roomId && state.rooms[j].name === item.name) throw new Error("state-duplicate");
    }
    updateState = state;
    return true;
  } catch (ignored) {
    updateBlocked = true;
    updateLog("저장 기록을 읽을 수 없어 자동 발송을 중단했습니다.");
    return false;
  }
}

function saveUpdateState() {
  try {
    var rooms = [];
    for (var i = 0; i < updateState.rooms.length; i++) {
      if (updateState.rooms[i].cursor !== null) rooms.push(updateState.rooms[i]);
    }
    var raw = JSON.stringify({ version: 1, rooms: rooms });
    if (raw.length > UPDATE_MAX_BODY || !updatePrefs.edit().putString("state", raw).commit()) throw new Error("state-write");
    return true;
  } catch (ignored) {
    // 전송 뒤 저장 실패여도 메모리의 진행점은 되돌리지 않는다. 다시 보내지 않고 중단한다.
    updateBlocked = true;
    updateLog("진행 기록을 저장하지 못해 자동 발송을 중단했습니다.");
    return false;
  }
}

function observeUpdateRoom(room, isGroupChat, packageName, roomIdentity) {
  if (!updateLock || updateStopped.get() || !updateRoomAllowed(room)) return;
  updateLock.lock();
  try {
    if (updateStopped.get() || !loadUpdateState()) return;
    var isTarget = packageName === "com.kakao.talk" && bridgeRoomAllowed(room, isGroupChat, roomIdentity);
    for (var i = 0; i < updateState.rooms.length; i++) {
      var item = updateState.rooms[i];
      if (isTarget ? item.roomId !== roomIdentity.roomId : item.name !== room) continue;
      // 이름이 같은 개인방·다른 앱의 세션이 관측되면 단체방 알림을 다시 받을 때까지 보류한다.
      var shouldBlock = !isTarget;
      if (!!item.blocked !== shouldBlock || item.name !== room) {
        item.blocked = shouldBlock;
        item.name = room;
        if (item.cursor !== null) saveUpdateState();
      }
      return;
    }
    if (!isTarget) return;
    // 서버가 준비된 첫 조회에서 그 수요일 당일 공지부터 시작한다. 준비 전에는 진행점을 추측하지 않는다.
    updateState.rooms.push({ name: room, roomId: roomIdentity.roomId, cursor: null });
  } finally { updateLock.unlock(); }
}

function readUpdateFeed() {
  var url = SERVER.replace(/\/bridge\/message\//, "/bridge/updates/");
  if (url === SERVER) throw new Error("endpoint");
  var res = org.jsoup.Jsoup.connect(url)
    .ignoreContentType(true)
    .ignoreHttpErrors(true)
    .followRedirects(false)
    .timeout(UPDATE_TIMEOUT_MS)
    .maxBodySize(UPDATE_MAX_BODY)
    .method(org.jsoup.Connection.Method.GET)
    .execute();
  if (res.statusCode() !== 200) throw new Error("feed-http");
  var raw = String(res.body());
  if (raw.length > UPDATE_MAX_BODY) throw new Error("feed-size");
  var feed = JSON.parse(raw);
  if (!feed || feed.version !== 1 || typeof feed.ready !== "boolean" || !updateInteger(feed.cursor) || !Array.isArray(feed.events) || feed.events.length > 100 || (!feed.ready && feed.events.length)) throw new Error("feed-format");
  var previous = 0;
  for (var i = 0; i < feed.events.length; i++) {
    var item = feed.events[i];
    if (!item || !updateInteger(item.id) || item.id <= previous || item.id > feed.cursor || typeof item.text !== "string" || !item.text.length || item.text.length > 700 || !updateInteger(item.expiresAt) || !item.expiresAt) throw new Error("feed-event");
    previous = item.id;
  }
  return feed;
}

function canSendUpdate(event) {
  var now = new Date().getTime();
  return !updateStopped.get() && now < event.expiresAt && new Date(now + 9 * 60 * 60 * 1000).getUTCDay() === 3;
}

// 1: 발신 요청 성공, 2: 발신 없이 소비, 0: 예산·세션을 다음 주기에 확인, -1: 중지 또는 저장 실패.
function sendUpdateBatch(room, batch) {
  if (updateStopped.get() || updateBlocked) return -1;
  var texts = [];
  var sent = false;
  for (var i = batch.length - 1; i >= 0; i--) if (canSendUpdate(batch[i])) texts.push(batch[i].text);
  if (texts.length) {
    try {
      if (!bridgeCanReply(room.name, room.roomId)) return 0;
      if (updateStopped.get()) return -1;
      // 세션 확인 중 자정이 되거나 공지가 만료될 수 있어 보내기 직전에 다시 고른다.
      texts = [];
      for (var j = batch.length - 1; j >= 0; j--) if (canSendUpdate(batch[j])) texts.push(batch[j].text);
      if (texts.length) {
        var ids = [];
        for (var k = 0; k < batch.length; k++) ids.push(batch[k].id);
        var context = deliveryContext(room.name, true,
          { source: "android-conversation-shortcut-v1", roomId: room.roomId }, null,
          "update " + ids.join(","), JSON.stringify(["automatic-update", room.roomId, ids]), "update");
        var result = deliverySend(context, [UPDATE_HEADER + texts.join("\n\n")],
          { reply: function (value) { return bridgeReplyRoom(room.name, value, room.roomId); } }, false,
          function () { room.cursor = batch[batch.length - 1].id; return saveUpdateState(); });
        if (result === "limited") return 0;
        if (result === "blocked" || deliveryBlocked || updateBlocked) return -1;
        sent = result === "sent";
        // A tried batch is consumed, including an uncertain failure. Its cursor was saved before the call.
      }
    } catch (ignored) { return 0; }
  }
  // 답장 성공은 전송 요청 성공이다. 카톡의 실제 도착 여부까지 알려 주지는 않는다.
  room.cursor = batch[batch.length - 1].id;
  return saveUpdateState() ? (sent ? 1 : 2) : -1;
}

function pollUpdates() {
  if (!updateLock || updateStopped.get() || !updateBusy.compareAndSet(false, true)) return;
  // 로그는 실제로 공지를 보냈거나 조회에 실패한 주기에만 남긴다. 60초마다 남기면 앱 로그가 하루 1,400줄 넘게 늘어난다.
  var startedAt = updateClock();
  var outcome = null;
  var sentBatches = 0;
  lastUpdatePollAt = new Date().getTime();
  try {
    updateLock.lock();
    try { if (!loadUpdateState() || updateStopped.get()) return; }
    finally { updateLock.unlock(); }
    var feed = readUpdateFeed();
    if (!feed.ready || updateStopped.get()) return;
    updateLock.lock();
    try {
      if (updateStopped.get() || updateBlocked) return;
      var rooms = updateState.rooms;
      var changed = false;
      for (var i = 0; i < rooms.length; i++) {
        if (rooms[i].cursor !== null && rooms[i].cursor > feed.cursor) return; // 서버 진행점이 되돌아가면 기록을 초기화하지 않는다.
      }
      for (var n = 0; n < rooms.length; n++) {
        if (rooms[n].cursor === null) {
          rooms[n].cursor = feed.events.length ? feed.events[0].id - 1 : feed.cursor;
          changed = true;
        }
      }
      if (changed && !saveUpdateState()) return;
      for (var r = 0; r < rooms.length; r++) {
        var room = rooms[r];
        if (room.blocked || !bridgeRoomAllowed(room.name, true, { source: "android-conversation-shortcut-v1", roomId: room.roomId })) continue;
        var failed = false;
        var batch = [];
        var batchLength = UPDATE_HEADER.length;
        for (var e = 0; e < feed.events.length; e++) {
          var item = feed.events[e];
          if (item.id <= room.cursor) continue;
          if (updateStopped.get()) return;
          if (!canSendUpdate(item)) {
            if (!batch.length) {
              room.cursor = item.id;
              if (!saveUpdateState()) return;
            }
            continue;
          }
          if (batch.length && batchLength + 2 + item.text.length > UPDATE_MAX_MESSAGE) {
            var result = sendUpdateBatch(room, batch);
            if (result < 0) return;
            if (result === 0) { failed = true; break; }
            if (result === 1) sentBatches++;
            batch = [];
            batchLength = UPDATE_HEADER.length;
          }
          batchLength += (batch.length ? 2 : 0) + item.text.length;
          batch.push(item);
        }
        if (!failed && batch.length) {
          var finalResult = sendUpdateBatch(room, batch);
          if (finalResult < 0) return;
          failed = finalResult === 0;
          if (finalResult === 1) sentBatches++;
        }
        // 보관 기한이 지나 피드에서 빠진 공지도 이후 다시 보내지 않는다.
        if (!failed && room.cursor < feed.cursor) {
          room.cursor = feed.cursor;
          if (!saveUpdateState()) return;
        }
      }
    } finally { updateLock.unlock(); }
  } catch (ignored) {
    outcome = "조회하지 못했습니다. 다음 주기에 다시 확인합니다.";
  } finally {
    if (sentBatches > 0) updateLog(startedAt + " 공지 발송 " + sentBatches + "건");
    if (outcome !== null && !updateStopped.get()) updateLog(startedAt + " " + outcome);
    updateBusy.set(false);
  }
}

// 절전 상태에서 Timer 주기가 멈추면 메시지 수신으로 앱이 깨어난 순간에 별도 스레드로 한 번 더 조회한다.
// 잡담 메시지에도 적용하며, 마지막 조회로부터 60초가 지났을 때만 돈다(updateBusy로 중복 실행 방지).
function wakeUpdatePolling() {
  try {
    if (!updateLock || !updateStopped || updateStopped.get() || updateBusy.get()) return;
    if (new Date().getTime() - lastUpdatePollAt < UPDATE_WAKE_MIN_MS) return;
    var task = new JavaAdapter(java.lang.Runnable, { run: pollUpdates });
    try {
      if (!bridgeExecutor || (bridgeStopped && bridgeStopped.get())) throw new Error("no-executor");
      bridgeExecutor.execute(task);
    } catch (ignoredExecutor) {
      new java.lang.Thread(task).start();
    }
  } catch (ignored) {
    updateLog(updateClock() + " 메시지 수신 후 추가 조회를 시작하지 못했습니다.");
  }
}

function onStartCompile() {
  if (welcomeTimer) { welcomeTimer.cancel(); welcomeTimer = null; }
  if (bridgeStopped) bridgeStopped.set(true);
  try { if (bridgeExecutor) bridgeExecutor.shutdownNow(); } catch (ignoredBridgeStop) {}
  if (updateStopped) updateStopped.set(true); // 진행 중인 HTTP 응답이 돌아와도 발송하지 않는다.
  if (updateTimer) { updateTimer.cancel(); updateTimer = null; }
  if (updateLock) { updateLock.lock(); updateLock.unlock(); }
}

function startUpdatePolling() {
  if (SERVER_NOT_SET || !AUTO_UPDATES) return;
  try {
    updateLock = new java.util.concurrent.locks.ReentrantLock();
    updateBusy = new java.util.concurrent.atomic.AtomicBoolean(false);
    updateStopped = new java.util.concurrent.atomic.AtomicBoolean(false);
    updateTimer = new java.util.Timer(true);
    updateTimer.schedule(new JavaAdapter(java.util.TimerTask, { run: pollUpdates }), UPDATE_INTERVAL_MS, UPDATE_INTERVAL_MS);
    updateLog(updateClock() + " 자동 조회 시작(60초 주기)");
  } catch (ignored) {
    if (updateTimer) updateTimer.cancel();
    updateTimer = null;
    updateLock = null;
    updateLog("자동 조회를 시작하지 못했습니다.");
  }
}

startUpdatePolling();

function askServer(room, sender, msg, attendanceIdentity, roomIdentity, isGroupChat) {
  var request = { room: room, sender: sender, text: msg, attendanceIdentity: attendanceIdentity || null, isGroupChat: isGroupChat === true };
  if (roomIdentity) request.roomIdentity = roomIdentity;
  var body = JSON.stringify(request);
  var res = org.jsoup.Jsoup.connect(SERVER)
    .ignoreContentType(true)
    .ignoreHttpErrors(true)
    .header("Content-Type", "application/json; charset=utf-8")
    .requestBody(body)
    // Android의 Jsoup은 지정값의 절반을 읽기 제한으로 쓴다. 서버의 25초 응답 예산보다 길게 둔다.
    .timeout(TIMEOUT_MS * 2)
    .method(org.jsoup.Connection.Method.POST)
    .execute();
  var status = res.statusCode();
  // 404면 주소는 닿았지만 비밀 경로가 틀린 것 — 서버가 평문 "not found"를 주므로 JSON으로 읽기 전에 가른다
  if (status !== 200) throw new Error("HTTP " + status + (status === 404 ? " (비밀 경로가 틀림)" : ""));
  return JSON.parse(res.body()); // { text, messages, link } — .post().text()는 줄바꿈을 지워 버리므로 응답 원문을 그대로 받는다
}

var bridgeStopped = null;
var bridgeExecutor = null;
var bridgeLock = null;
var bridgeSessions = [];
var bridgeSeen = [];
var bridgeRawEnabled = Number(android.os.Build.VERSION.SDK_INT) >= 31;

function bridgeLog() {
  try { Log.e("포근해용: 카카오톡 알림의 대화 정보를 처리하지 못했습니다."); } catch (ignored) {}
}

try {
  if (bridgeRawEnabled) {
    bridgeStopped = new java.util.concurrent.atomic.AtomicBoolean(false);
    bridgeLock = new java.util.concurrent.locks.ReentrantLock();
    deliveryLock = new java.util.concurrent.locks.ReentrantLock();
    bridgeExecutor = new java.util.concurrent.ThreadPoolExecutor(4, 4, 0,
      java.util.concurrent.TimeUnit.MILLISECONDS, new java.util.concurrent.ArrayBlockingQueue(64));
  }
} catch (ignoredBridgeStart) { bridgeLog(); }

function bridgeString(value) {
  return value === null || value === undefined ? "" : String(value);
}

// 서비스 객체와 대화 정보는 메인 스레드에서 해당 알림 하나에 대해서만 읽는다.
function bridgeConversation(sbn) {
  var notification = sbn.getNotification();
  var shortcutId = bridgeString(notification.getShortcutId());
  if (!shortcutId || Number(android.os.Build.VERSION.SDK_INT) < 31) return null;
  var thread = android.app.ActivityThread.currentActivityThread();
  var field = thread.getClass().getDeclaredField("mServices");
  field.setAccessible(true);
  var services = field.get(thread);
  var type = java.lang.Class.forName("android.service.notification.NotificationListenerService");
  var ownPackage = String(Api.getContext().getPackageName());
  var room = null;
  for (var i = 0; i < services.size() && i < 20; i++) {
    var service = services.valueAt(i);
    if (!type.isInstance(service) || String(service.getPackageName()) !== ownPackage) continue;
    var ranking = new android.service.notification.NotificationListenerService.Ranking();
    var map = service.getCurrentRanking();
    if (!map || !map.getRanking(sbn.getKey(), ranking)) continue;
    var shortcut = ranking.getConversationShortcutInfo();
    if (!shortcut || String(shortcut.getId()) !== shortcutId || String(shortcut.getPackage()) !== "com.kakao.talk") continue;
    var label = bridgeString(shortcut.getLongLabel()) || bridgeString(shortcut.getShortLabel());
    if (!label.trim()) continue;
    if (room !== null && room !== label) return null;
    room = label;
  }
  return room === null ? null : { id: shortcutId, name: room };
}

// 최신 메시지와 알림의 발신자·본문이 일치할 때만 그 메시지의 Person 키를 사용한다.
// 같은 시각의 후보가 여러 개이거나 Person 키가 없으면 이름으로 대체하지 않는다.
function bridgeAttendanceIdentity(extras, roomId, sender, text) {
  try {
    var messages = extras.getParcelableArray("android.messages");
    if (!messages || !messages.length) return null;
    var latest = null;
    var latestTime = -1;
    var ambiguous = false;
    for (var i = 0; i < messages.length; i++) {
      var message = messages[i];
      var at = Number(message.getLong("time"));
      if (!isFinite(at) || at <= 0) return null;
      if (at > latestTime) { latest = message; latestTime = at; ambiguous = false; }
      else if (at === latestTime) ambiguous = true;
    }
    if (!latest || ambiguous || bridgeString(latest.getCharSequence("text")) !== text) return null;
    var person = latest.getParcelable("sender_person");
    if (!person || bridgeString(person.getName()) !== sender) return null;
    var userId = bridgeString(person.getKey());
    if (!userId.trim() || userId.length > 512 || /[\x00-\x1f\x7f-\x9f]/.test(userId)
      || !roomId || roomId.length > 512 || /[\x00-\x1f\x7f-\x9f]/.test(roomId)) return null;
    return { source: "android-person-key-v1", roomId: roomId, userId: userId };
  } catch (ignored) { return null; }
}

function bridgeReplyAction(notification) {
  var actions = notification.actions;
  var selected = null;
  if (!actions) return null;
  for (var i = 0; i < actions.length; i++) {
    var action = actions[i];
    var inputs = action.getRemoteInputs();
    if (!inputs || !action.actionIntent || String(action.actionIntent.getCreatorPackage()) !== "com.kakao.talk") continue;
    var writable = false;
    for (var j = 0; j < inputs.length; j++) if (inputs[j].getAllowFreeFormInput()) writable = true;
    if (!writable) continue;
    if (selected !== null) return null;
    selected = action;
  }
  return selected;
}

function bridgeSend(action, text) {
  if (!action || !bridgeStopped || bridgeStopped.get()) return false;
  var inputs = action.getRemoteInputs();
  var results = new android.os.Bundle();
  for (var i = 0; i < inputs.length; i++) {
    if (inputs[i].getAllowFreeFormInput()) results.putCharSequence(inputs[i].getResultKey(), String(text));
  }
  var intent = new android.content.Intent();
  android.app.RemoteInput.addResultsToIntent(inputs, intent, results);
  if (bridgeStopped.get()) return false;
  action.actionIntent.send(Api.getContext(), 0, intent);
  return true;
}

function bridgeRemember(event) {
  bridgeLock.lock();
  try {
    if (bridgeStopped.get()) return false;
    var existing = null;
    var renamed = false;
    for (var i = 0; i < bridgeSessions.length; i++) {
      var item = bridgeSessions[i];
      if (item.id === event.id && item.name !== event.room) { item.blocked = true; renamed = true; }
      if (item.name === event.room) existing = item;
    }
    if (existing && existing.id !== event.id) existing.blocked = true;
    else if (!existing || event.at >= existing.at) {
      var value = { id: event.id, name: event.room, action: event.action, group: event.group,
        at: event.at, blocked: renamed || (existing ? existing.blocked : false) };
      if (existing) bridgeSessions[bridgeSessions.indexOf(existing)] = value;
      else { bridgeSessions.push(value); if (bridgeSessions.length > 128) bridgeSessions.shift(); }
    }
    if (bridgeSeen.indexOf(event.key) !== -1) return false;
    bridgeSeen.push(event.key);
    if (bridgeSeen.length > 256) bridgeSeen.shift();
    return true;
  } finally { bridgeLock.unlock(); }
}

function bridgeCanReply(room, roomId) {
  if (!bridgeRawEnabled) return false;
  if (!bridgeLock || !bridgeStopped || bridgeStopped.get()) return false;
  bridgeLock.lock();
  try {
    for (var i = 0; i < bridgeSessions.length; i++) {
      var item = bridgeSessions[i];
      if (item.name === room && item.id === roomId) return item.group && !item.blocked;
    }
    return false;
  } finally { bridgeLock.unlock(); }
}

function bridgeReplyRoom(room, text, roomId) {
  if (!bridgeRawEnabled) return false;
  if (!bridgeLock || !bridgeStopped || bridgeStopped.get()) return false;
  bridgeLock.lock();
  try {
    for (var i = 0; i < bridgeSessions.length; i++) {
      var item = bridgeSessions[i];
      if (item.name === room && item.id === roomId && item.group && !item.blocked) return bridgeSend(item.action, text);
    }
    return false;
  } finally { bridgeLock.unlock(); }
}

function onNotificationPosted(sbn) {
  if (!bridgeRawEnabled || !bridgeExecutor || bridgeStopped.get() || String(sbn.getPackageName()) !== "com.kakao.talk") return;
  var read = function () {
    if (bridgeStopped.get()) return;
    try {
      var notification = sbn.getNotification();
      if ((notification.flags & 512) !== 0) return;
      var action = bridgeReplyAction(notification);
      if (!action) return;
      var conversation = bridgeConversation(sbn);
      if (!conversation) { bridgeLog(); return; }
      var extras = notification.extras;
      var sender = bridgeString(extras.getCharSequence("android.title"));
      var text = bridgeString(extras.getCharSequence("android.text"));
      if (!sender || !text || !updateRoomAllowed(conversation.name)) return;
      var logId = extras.containsKey("chatLogId") ? bridgeString(extras.get("chatLogId")) : "";
      var identity = bridgeAttendanceIdentity(extras, conversation.id, sender, text);
      var roomIdentity = { source: "android-conversation-shortcut-v1", roomId: conversation.id };
      var event = { room: conversation.name, id: conversation.id, sender: sender, text: text,
        identity: identity, roomIdentity: roomIdentity,
        deliveryKey: JSON.stringify(["conversation-event", conversation.id, logId || [String(sbn.getKey()), String(sbn.getPostTime()), text]]),
        action: action, group: extras.containsKey("android.isGroupConversation") && extras.getBoolean("android.isGroupConversation"),
        at: Number(sbn.getPostTime()), key: JSON.stringify([String(sbn.getKey()), logId || String(sbn.getPostTime()), sender, text, identity, roomIdentity]) };
      bridgeExecutor.execute(new JavaAdapter(java.lang.Runnable, { run: function () {
        if (bridgeStopped.get() || !bridgeRemember(event)) return;
        if (bridgeStopped.get()) return;
        handleBridgeMessage(event.room, event.text, event.sender, event.group,
          { reply: function (value) { return bridgeSend(event.action, value); } }, "com.kakao.talk", event.identity, event.roomIdentity, event.deliveryKey);
      } }));
    } catch (ignored) { bridgeLog(); }
  };
  try {
    var main = android.os.Looper.getMainLooper();
    if (main.equals(android.os.Looper.myLooper())) read();
    else if (!new android.os.Handler(main).post(new JavaAdapter(java.lang.Runnable, { run: read }))) bridgeLog();
  } catch (ignored) { bridgeLog(); }
}

// 카카오톡은 알림의 고유 대화 정보로 처리하므로 레거시 콜백을 다시 실행하지 않는다.
function response(room, msg, sender, isGroupChat, replier, imageDB, packageName) {
  if (bridgeRawEnabled && String(packageName) === "com.kakao.talk") return;
  handleBridgeMessage(room, msg, sender, isGroupChat, replier, packageName);
}

function isBareVersusInput(msg) {
  if (typeof msg !== 'string' || /^[.!/\[]/.test(msg.trim()) || /(?:https?:\/\/|www\.)\S+/i.test(msg)) return false;
  return /(^|[^a-z/\\])vs\.?(?=$|[^a-z./\\])/i.test(msg);
}

function bridgeReplyAnswer(answer, replier, context) {
  if (!answer || typeof answer !== "object") return "blocked";
  if (answer.deliveryPolicy !== undefined && !deliveryApplyPolicy(answer.deliveryPolicy)) return "blocked";
  var messages = answer.messages;
  var validMessages = Array.isArray(messages) && messages.length > 0;
  if (validMessages) {
    for (var i = 0; i < messages.length; i++) {
      if (typeof messages[i] !== "string" || !messages[i].trim().length) {
        validMessages = false;
        break;
      }
    }
  }
  var texts = [];
  if (typeof answer.link === "string" && answer.link.trim()) texts.push(answer.link);
  if (validMessages) {
    for (var j = 0; j < messages.length; j++) texts.push(messages[j]);
  } else if (typeof answer.text === "string" && answer.text.trim()) texts.push(answer.text);
  if (!texts.length) return "silent";
  return deliverySend(context, texts, replier, false);
}

function handleBridgeMessage(room, msg, sender, isGroupChat, replier, packageName, attendanceIdentity, roomIdentity, eventKey) {
  if (packageName !== "com.kakao.talk" || !bridgeRoomAllowed(room, isGroupChat, roomIdentity)) return;
  observeUpdateRoom(room, isGroupChat, packageName, roomIdentity);
  wakeUpdatePolling(); // 커맨드가 아닌 잡담이어도 앱이 깨어난 김에 미발송 공지를 확인한다
  if (bridgeRawEnabled && bridgeStopped && bridgeStopped.get()) return;
  if (!msg) return;
  var first = msg.charAt(0);
  var isBareAlias = /^\s*(?:ㅂㅂㄱ|ㄱㅁㄱ|ㄱㅁㅈ|ㄱㅁ|ㅂㅆㅇㄱ|ㅊㅊㅎㅎ|ㅊㅊ|ㄱㄹㄷ|ㄱㅎ)(?:\s|$)/.test(msg) || /^\s*(?:한마디|ㅎㅁㄷ|ㅈㅁㅊ)\s*$/.test(msg); // 한마디와 메뉴 초성은 단독 입력만 허용
  var isVersus = isBareVersusInput(msg) || /^\s*[./]vs(?:\s|$)/i.test(msg);
  if (first !== "/" && first !== "." && first !== "[" && !isBareAlias && !isVersus) return; // "..." 같은 잡담은 서버가 커맨드가 아니면 침묵으로 처리한다
  var context = deliveryContext(room, isGroupChat, roomIdentity, attendanceIdentity, msg, eventKey, "reply");
  var begin = deliveryBegin(context);
  if (begin === "limited") { deliveryNotice(context, replier); return; }
  if (begin !== "ready") return;
  try {
    if (SERVER_NOT_SET) {
      deliverySend(context, ["스크립트의 SERVER 값을 아직 채우지 않았어요. http://서버주소/bridge/message/비밀경로 형식으로 넣고 다시 컴파일해 주세요."], replier, false);
      return;
    }
    if (bridgeRawEnabled && bridgeStopped && bridgeStopped.get()) return;
    var answer;
    try { answer = askServer(room, sender, msg, attendanceIdentity, roomIdentity, isGroupChat); }
    catch (e) {
      var why = String(e);
      var errorText;
      if (why.indexOf("HTTP 404") !== -1) errorText = "봇 서버에는 닿았지만 SERVER의 비밀 경로가 틀렸어요. 스크립트의 SERVER 값을 확인해 주세요.";
      else if (why.toLowerCase().indexOf("timed out") !== -1 || why.toLowerCase().indexOf("timeout") !== -1) {
        errorText = "봇 서버의 응답 시간이 초과됐어요. 잠시 후 다시 시도해 주세요.";
      } else errorText = "봇 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.";
      answer = { text: errorText, link: null };
      try { Log.e("포근해용 서버 연결 오류"); } catch (ignored) {}
    }
    if (!bridgeRoomAllowed(room, isGroupChat, roomIdentity)) return;
    if (bridgeReplyAnswer(answer, replier, context) === "limited") deliveryNotice(context, replier);
  } finally { deliveryEnd(context); }
}

// 실제 입장 피드만 읽는 별도 수신기. 관찰과 발신은 각각 승인 후 켠다.
var WELCOME_ENABLED = false;
var WELCOME_SEND = false;
var WELCOME_BOT_ID = "";
var WELCOME_SNAPSHOT = "/data/local/opentalk-welcome/events.json";
var welcomeTimer = null;
var welcomeLock = null;
var welcomePrefs = null;
var welcomeState = null;
var welcomeBlocked = false;
var welcomeGeneration = null;
var welcomeStartedAt = new Date().getTime();
var welcomeLastError = "";

function welcomeLog(code) {
  if (welcomeLastError === code) return;
  welcomeLastError = code;
  try { Log.e("포근해용 입장 환영: " + code); } catch (ignored) {}
}
function welcomeAssert(ok, code) { if (!ok) throw new Error(code); }
function welcomeIdValid(value) {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)
    && (value.length < 19 || value <= "9223372036854775807");
}
function welcomeCompare(a, b) { return a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length - b.length; }
function welcomeNameValid(value, limit) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit
    && !/[\x00-\x1f\x7f-\x9f\ufffd]/.test(value);
}
function welcomeRoomIds() {
  welcomeAssert(Array.isArray(ALLOWED_ROOM_IDS) && ALLOWED_ROOM_IDS.length > 0 && ALLOWED_ROOM_IDS.length <= 128, "ROOMS_REQUIRED");
  var rooms = ALLOWED_ROOM_IDS.slice().sort();
  for (var i = 0; i < rooms.length; i++) welcomeAssert(welcomeIdValid(rooms[i]) && (i === 0 || rooms[i] !== rooms[i-1]), "INVALID_ROOMS");
  return rooms;
}
function welcomeSave() {
  var raw = JSON.stringify(welcomeState);
  welcomeAssert(raw.length <= 4194304 && welcomePrefs.edit().putString("state", raw).commit(), "STATE_WRITE_FAILED");
}
function welcomeLoad() {
  var configuration = deliveryHash(JSON.stringify([WELCOME_BOT_ID, welcomeRoomIds()]));
  if (welcomeState !== null) { welcomeAssert(welcomeState.configuration === configuration, "CONFIGURATION_CHANGED"); return; }
  welcomePrefs = Api.getContext().getSharedPreferences("pogeun-welcome", 0);
  var raw = welcomePrefs.getString("state", null);
  if (raw === null) {
    welcomeState = { version: 1, configuration: configuration, entries: {}, events: {}, pending: null };
    welcomeSave(); return;
  }
  raw = String(raw); welcomeAssert(raw.length <= 4194304, "STATE_TOO_LARGE");
  var state = JSON.parse(raw);
  welcomeAssert(state && state.version === 1 && state.configuration === configuration && state.pending === null,
    "STATE_CHANGED_OR_UNCONFIRMED");
  for (var field in state) welcomeAssert(["version", "configuration", "entries", "events", "pending"].indexOf(field) !== -1, "INVALID_STATE_FIELD");
  var hash = /^[a-f0-9]{64}$/;
  welcomeAssert(state.entries && !Array.isArray(state.entries) && state.events && !Array.isArray(state.events), "INVALID_STATE");
  welcomeAssert(Object.keys(state.entries).length <= 10000 && Object.keys(state.events).length <= 2048, "STATE_LIMIT");
  for (var key in state.entries) {
    var entry = state.entries[key];
    welcomeAssert(hash.test(key) && entry && welcomeNameValid(entry.name, 100) && updateInteger(entry.at)
      && welcomeIdValid(entry.eventId), "INVALID_ENTRY");
    for (var entryField in entry) welcomeAssert(["name", "at", "eventId"].indexOf(entryField) !== -1, "INVALID_ENTRY_FIELD");
  }
  for (var eventKey in state.events) welcomeAssert(hash.test(eventKey) && updateInteger(state.events[eventKey]), "INVALID_EVENT_STATE");
  welcomeState = state;
}
function welcomeReadSnapshot() {
  var file = new java.io.File(WELCOME_SNAPSHOT);
  welcomeAssert(file.isFile() && file.length() <= 262144, "READER_UNAVAILABLE");
  var raw = FileStream.read(WELCOME_SNAPSHOT);
  welcomeAssert(raw !== null && String(raw).length <= 262144, "READER_UNAVAILABLE");
  return JSON.parse(String(raw));
}
function welcomeSnapshotValid(snapshot) {
  var now = new Date().getTime();
  return snapshot && snapshot.version === 1 && typeof snapshot.generation === "string" && snapshot.generation.length <= 100
    && snapshot.generation.length > 0 && updateInteger(snapshot.at) && snapshot.at <= now + 5000 && now - snapshot.at <= 10000
    && snapshot.botId === WELCOME_BOT_ID && JSON.stringify(snapshot.rooms) === JSON.stringify(welcomeRoomIds())
    && Array.isArray(snapshot.events) && snapshot.events.length <= 100 && Array.isArray(snapshot.outgoing) && snapshot.outgoing.length <= 128;
}
function welcomeRoomSession(roomId) {
  bridgeLock.lock();
  try {
    var found = null;
    for (var i = 0; i < bridgeSessions.length; i++) {
      var item = bridgeSessions[i];
      if (item.id !== roomId) continue;
      if (found || !item.group || item.blocked || !welcomeNameValid(item.name, 1000)) return null;
      found = { name: item.name, id: item.id };
    }
    return found;
  } finally { bridgeLock.unlock(); }
}
function welcomeDate(at) {
  var d = new Date(at + 9 * 3600000);
  var two = function (n) { return n < 10 ? "0" + n : String(n); };
  return d.getUTCFullYear() + "-" + two(d.getUTCMonth()+1) + "-" + two(d.getUTCDate()) + " "
    + two(d.getUTCHours()) + ":" + two(d.getUTCMinutes()) + ":" + two(d.getUTCSeconds());
}
function welcomeWatermark(snapshot, roomId) {
  var id = "0";
  for (var i = 0; i < snapshot.outgoing.length; i++) {
    var row = snapshot.outgoing[i];
    if (row.roomId === roomId && welcomeIdValid(row.logId) && welcomeCompare(row.logId, id) > 0) id = row.logId;
  }
  return id;
}
function welcomeConfirmed(snapshot, roomId, text, after, since) {
  if (!welcomeSnapshotValid(snapshot) || snapshot.generation !== welcomeGeneration) return false;
  var hash = deliveryHash(text);
  for (var i = 0; i < snapshot.outgoing.length; i++) {
    var row = snapshot.outgoing[i];
    if (row.roomId === roomId && welcomeIdValid(row.logId) && welcomeCompare(row.logId, after) > 0
      && updateInteger(row.at) && row.at >= since - 1000 && row.at <= snapshot.at + 5000 && row.hash === hash) return true;
  }
  return false;
}
function welcomeConfirm(roomId, text, after, since) {
  // Monotonic deadline: a backwards wall clock cannot keep the delivery lock indefinitely.
  var deadline = android.os.SystemClock.elapsedRealtime() + 10000;
  while (!bridgeStopped.get() && android.os.SystemClock.elapsedRealtime() < deadline) {
    if (welcomeConfirmed(welcomeReadSnapshot(), roomId, text, after, since)) return true;
    java.lang.Thread.sleep(250);
  }
  return false;
}
function welcomeEvent(event, snapshot) {
  var now = new Date().getTime();
  welcomeAssert(event && welcomeIdValid(event.roomId) && welcomeIdValid(event.eventId), "INVALID_JOIN_ID");
  if (ALLOWED_ROOM_IDS.indexOf(event.roomId) === -1) return;
  welcomeAssert(updateInteger(event.at) && event.at <= now + 5000, "INVALID_JOIN_TIME");
  if (event.at < welcomeStartedAt || now - event.at > 120000) return;
  welcomeAssert(Array.isArray(event.members) && event.members.length > 0 && event.members.length <= 100, "INVALID_JOIN_MEMBERS");
  var seen = {};
  for (var n = 0; n < event.members.length; n++) {
    var person = event.members[n];
    welcomeAssert(person && welcomeIdValid(person.id) && welcomeNameValid(person.name, 100) && !seen[person.id], "INVALID_JOIN_MEMBER");
    seen[person.id] = true;
  }
  var eventKey = deliveryHash(JSON.stringify([event.roomId, event.eventId]));
  if (welcomeState.events[eventKey] !== undefined) return;
  for (var old in welcomeState.events) if (welcomeState.events[old] < now - 30*86400000) delete welcomeState.events[old];
  welcomeAssert(Object.keys(welcomeState.events).length < 2048, "EVENT_LIMIT");
  var jobs = [];
  for (var m = 0; m < event.members.length; m++) {
    var member = event.members[m];
    if (member.id === WELCOME_BOT_ID) continue;
    var key = deliveryHash(JSON.stringify([event.roomId, member.id]));
    var previous = welcomeState.entries[key];
    if (previous && (previous.at > event.at || (previous.at === event.at && welcomeCompare(previous.eventId, event.eventId) >= 0))) continue;
    welcomeAssert(previous || Object.keys(welcomeState.entries).length < 10000, "ENTRY_LIMIT");
    welcomeState.entries[key] = { name: member.name, at: event.at, eventId: event.eventId };
    jobs.push({ member: member, previous: previous, key: key });
  }
  welcomeState.events[eventKey] = now;
  welcomeSave(); // Store every actual entry, even when observation-only or the send budget refuses it.
  if (!WELCOME_SEND) return;
  for (var j = 0; j < jobs.length && !bridgeStopped.get(); j++) {
    var job = jobs[j];
    var room = welcomeRoomSession(event.roomId);
    if (!room) continue;
    var identity = { source: "android-conversation-shortcut-v1", roomId: event.roomId };
    var context = deliveryContext(room.name, true, identity, null, "welcome:" + job.key,
      JSON.stringify(["welcome", event.roomId, event.eventId, job.member.id]), "welcome");
    if (!context || deliveryBegin(context) !== "ready") continue;
    try {
      var roomLabel = room.name;
      var texts = [job.member.name + '님 "' + roomLabel + '"에 어서오세요!\n즐거운 길드 생활 되세요!'];
      if (job.previous) texts.push("이전 이름: " + job.previous.name + "\n날짜: " + welcomeDate(job.previous.at));
      var result = deliverySend(context, texts, { reply: function (text) {
        var before = welcomeReadSnapshot();
        if (!WELCOME_SEND || !welcomeSnapshotValid(before) || before.generation !== welcomeGeneration) return false;
        var after = welcomeWatermark(before, event.roomId);
        var since = new Date().getTime();
        if (!bridgeReplyRoom(room.name, text, event.roomId)) return false;
        return welcomeConfirm(event.roomId, text, after, since);
      } }, false, function () {
        welcomeState.pending = { event: eventKey, member: job.key, at: now };
        welcomeSave(); return true;
      });
      if (result === "sent") { welcomeState.pending = null; welcomeSave(); }
      else if (welcomeState.pending !== null) throw new Error("UNCONFIRMED_SEND");
    } finally { deliveryEnd(context); }
  }
}
function pollWelcome() {
  if (!WELCOME_ENABLED || welcomeBlocked || !bridgeRawEnabled || !bridgeStopped || bridgeStopped.get()) return;
  if (!welcomeLock) welcomeLock = new java.util.concurrent.locks.ReentrantLock();
  welcomeLock.lock();
  try {
    if (!WELCOME_ENABLED || welcomeBlocked || bridgeStopped.get()) return;
    welcomeAssert(welcomeIdValid(WELCOME_BOT_ID), "BOT_ID_REQUIRED");
    var snapshot;
    try { snapshot = welcomeReadSnapshot(); }
    catch (unavailable) { welcomeLog("READER_UNAVAILABLE"); return; }
    if (!welcomeSnapshotValid(snapshot)) { welcomeLog("READER_NOT_READY"); return; }
    if (welcomeGeneration !== null && welcomeGeneration !== snapshot.generation) {
      welcomeGeneration = snapshot.generation; welcomeStartedAt = snapshot.at + 1; return;
    }
    welcomeGeneration = snapshot.generation;
    welcomeLoad();
    for (var i = 0; i < snapshot.events.length && !bridgeStopped.get(); i++) welcomeEvent(snapshot.events[i], snapshot);
    welcomeLastError = "";
  } catch (error) {
    // Never print the exception: DB/file errors can contain private paths or message data.
    welcomeBlocked = true; welcomeLog("CHECK_READER_AND_PRIVATE_STATE");
  } finally { welcomeLock.unlock(); }
}
function startWelcomePolling() {
  if (!WELCOME_ENABLED || welcomeTimer !== null) return;
  welcomeTimer = new java.util.Timer(true);
  welcomeTimer.schedule(new JavaAdapter(java.util.TimerTask, { run: pollWelcome }), 1000, 3000);
}
startWelcomePolling();
