import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const source = readFileSync(new URL('../../scripts/messengerbot-r.js', import.meta.url), 'utf8');
export const FIXTURE_ROOM_ID = '1234567890123456789';
export const fixtureRoomIdentity = (roomId = FIXTURE_ROOM_ID) => ({ source: 'android-conversation-shortcut-v1', roomId });
export const bridgeFixture = (body = {}) => ({
  room: '검증방', sender: '검증사용자', text: '.fixture', isGroupChat: true,
  roomIdentity: fixtureRoomIdentity(), ...body,
});

// All Android, HTTP and storage boundaries are local doubles; the complete phone script runs.
export function createPhone({ store = new Map(), allowedRoomIds = [FIXTURE_ROOM_ID],
  now = Date.parse('2026-09-23T03:00:00Z'), answer = { text: 'fixture answer', link: null },
  autoUpdates = false, policy = {} } = {}) {
  let clock = now;
  let current;
  let sequence = 0;
  let response = answer;
  let httpError = null;
  let replyError = null;
  let failCommit = false;
  let beforeReturn = null;
  let afterCommit = null;
  const requests = [];
  const attempts = [];
  const logs = [];
  const timers = [];
  const commits = [];
  let feed = { version: 1, ready: true, cursor: 0, events: [] };
  function AtomicBoolean(value) { this.value = value; }
  AtomicBoolean.prototype.get = function () { return this.value; };
  AtomicBoolean.prototype.set = function (value) { this.value = value; };
  AtomicBoolean.prototype.compareAndSet = function (expected, value) {
    if (this.value !== expected) return false;
    this.value = value; return true;
  };
  function Lock() { this.lock = () => {}; this.unlock = () => {}; }
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const contextObject = {
    getPackageName: () => 'test.messengerbot',
    getSharedPreferences: (name) => ({
      getString: (key, fallback) => store.get(`${name}/${key}`) ?? fallback,
      edit: () => ({ putString(key, value) { return { commit() {
        commits.push({ name, key, value: String(value) });
        if (failCommit) return false;
        store.set(`${name}/${key}`, String(value));
        if (afterCommit) afterCommit(name, key, String(value));
        return true;
      } }; } }),
    }),
  };
  const service = { getPackageName: contextObject.getPackageName,
    getCurrentRanking: () => ({ getRanking(key, ranking) {
      ranking.shortcut = {
        getId: () => current.rankingId ?? current.roomId,
        getPackage: () => current.rankingPackage ?? 'com.kakao.talk',
        getLongLabel: () => current.room, getShortLabel: () => current.room,
      }; return true;
    } }),
  };
  const field = { setAccessible() {}, get: () => ({ size: () => 1, valueAt: () => service }) };
  const main = { equals: () => true };
  const context = vm.createContext({
    Date: Clock,
    android: {
      os: { Build: { VERSION: { SDK_INT: 31 } }, Looper: { getMainLooper: () => main, myLooper: () => main },
        Bundle: function () { this.values = {}; this.putCharSequence = (key, value) => { this.values[key] = value; }; } },
      app: { ActivityThread: { currentActivityThread: () => ({ getClass: () => ({ getDeclaredField: () => field }) }) },
        RemoteInput: { addResultsToIntent(inputs, intent, results) { intent.text = Object.values(results.values)[0]; } } },
      content: { Intent: function () {} },
      service: { notification: { NotificationListenerService: { Ranking: function () {
        this.getConversationShortcutInfo = () => this.shortcut;
      } } } },
    },
    java: {
      lang: { Class: { forName: () => ({ isInstance: () => true }) }, Runnable: function () {},
        String: function (value) { this.getBytes = () => Buffer.from(String(value), 'utf8'); },
        Thread: function (task) { this.start = () => task.run(); } },
      security: { MessageDigest: { getInstance: () => ({ digest: bytes => [...createHash('sha256').update(bytes).digest()] }) } },
      util: { Timer: function () { this.schedule = (task) => timers.push(task); this.cancel = () => {}; }, TimerTask: function () {},
        concurrent: { atomic: { AtomicBoolean }, locks: { ReentrantLock: Lock }, TimeUnit: { MILLISECONDS: 1 },
          ArrayBlockingQueue: function () {}, ThreadPoolExecutor: function () { this.execute = task => task.run(); this.shutdownNow = () => {}; } } },
    },
    JavaAdapter: function (type, implementation) { return implementation; },
    Api: { getContext: () => contextObject },
    org: { jsoup: { Connection: { Method: { GET: 'GET', POST: 'POST' } }, Jsoup: { connect(url) {
      let method;
      let body;
      return {
        ignoreContentType() { return this; }, ignoreHttpErrors() { return this; }, followRedirects() { return this; },
        maxBodySize() { return this; }, header() { return this; }, timeout() { return this; },
        method(value) { method = value; return this; }, requestBody(value) { body = JSON.parse(value); return this; },
        execute() {
          requests.push({ url: String(url), method, body });
          if (httpError) throw httpError;
          if (beforeReturn) beforeReturn();
          const payload = method === 'GET' ? feed : (typeof response === 'function' ? response(body) : response);
          return { statusCode: () => 200, body: () => JSON.stringify(payload) };
        },
      };
    } } } },
    Log: { e: message => logs.push(String(message)) },
  });
  vm.runInContext(source, context, { filename: 'messengerbot-r.js' });
  context.SERVER = 'https://example.invalid/bridge/message/fixture';
  context.SERVER_NOT_SET = false;
  context.ALLOWED_ROOM_IDS = allowedRoomIds;
  if (autoUpdates !== null) context.AUTO_UPDATES = autoUpdates;
  context.DELIVERY_POLICY = { ...(context.DELIVERY_POLICY ?? {}), ...policy };
  if (context.AUTO_UPDATES) context.startUpdatePolling();
  function notify(options = {}) {
    current = { room: '검증방', roomId: FIXTURE_ROOM_ID, sender: '검증사용자', text: '.fixture', group: true,
      personKey: 'fixture-person', at: clock, eventId: String(++sequence), ...options };
    const event = { ...current };
    const values = { 'android.title': event.sender, 'android.text': event.text,
      'android.isGroupConversation': event.group, chatLogId: event.eventId };
    if (event.missingGroup) delete values['android.isGroupConversation'];
    const extras = {
      getCharSequence: key => values[key], containsKey: key => key in values,
      get: key => values[key], getBoolean: key => values[key],
      getParcelableArray: () => event.personKey == null ? null : [{
        getLong: () => event.at, getCharSequence: () => event.text,
        getParcelable: () => ({ getName: () => event.sender, getKey: () => event.personKey }),
      }],
    };
    const action = { actionIntent: { getCreatorPackage: () => 'com.kakao.talk', send(ctx, code, intent) {
      attempts.push({ text: String(intent.text), roomId: event.roomId, at: clock });
      if (replyError && replyError(attempts.length)) throw new Error('Injected reply failure');
    } }, getRemoteInputs: () => [{ getAllowFreeFormInput: () => true, getResultKey: () => 'reply' }] };
    const notification = { flags: 0, extras, actions: [action], getShortcutId: () => event.roomId };
    context.onNotificationPosted({ getNotification: () => notification, getPackageName: () => 'com.kakao.talk',
      getKey: () => `notification-${event.roomId}`, getPostTime: () => event.at });
  }
  return { context, store, requests, attempts, logs, commits, timers, notify,
    advance: ms => { clock += ms; }, time: () => clock,
    setAnswer: value => { response = value; }, setHttpError: value => { httpError = value; },
    setReplyError: value => { replyError = value; }, setStoreFailure: value => { failCommit = value; },
    setBeforeReturn: value => { beforeReturn = value; }, setFeed: value => { feed = value; },
    setAfterCommit: value => { afterCommit = value; },
  };
}
