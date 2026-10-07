import nk from 'node-kakao';
import { randomBytes } from 'node:crypto';
import { createWelcomePlatform } from '../../src/kakao/welcome-platform.js';
import { createWelcomeSupervisor } from '../../src/kakao/welcome-supervisor.js';
import { createServer as createNetServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';

import { createWelcomeLogin } from '../../src/kakao/welcome-login.js';
import { createWelcomeAuthWeb, createWelcomePasscodeApi } from '../../src/kakao/welcome-auth-web.js';
import { createWelcomeSetup } from '../../src/kakao/welcome-setup.js';
import { createWelcomeLoco } from '../../src/kakao/welcome-loco.js';
import { createWelcomeHandler, requireWelcome, welcomeId, WelcomeError } from '../../src/kakao/welcome.js';
import { WelcomeStore } from '../../src/kakao/welcome-store.js';

const flags = process.argv.slice(2);
const shutdown = new AbortController();
requireWelcome(flags.every(flag => ['--send', '--resume', '--check'].includes(flag)), 'UNKNOWN_FLAG');
process.umask(0o077);
const { pathFor, save, protect, credentialFile, protection } = createWelcomePlatform();
if (flags.includes('--check')) {
  const value = 'local credential protection self-check';
  requireWelcome(await protect(await protect(value), true) === value, 'CREDENTIAL_PROTECTION_FAILED');
  console.log(JSON.stringify({ runtime: 'ready', credentialProtection: protection, accountRequests: 0 }));
  process.exit(0);
}
// One receiver owns this local port before it reads or changes account state.
const instance = createNetServer(socket => socket.destroy());
await new Promise((resolve, reject) => {
  instance.once('error', () => reject(new WelcomeError('RECEIVER_ALREADY_RUNNING_OR_PORT_IN_USE')));
  instance.listen(3106, '127.0.0.1', resolve);
});

const identityPath = pathFor('device.json');
let identity;
if (existsSync(identityPath)) identity = JSON.parse(readFileSync(identityPath, 'utf8'));
else {
  identity = { deviceUUID: randomBytes(64).toString('base64'), name: process.platform === 'linux' ? 'OpenTalk Welcome Server' : 'OpenTalk Welcome PC' };
  save('device.json', JSON.stringify(identity));
}
requireWelcome(typeof identity.deviceUUID === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(identity.deviceUUID), 'INVALID_DEVICE_ID');
// Auth is sent only to this host, without redirects. Passwords never enter process arguments or disk state.
const authWeb = createWelcomeAuthWeb({ signal: shutdown.signal });
const authDefaults = await nk.AuthApiClient.create(identity.name, identity.deviceUUID);
const passwordApi = new nk.AuthApiClient(authWeb, identity.name, identity.deviceUUID, authDefaults.config, authDefaults.xvcProvider);
const api = createWelcomePasscodeApi({ api: passwordApi, web: authWeb });
const sending = flags.includes('--send');
let client, receiver, store, connectedId, roomChoices = [], setup;
let listening = false, receivedJoins = 0, lastError, closing = false;
let lastEventAt;
let controlTask;
let resumable = existsSync(pathFor(credentialFile)) && existsSync(pathFor('receiver.json'));
const storedRecovery = existsSync(pathFor('recovery.json')) ? JSON.parse(readFileSync(pathFor('recovery.json'), 'utf8')) : {};
let recoveryBlocked = storedRecovery.blocked === true;
if (recoveryBlocked) lastError = errorCode(storedRecovery);
function setRecoveryBlocked(blocked, code) {
  recoveryBlocked = blocked;
  save('recovery.json', JSON.stringify({ blocked, ...(blocked ? { code } : {}), at: Date.now() }));
}
const transientErrors = new Set(['LOCO_CONNECT_FAILED', 'LOCO_LOGIN_TIMEOUT', 'LOCO_CONNECTION_ERROR',
  'LOCO_ROOM_UNAVAILABLE', 'LOCO_MEMBER_UNAVAILABLE', 'LOCO_MEMBERS_UNAVAILABLE']);
function reportError(error) {
  if (closing) return;
  const code = errorCode(error);
  if (!transientErrors.has(code)) { lastError = code; setRecoveryBlocked(true, code); }
  else if (!recoveryBlocked) lastError = code;
  save('connection-status.json', JSON.stringify({ at: Date.now(), stage: stage(), error: lastError, sending }));
}
function exclusive(operation) {
  requireWelcome(!closing && !controlTask, 'LOGIN_BUSY');
  const task = Promise.resolve().then(operation);
  controlTask = task;
  return task.finally(() => { if (controlTask === task) controlTask = undefined; });
}
function errorCode(error) { return /^[A-Z][A-Z0-9_-]{0,79}$/.test(error?.code ?? '') ? error.code : 'RECEIVER_ERROR'; }
function closeClient(target) { try { if (target?.logon) target.close(); } catch {} }
function isConnected() { try { return client?.logon === true && !client.session.stream.ended; } catch { return false; } }
async function connect(credential, signal) {
  signal = AbortSignal.any([shutdown.signal, ...(signal ? [signal] : [])]);
  requireWelcome(!closing && !signal?.aborted, 'LOGIN_EXPIRED');
  requireWelcome(!client, 'ALREADY_CONNECTED');
  const botId = welcomeId(credential.userId?.toString());
  requireWelcome(credential.deviceUUID === identity.deviceUUID, 'DEVICE_ID_MISMATCH');
  const candidate = new nk.TalkClient();
  candidate.on('error', () => { if (client === candidate) lastError = 'LOCO_CONNECTION_ERROR'; });
  candidate.on('disconnected', () => {
    if (client === candidate) {
      lastError = 'LOCO_DISCONNECTED'; listening = false; setRecoveryBlocked(true, lastError);
    }
  });
  candidate.on('switch_server', () => { if (client === candidate) closeClient(candidate); });
  let expired = false, timer;
  const aborted = () => { expired = true; closeClient(candidate); };
  signal?.addEventListener('abort', aborted, { once: true });
  const loginTask = candidate.login({ userId: nk.Long.fromString(botId), deviceUUID: identity.deviceUUID,
    accessToken: credential.accessToken, refreshToken: credential.refreshToken });
  loginTask.then(() => { if (expired || closing) closeClient(candidate); }, () => {});
  try {
    const result = await Promise.race([loginTask, new Promise((_, reject) => {
      timer = setTimeout(() => { aborted(); reject(new WelcomeError('LOCO_LOGIN_TIMEOUT')); }, 25_000);
      signal.addEventListener('abort', () => reject(new WelcomeError('LOGIN_EXPIRED')), { once: true });
    })]);
    requireWelcome(!expired && !closing && !signal?.aborted, 'LOGIN_EXPIRED');
    requireWelcome(result?.success === true && result.status === 0,
      Number.isInteger(result?.status) ? `LOCO_STATUS_${result.status}` : 'LOCO_CONNECT_FAILED');
    requireWelcome(welcomeId(candidate.clientUser.userId.toString()) === botId, 'LOCO_ACCOUNT_CHANGED');
    const rooms = [...candidate.channelList.open.all()].filter(room => !room.info.directChannel).map(room => ({
      id: welcomeId(room.channelId.toString()), name: room.getDisplayName() || `오픈채팅방 ${room.channelId.toString()}`,
    }));
    const saved = { userId: botId, deviceUUID: identity.deviceUUID, accessToken: credential.accessToken, refreshToken: credential.refreshToken };
    const protectedCredential = await protect(JSON.stringify(saved));
    requireWelcome(!expired && !closing && !signal?.aborted, 'LOGIN_EXPIRED');
    save(credentialFile, protectedCredential);
    client = candidate; connectedId = botId; roomChoices = rooms; lastError = undefined;
  } catch (error) {
    expired = true; closeClient(candidate);
    throw error instanceof WelcomeError ? error : new WelcomeError('LOCO_CONNECT_FAILED');
  }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', aborted); }
}
const login = createWelcomeLogin({ api, connect });
async function startReceiver(rooms) {
  requireWelcome(isConnected() && connectedId && !receiver, 'RECEIVER_NOT_READY');
  requireWelcome(Array.isArray(rooms) && rooms.length > 0, 'ROOMS_REQUIRED');
  rooms = [...new Set(rooms.map(welcomeId))].sort();
  requireWelcome(rooms.every(id => roomChoices.some(room => room.id === id)), 'ROOM_NOT_JOINED');
  const adapter = createWelcomeLoco({ client, Long: nk.Long, rooms, botId: connectedId, send: sending });
  for (const room of rooms) { await adapter.verifyRoom(room); requireWelcome(!closing, 'RECEIVER_STOPPED'); }
  const nextStore = new WelcomeStore(pathFor('state.sqlite'));
  try {
    nextStore.baseline(connectedId, rooms, Date.now());
    const handle = createWelcomeHandler({ store: nextStore, iris: adapter, rooms, botId: connectedId, send: sending });
    await adapter.start(async envelope => {
      const result = await handle(envelope);
      if (envelope.json.v.origin === 'NEWMEM' && ['simulated', 'processed'].includes(result.status)) {
        receivedJoins += result.results.length; lastEventAt = Date.now();
        if (result.results.some(item => item.status === 'uncertain')) {
          lastError = 'UNCONFIRMED_REPLY_REQUIRES_REVIEW'; setRecoveryBlocked(true, lastError);
        }
        save('receiver-status.json', JSON.stringify({ receivedJoins, lastEventAt, sending, error: lastError ?? null }));
      }
    }, reportError);
    requireWelcome(!closing, 'RECEIVER_STOPPED');
    save('receiver.json', JSON.stringify({ botId: connectedId, rooms }));
    save('connection-status.json', JSON.stringify({ at: Date.now(), stage: 'listening', sending }));
    receiver = adapter; store = nextStore; listening = true; resumable = true;
  } catch (error) { await adapter.stop(); nextStore.close(); throw error; }
}
async function reconnect() {
  requireWelcome((connectedId || resumable) && !(isConnected() && listening), 'RECONNECT_NOT_REQUIRED');
  const config = existsSync(pathFor('receiver.json')) ? JSON.parse(readFileSync(pathFor('receiver.json'), 'utf8')) : undefined;
  const expectedId = welcomeId(connectedId || config?.botId);
  if (isConnected()) {
    requireWelcome(config?.botId === expectedId, 'LOCO_ACCOUNT_CHANGED');
    return startReceiver(config.rooms);
  }
  listening = false;
  closeClient(client);
  await receiver?.stop(); receiver = undefined;
  store?.close(); store = undefined; client = undefined;
  try {
    const credential = JSON.parse(await protect(readFileSync(pathFor(credentialFile), 'utf8'), true));
    requireWelcome(credential.userId === expectedId, 'LOCO_ACCOUNT_CHANGED');
    await connect(credential);
  } catch (error) {
    if (!isConnected() && !closing) {
      client = undefined; connectedId = undefined; roomChoices = [];
      await login.action('cancel');
    }
    throw error;
  }
  if (config) {
    requireWelcome(config.botId === connectedId, 'LOCO_ACCOUNT_CHANGED');
    await startReceiver(config.rooms);
  }
}
function stage() {
  if (connectedId && !isConnected()) return 'disconnected';
  if (isConnected()) return listening ? 'listening' : 'connected';
  return login.status().stage;
}
setup = createWelcomeSetup({
  status: () => ({ stage: stage(), busy: !!controlTask, serverNow: Date.now(),
    runtime: process.platform === 'linux' ? 'server' : 'pc',
    rooms: roomChoices, sending, receivedJoins, lastEventAt, error: lastError,
    ...(login.status().challenge ? { challenge: login.status().challenge } : {}) }),
  action: (action, body) => {
    const operation = async () => {
      requireWelcome(!closing, 'LOGIN_CLOSED');
      lastError = undefined;
      setRecoveryBlocked(!['start', 'reconnect'].includes(action), 'MANUAL_AUTHENTICATION');
      if (action === 'reconnect') return reconnect();
      if (action === 'start') return startReceiver(body.rooms);
      return login.action(action, body);
    };
    // Cancellation invalidates the pending attempt without releasing its control lock.
    return (action === 'cancel' ? operation() : exclusive(operation)).then(result => {
      save('connection-status.json', JSON.stringify({ at: Date.now(), stage: stage(), sending }));
      return result;
    }, error => {
      reportError(error);
      throw error;
    });
  },
});
const setupUrl = await setup.listen(Number(process.env.KAKAO_WELCOME_SETUP_PORT ?? 0));
save('setup.json', JSON.stringify({ url: setupUrl, pid: process.pid, sending, startedAt: Date.now() }));
console.log(JSON.stringify({ status: 'setup_ready', sending }));
if (flags.includes('--resume')) {
  try {
    if (resumable && !recoveryBlocked) await exclusive(reconnect);
  } catch (error) { reportError(error); }
}
const supervisor = createWelcomeSupervisor({
  getStatus: () => ({ connected: isConnected() && listening, ready: resumable,
    busy: !!controlTask || closing, blocked: recoveryBlocked }),
  reconnect: () => exclusive(reconnect), onError: reportError,
});
supervisor.start();
async function close() {
  if (closing) return;
  closing = true; shutdown.abort(); login.close();
  supervisor.stop();
  await controlTask?.catch(() => {});
  await receiver?.stop(); closeClient(client); store?.close();
  await setup.close();
  await new Promise(resolve => instance.close(resolve));
}
process.once('SIGINT', close);
process.once('SIGTERM', close);
