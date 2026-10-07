import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { validateConfig } from './config.js';
import { createStore } from './store.js';
import { createUnlinkInbox } from './inbox.js';
import { authorizationUrl, exchangeIdentity, unlinkKakao } from './providers.js';
import { guildRoutes, handleGuild } from './guild-api.js';
import { GUILD_ATTENDANCE_PATH, createAttendanceBoardService } from './attendance-board.js';
import { CHARACTER_SPECUP_PATH, createCharacterSpecupService } from './character-specup.js';
import { HONING_PATH, createHoningService } from './honing-service.js';
import { HOMEWORK_BODY_LIMIT, createHomeworkStore } from './homework-store.js';
import { AUTO_CHARACTERS, CHARACTER_LIMIT, DAILY, DATA_DATE as HOMEWORK_DATA_DATE, RAID_CATALOGUE, RAID_LIMIT, WEEKLY, autoSelection, nextReset, raidId } from '../../src/data/homework.js';
import { GuildError } from './guild-store.js';
import { verifyAutomaticMembership } from './guild-automatic.js';
import { findCharacterProfile, normalizeNickname, normalizeCharacter } from './character-profile.js';
import { createCharacterSpecService, specSections } from './character-spec.js';
import { createCharacterSnapshotStore } from './character-snapshot-store.js';
import { createOfficialBudget } from './official-budget.js';
import { createLoungeService, loungeSections } from './lounge-service.js';
import { createMarketService } from './market-service.js';
import { createCharacterEfficiencyService } from './character-efficiency.js';
import { createGoldHistoryService } from './gold-history.js';
import { createBraceletValueService } from './bracelet-value.js';
import { createBraceletValueRecordStore } from './bracelet-value-record-store.js';
import { createScoreRecordStore } from './score-record-store.js';
import { createMemberRosterService } from './member-roster.js';
import { createValuationPriceService } from './valuation-prices.js';
import { createCharacterValuationService } from './character-valuation.js';
import { createValuationCurrencyService } from './valuation-currency.js';
import { getHoningValuationRecipe } from '../../src/honing-valuation.js';
import { BOT_VALUES_PATH, botTokenMatches, isLoopbackAddress, parseBotParts, summarizeBotEfficiency, summarizeBotSpec, summarizeBotValuation } from './bot-values.js';
import { createRosterValueRecordStore } from './roster-value-record-store.js';
import { createRosterRecordStore } from './roster-record-store.js';
import { BOT_ROSTER_VALUES_PATH, BOT_ROSTER_VALUES_REFRESH_PATH, createRosterValueService, parseRosterValueBody, parseRosterValueNames } from './roster-values.js';

const BINDING = '__Host-web_binding';
const SESSION = '__Host-web_session';
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const STATE_TTL_SECONDS = 300;
const SESSION_SECONDS = 7 * 86400;
const signupRoutes = ['/api/auth/signup/character', '/api/auth/signup/complete'];
const ownershipRoutes = { '/api/auth/ownership': 'GET', '/api/auth/ownership/character': 'POST',
  '/api/auth/ownership/verify': 'POST', '/api/auth/ownership/renew': 'POST', '/api/auth/ownership/discord': 'POST' };
const memberCharacterRoutes = { '/api/auth/characters': 'GET', '/api/auth/characters/representative': 'POST', '/api/auth/characters/profile': 'GET' };
// 숙제표: 표 한 판 읽기와, 표에 올릴 캐릭터·체크 저장.
const homeworkRoutes = { '/api/auth/homework': 'GET', '/api/auth/homework/characters': 'POST',
  '/api/auth/homework/check': 'POST', '/api/auth/homework/auto': 'POST' };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const nonce = () => randomBytes(32).toString('base64url');
const csrf = (token) => createHash('sha256').update(`web-csrf:${token}`).digest('base64url');
const cookie = (name, value, seconds) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;

function equal(left, right) {
  return typeof left === 'string' && timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest());
}

class RequestError extends Error {
  constructor(status, code = 'invalid_request') { super(code); this.status = status; this.code = code; }
}

function readCookies(header = '') {
  if (header.length > 4096) throw new RequestError(431);
  const cookies = Object.create(null);
  for (const item of header.split(';')) {
    if (!item.trim()) continue;
    const index = item.indexOf('=');
    if (index < 1) throw new RequestError(400);
    const name = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (name !== BINDING && name !== SESSION) continue;
    if (name in cookies || !NONCE.test(value)) throw new RequestError(400);
    cookies[name] = value;
  }
  return cookies;
}

async function checkRequest(request) {
  if (!request.url || request.url.length > 4096) throw new RequestError(414);
  if (!request.url.startsWith('/') || request.url.startsWith('//') || request.rawHeaders.length > 100) throw new RequestError(400);
  const path = request.url.split('?')[0];
  // The bot's refresh request carries up to 64 character names and a homework write carries up to 60 checks or a
  // whole board; every other route keeps the 1 KiB body limit.
  const limit = path === BOT_ROSTER_VALUES_REFRESH_PATH ? 8192 : homeworkRoutes[path] === 'POST' ? HOMEWORK_BODY_LIMIT : 1024;
  if (Number(request.headers['content-length'] || 0) > limit) throw new RequestError(413);
  const cookies = readCookies(request.headers.cookie);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new RequestError(413);
    chunks.push(chunk);
  }
  if (size && request.url !== '/api/auth/kakao/unlink' && !signupRoutes.includes(path) && path !== BOT_ROSTER_VALUES_REFRESH_PATH &&
    ownershipRoutes[path] !== 'POST' && memberCharacterRoutes[path] !== 'POST' && guildRoutes[path] !== 'POST' &&
    homeworkRoutes[path] !== 'POST') throw new RequestError(400);
  return { cookies, body: Buffer.concat(chunks).toString('utf8') };
}

function requestIp(request) {
  const remote = request.socket.remoteAddress;
  const forwarded = request.headers['x-real-ip'];
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) && typeof forwarded === 'string' && isIP(forwarded)) return forwarded;
  return remote || 'unknown';
}

export function createWebServer({ config: input, fetchImpl: rawFetch = fetch, now = Date.now, allowHttpForTests = false, readLopecScore, botInternalUrl,
  verifyStoveImpl = async input => (await import('./stove-verification.js')).verifyStoveCharacter(input) }) {
  const config = validateConfig(input, allowHttpForTests);
  const fetchImpl = createOfficialBudget({ fetchImpl: rawFetch, now });
  const store = createStore(config.dbPath);
  let inbox;
  try { inbox = createUnlinkInbox(`${config.dbPath}.unlink-inbox`); }
  catch (error) { store.close(); throw error; }
  const providers = Object.fromEntries(Object.entries(config.providers).map(([name, value]) => [name, Boolean(value.clientId && value.clientSecret && (name !== 'kakao' || (value.adminKey && value.appId)))]));
  const attempts = new Map();
  const deletions = new Map();
  const signupPreviews = new Map();
  const signupLookups = new Set();
  const ownershipWork = new Map();
  let characterSnapshots;
  try { characterSnapshots = createCharacterSnapshotStore(`${config.dbPath}.character-snapshots.sqlite`, { now }); }
  catch { console.warn('Character snapshot storage is unavailable; live lookups remain enabled.'); }
  let braceletValueRecords = null;
  try { braceletValueRecords = createBraceletValueRecordStore(`${config.dbPath}.bracelet-values.sqlite`, { now }); }
  catch { console.warn('Bracelet value record storage is unavailable; current calculations remain enabled.'); }
  let scoreRecords = null;
  try { scoreRecords = createScoreRecordStore(`${config.dbPath}.score-records.sqlite`, { now }); }
  catch { console.warn('Score record storage is unavailable; current calculations remain enabled.'); }
  let rosterValueRecords = null;
  try { rosterValueRecords = createRosterValueRecordStore(`${config.dbPath}.roster-values.sqlite`, { now }); }
  catch { console.warn('Roster value record storage is unavailable; the bot roster value routes stay closed.'); }
  // 원정대 최고 기록 lives in its own sidecar, so a corrupt record file never closes the current-value routes.
  let rosterRecords = null;
  try { rosterRecords = createRosterRecordStore(`${config.dbPath}.roster-records.sqlite`, { now }); }
  catch { console.warn('Roster record storage is unavailable; `/체급` falls back to the current roster value.'); }
  // 숙제표는 인증 데이터베이스 스키마를 건드리지 않도록 전용 파일에 둔다.
  let homework = null;
  try { homework = createHomeworkStore(`${config.dbPath}.homework.sqlite`, { now }); }
  catch { console.warn('Homework storage is unavailable; the homework board stays closed.'); }
  const characterSpecs = createCharacterSpecService({ config, fetchImpl, now, snapshotStore: characterSnapshots, scoreRecordStore: scoreRecords });
  const characterEfficiency = createCharacterEfficiencyService({ readDetails: name => characterSpecs.get(name, 'details'), readRoster: name => characterSpecs.get(name, 'roster'),
    now, scoreRecords, ...(readLopecScore ? { readLopecScore } : {}) });
  const braceletValue = createBraceletValueService({ config, fetchImpl, readDetails: name => characterSpecs.get(name, 'details'), recordStore: braceletValueRecords, now });
  const lounge = createLoungeService({ config, fetchImpl, now });
  const market = createMarketService({ config, fetchImpl, now });
  // 재련 최저 비용 계산기 — 봇의 /강화와 같은 계산기를 쓰고 시세만 거래소에서 받는다.
  const honing = createHoningService({ market, now });
  const valuationPrices = createValuationPriceService({ market, config, fetchImpl, now });
  const valuationCurrency = createValuationCurrencyService({ fetchImpl: rawFetch, now });
  // Durable 원정대 환산 가치 for `/체급`: the website stores what it has already calculated and the bot only reads it.
  let rosterValues = null;
  const characterValuation = createCharacterValuationService({ prices: valuationPrices, currency: valuationCurrency, braceletValue, now,
    honingRecipe: getHoningValuationRecipe, readDetails: name => characterSpecs.get(name, 'details'), readRoster: name => characterSpecs.get(name, 'roster'),
    onRoster: roster => rosterValues?.absorbRoster(roster),
    onCharacterValue: (row, inputs) => { void rosterValues?.absorb(row, row.value, inputs).catch(() => {}); } });
  if (rosterValueRecords) rosterValues = createRosterValueService({ store: rosterValueRecords, recordStore: rosterRecords, now,
    readRoster: name => characterSpecs.get(name, 'roster', { refresh: true }), readDetails: name => characterSpecs.get(name, 'details'),
    calculate: name => characterValuation.value(name), valueFrom: (name, inputs) => characterValuation.valueFrom(name, inputs) });
  // 길드 화면의 카카오톡 출석 현황은 봇만 가진 기록이라 같은 기기의 봇 서버에서 루프백으로 받아 온다.
  const attendanceBoard = createAttendanceBoardService({ fetchImpl: rawFetch, token: config.botInternalToken, now,
    ...(botInternalUrl === undefined ? {} : { base: botInternalUrl }) });
  // 캐릭터 화면 스펙업 탭. 계산은 봇만 할 수 있어 같은 기기의 봇에게 묻고, 봇이 답하지 않으면 offline을 준다.
  const characterSpecup = createCharacterSpecupService({ fetchImpl: rawFetch, token: config.botInternalToken, now,
    ...(botInternalUrl === undefined ? {} : { base: botInternalUrl }) });
  const goldHistory = createGoldHistoryService({ fetchImpl: rawFetch, now });
  const memberRosters = createMemberRosterService({ config, fetchImpl, now });
  let specRequests = 0;
  let storageFailed = false;
  let closing;
  let retries;

  function executeDeletion(userId) {
    if (deletions.has(userId)) return deletions.get(userId);
    const task = (async () => {
      const intent = store.deletion(userId);
      if (!intent) return;
      if (!intent.confirmed) {
        try { await unlinkKakao(config, intent.providerId, fetchImpl); }
        catch {
          store.retryDeletion(userId, now());
          throw new RequestError(502, 'provider_error');
        }
        store.confirmDeletion(userId);
      }
      // 탈퇴 요청이 남아 있으므로 숙제표를 지우지 못하면 계정도 남겨 두고 1분 뒤 다시 시도한다.
      if (!forgetHomework(userId)) {
        store.retryDeletion(userId, now());
        throw new RequestError(503, 'storage_unavailable');
      }
      store.deleteLocalAccount(userId);
    })().finally(() => deletions.delete(userId));
    deletions.set(userId, task);
    return task;
  }

  // 계정이 사라지면 숙제표도 함께 지운다(다른 파일이라 자동으로 지워지지 않는다). 숙제표는 언제나 계정보다 먼저,
  // 탈퇴 의사가 확인된 경로에서만 지운다. 계정 행이 없다는 사실만으로는 지우지 않는다 — 인증 파일이 없어져 새로
  // 만들어졌거나 예전 백업으로 되돌린 경우와 실제 탈퇴를 가려낼 수 없다(2026-09-23 교차 검토 B-R1).
  // 지웠거나 지울 것이 없으면 true, 저장소 오류면 false.
  function forgetHomework(userId) {
    try { homework?.forget(userId); return true; }
    catch { console.warn('Homework storage could not be cleared for a deleted account.'); return false; }
  }

  // 카카오 쪽에서 앱 연결을 끊은 회원의 계정을 지운다. 받은 요청이 저장돼 있으면(queued) 숙제표를 지우지 못했을
  // 때 계정을 남기고 false를 돌려 다음 정리 주기가 다시 시도하게 한다. 그동안 이 카카오 계정의 로그인과 세션은
  // 막혀 있다. 요청을 저장하지 못했다면 다시 시도할 근거가 없으므로 계정 삭제를 미루지 않는다.
  function removeUnlinked(providerId, queued) {
    const cleared = store.kakaoAccountIds(providerId).every(forgetHomework);
    if (!cleared && queued) return false;
    store.externalUnlink(providerId);
    return true;
  }

  function retryDeletions() {
    if (retries || closing || !providers.kakao) return;
    retries = (async () => {
      for (const item of store.pendingDeletions(now())) {
        if (closing) break;
        try { await executeDeletion(item.userId); }
        catch (error) { if (!(error instanceof RequestError)) storageFailed = true; }
      }
    })().catch(() => { storageFailed = true; }).finally(() => { retries = null; });
  }

  function rateAllowed(request, action, timestamp) {
    const key = `${action}:${requestIp(request)}`;
    let entry = attempts.get(key);
    if (!entry || entry.expiresAt <= timestamp) {
      if (!entry && attempts.size >= 10000) return false;
      entry = { count: 0, expiresAt: timestamp + 600000 };
      attempts.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= (action === 'start' ? 30 : 60);
  }
  function cleanup() {
    const timestamp = now();
    for (const [key, value] of attempts) if (value.expiresAt <= timestamp) attempts.delete(key);
    for (const [key, value] of signupPreviews) if (value.expiresAt <= timestamp) signupPreviews.delete(key);
    try { store.cleanup(timestamp); storageFailed = false; } catch { storageFailed = true; }
    try {
      for (const userId of inbox.pending()) {
        try { if (!removeUnlinked(userId, true)) break; inbox.remove(userId); }
        catch { storageFailed = true; break; }
      }
    } catch { storageFailed = true; }
    retryDeletions();
  }
  cleanup();
  const timer = setInterval(cleanup, 60000);
  timer.unref();

  async function runOwnershipWork(userId, response, action) {
    if (closing || ownershipWork.has(userId) || ownershipWork.size >= 20) throw new GuildError(429, 'verification_busy');
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 15000); deadline.unref();
    ownershipWork.set(userId, controller);
    const abort = () => controller.abort();
    response.once('close', abort);
    const work = Promise.resolve().then(() => action(controller.signal)).finally(() => {
      clearTimeout(deadline); response.removeListener('close', abort); ownershipWork.delete(userId);
    });
    let onAbort;
    try {
      const aborted = new Promise((resolve, reject) => {
        onAbort = () => reject(new GuildError(502, 'verification_unavailable'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      return await Promise.race([work, aborted]);
    } finally { controller.signal.removeEventListener('abort', onAbort); }
  }
  function json(response, status, value) {
    if (status === 200 && response.accessCheck) response.accessCheck();
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  }
  function getAuthorizedSession(token, timestamp) {
    if (!token) return undefined;
    const tokenHash = hash(token);
    const account = store.getAccount(tokenHash, timestamp);
    if (account?.provider === 'kakao' && inbox.has(account.providerId)) return undefined;
    return store.getSession(tokenHash, timestamp);
  }
  function siteAccess(user, timestamp) {
    if (!user) return { authenticated: false, approved: false, status: 'anonymous' };
    const membership = store.guild.state(user.id, timestamp).membership;
    const approved = membership?.status === 'approved';
    const status = membership?.status || (store.ownership.summary(user.id).state === 'verified' ? 'application_required' : 'verification_required');
    return { authenticated: true, approved, status };
  }
  function requireSiteAccess(token) {
    const user = getAuthorizedSession(token, now());
    if (!user) throw new RequestError(401, 'login_required');
    if (!siteAccess(user, now()).approved) throw new RequestError(403, 'approval_required');
    return user;
  }
  function ownershipState(user, token, timestamp) {
    const state = store.ownership.state(user.id, timestamp, hash(token));
    return { ...state, discord: { enabled: config.automaticApproval.enabled,
      eligible: config.automaticApproval.enabled && user.provider === 'discord' && state.state === 'pending' } };
  }
  function redirect(response, error) {
    response.writeHead(303, { Location: `/account.html${error ? `?error=${error}` : ''}` });
    response.end();
  }
  function rateLimited(response, retryAfter) {
    response.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': String(retryAfter) });
    response.end('<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>로그인 요청 제한</title></head><body><main><p>로그인 요청이 잠시 많아졌어요. 잠시 후 다시 시도해 주세요.</p><a href="/account.html">로그인 화면으로 돌아가기</a></main></body></html>');
  }

  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000, keepAliveTimeout: 5000 }, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    let isAuthRoute = false;
    try {
      const { cookies, body } = await checkRequest(request);
      const url = new URL(request.url, config.origin);
      const authRoute = /^\/auth\/(discord|kakao)\/(start|callback)$/.exec(url.pathname);
      isAuthRoute = Boolean(authRoute);
      const guildMethod = Object.hasOwn(guildRoutes, url.pathname) ? guildRoutes[url.pathname] : null;
      const signupRoute = signupRoutes.includes(url.pathname);
      const ownershipMethod = Object.hasOwn(ownershipRoutes, url.pathname) ? ownershipRoutes[url.pathname] : null;
      const memberCharacterMethod = Object.hasOwn(memberCharacterRoutes, url.pathname) ? memberCharacterRoutes[url.pathname] : null;
      const homeworkMethod = Object.hasOwn(homeworkRoutes, url.pathname) ? homeworkRoutes[url.pathname] : null;
      const historyMatch = /^\/api\/market\/items\/([1-9]\d{0,9})\/history$/.exec(url.pathname);
      const marketRoute = ['/api/market/options', '/api/market/search', '/api/market/bid', '/api/market/gold-history', HONING_PATH].includes(url.pathname) || historyMatch;
      const method = memberCharacterMethod || homeworkMethod || ownershipMethod || guildMethod || (signupRoute ? 'POST' : url.pathname === '/api/auth/account' ? 'DELETE' : ['/api/auth/logout', '/api/auth/kakao/unlink'].includes(url.pathname) ? 'POST' : 'GET');
      if (url.pathname === BOT_VALUES_PATH) {
        // The bot on this machine reads the website's numbers here; anyone else sees an ordinary unknown route.
        if (!isLoopbackAddress(request.socket.remoteAddress) || !botTokenMatches(config.botInternalToken, request.headers['x-bot-token'])) return json(response, 404, { error: 'not_found' });
        if (request.method !== 'GET') {
          response.setHeader('Allow', 'GET');
          return json(response, 405, { error: 'method_not_allowed' });
        }
        const name = normalizeCharacter(url.searchParams.get('name'));
        const parts = parseBotParts(url.searchParams.get('parts'));
        const keys = [...url.searchParams.keys()];
        if (!name || !parts || keys.length !== new Set(keys).size || keys.some(key => !['name', 'parts'].includes(key))) throw new RequestError(400);
        if (!characterValuation.allow('bot')) throw new GuildError(429, 'valuation_rate_limited');
        const result = { characterName: name, updatedAt: now() };
        if (parts.has('efficiency')) {
          let details;
          try { details = await characterSpecs.get(name, 'details'); }
          catch (error) { throw new GuildError(error?.status === 429 ? 429 : 502, error?.status === 429 ? 'character_rate_limited' : 'efficiency_unavailable'); }
          result.efficiency = summarizeBotEfficiency(details?.efficiency);
        }
        if (parts.has('spec')) {
          let profile, details;
          try { [profile, details] = await Promise.all([characterSpecs.get(name, 'profile'), characterSpecs.get(name, 'details')]); }
          catch (error) {
            if (error?.status === 404) throw new GuildError(404, 'character_not_found');
            throw new GuildError(error?.status === 429 ? 429 : 502, error?.status === 429 ? 'character_rate_limited' : 'efficiency_unavailable');
          }
          const tier = await characterEfficiency.resolveTier(name, details?.efficiency?.score);
          let record = null;
          try { record = scoreRecords?.get(name) ?? null; } catch { record = null; }
          result.spec = summarizeBotSpec({ profile: profile?.profile, efficiency: details?.efficiency, tier, record });
        }
        if (parts.has('valuation')) {
          let data = null;
          try { data = await characterValuation.expectations(name); }
          catch (error) { if (error?.status === 429) throw error; }
          result.valuation = summarizeBotValuation(data);
        }
        return json(response, 200, result);
      }
      if (url.pathname === BOT_ROSTER_VALUES_PATH || url.pathname === BOT_ROSTER_VALUES_REFRESH_PATH) {
        // The stored 원정대 환산 가치 for `/체급`: read on every command, refreshed by the bot's nightly job.
        if (!isLoopbackAddress(request.socket.remoteAddress) || !botTokenMatches(config.botInternalToken, request.headers['x-bot-token']) ||
          !rosterValues) return json(response, 404, { error: 'not_found' });
        const isRefresh = url.pathname === BOT_ROSTER_VALUES_REFRESH_PATH;
        const allow = isRefresh ? 'GET, POST' : 'GET';
        if (!allow.split(', ').includes(request.method)) {
          response.setHeader('Allow', allow);
          return json(response, 405, { error: 'method_not_allowed' });
        }
        if (isRefresh && request.method === 'POST') {
          if (url.search || request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new RequestError(400);
          const names = parseRosterValueBody(body);
          if (!names) throw new RequestError(400);
          if (!rosterValues.allowRefresh('bot')) throw new GuildError(429, 'roster_value_rate_limited');
          const started = rosterValues.refresh(names);
          return json(response, started.status === 'started' ? 200 : 202, started);
        }
        if (isRefresh) {
          if (url.search) throw new RequestError(400);
          if (!rosterValues.allowRead('bot')) throw new GuildError(429, 'roster_value_rate_limited');
          return json(response, 200, rosterValues.status());
        }
        const keys = [...url.searchParams.keys()];
        const names = parseRosterValueNames(url.searchParams.get('names'));
        if (!names || keys.length !== 1 || keys[0] !== 'names') throw new RequestError(400);
        if (!rosterValues.allowRead('bot')) throw new GuildError(429, 'roster_value_rate_limited');
        return json(response, 200, rosterValues.read(names));
      }
      if (!authRoute && !memberCharacterMethod && !homeworkMethod && !ownershipMethod && !guildMethod && !signupRoute && !marketRoute && !['/api/lounge', '/api/character/spec', '/api/character/efficiency', '/api/character/bracelet-value', '/api/character/valuation', '/api/auth/session', '/api/auth/logout', '/api/auth/account', '/api/auth/kakao/unlink', '/api/auth/health', CHARACTER_SPECUP_PATH].includes(url.pathname)) return json(response, 404, { error: 'not_found' });
      if (request.method !== method) {
        response.setHeader('Allow', method);
        return json(response, 405, { error: 'method_not_allowed' });
      }
      if (storageFailed && url.pathname !== '/api/auth/kakao/unlink') throw new Error('Storage unavailable');
      const timestamp = now();
      const token = cookies[SESSION];
      if (memberCharacterMethod) {
        const user = requireSiteAccess(token);
        if (url.search || (request.headers.origin && request.headers.origin !== config.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(url.search ? 400 : 403, 'forbidden');
        if (!memberRosters.allow(requestIp(request))) throw new GuildError(429, 'member_roster_rate_limited');
        let snapshot = store.characterPreferences.capture(user.id, hash(token), timestamp);
        response.accessCheck = () => {
          if (requireSiteAccess(token).id !== user.id) throw new RequestError(401, 'login_required');
          store.characterPreferences.assertCurrent(snapshot, now());
        };
        let roster;
        if (memberCharacterMethod === 'POST') {
          if (request.headers.origin !== config.origin || !equal(request.headers['x-csrf-token'], csrf(token))) throw new RequestError(403, 'forbidden');
          if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new RequestError(400);
          let value;
          try { value = JSON.parse(body); } catch { throw new RequestError(400); }
          const fields = ['characterName', 'revision', 'anchorFingerprint'];
          if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) throw new RequestError(400);
          const name = normalizeCharacter(value.characterName);
          if (!name || !Number.isSafeInteger(value.revision) || value.revision < 0 || !/^[a-f0-9]{64}$/.test(value.anchorFingerprint || '')) throw new RequestError(400);
          if (snapshot.preferenceRevision !== value.revision || snapshot.anchorFingerprint !== value.anchorFingerprint) throw new GuildError(409, 'member_character_changed');
          roster = await memberRosters.get(snapshot.anchor.characterName, { fresh: true });
          const character = roster.characters.find(item => item.characterName.toLowerCase() === name.toLowerCase());
          if (!character) throw new GuildError(422, 'member_roster_selection_invalid');
          response.accessCheck();
          if (snapshot.anchor.serverName && roster.anchor.serverName !== snapshot.anchor.serverName) throw new GuildError(409, 'member_character_changed');
          store.characterPreferences.save(snapshot, { character, rosterCheckedAt: roster.updatedAt }, now());
          snapshot = store.characterPreferences.capture(user.id, hash(token), now());
        } else roster = await memberRosters.get(snapshot.anchor.characterName);
        response.accessCheck();
        if (snapshot.anchor.serverName && roster.anchor.serverName !== snapshot.anchor.serverName) throw new GuildError(409, 'member_character_changed');
        const selected = snapshot.selected ? roster.characters.find(item => item.characterName.toLowerCase() === snapshot.selected.characterName.toLowerCase() && item.serverName === snapshot.selected.serverName) || null : null;
        const representative = snapshot.selected ? selected : roster.anchor;
        if (url.pathname.endsWith('/profile')) {
          let profile = representative, profileAvailable = false, score = null;
          if (representative) {
            const [profileResult, detailsResult] = await Promise.allSettled([
              characterSpecs.get(representative.characterName, 'profile'),
              characterSpecs.get(representative.characterName, 'details'),
            ]);
            if (profileResult.status === 'fulfilled') {
              if (profileResult.value.profile.serverName !== representative.serverName) throw new GuildError(409, 'member_character_changed');
              profile = profileResult.value.profile; profileAvailable = true;
            }
            if (profileAvailable && detailsResult.status === 'fulfilled') {
              score = detailsResult.value.efficiency?.score ?? null;
              if (score) score = { ...score, tier: await characterEfficiency.resolveTier(representative.characterName, score) };
            }
          }
          return json(response, 200, { representative: profile, profileAvailable, score, configured: Boolean(selected), selectionUnavailable: Boolean(snapshot.selected && !selected) });
        }
        return json(response, 200, { anchor: snapshot.anchor, anchorFingerprint: snapshot.anchorFingerprint, revision: snapshot.preferenceRevision,
          selected, representative, selectionUnavailable: Boolean(snapshot.selected && !selected), characters: roster.characters, groups: roster.groups, updatedAt: roster.updatedAt, csrfToken: csrf(token) });
      }
      if (homeworkMethod) {
        // 숙제표는 내 계정의 원정대에 붙는 개인 기록이라 가입 승인을 받은 회원만 읽고 쓴다.
        const user = requireSiteAccess(token);
        if (url.search || (request.headers.origin && request.headers.origin !== config.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(url.search ? 400 : 403, 'forbidden');
        if (!homework) return json(response, 503, { error: 'homework_unavailable' });
        response.accessCheck = () => { if (requireSiteAccess(token).id !== user.id) throw new RequestError(401, 'login_required'); };
        const content = () => ({
          daily: DAILY, weekly: WEEKLY, dataDate: HOMEWORK_DATA_DATE,
          raids: RAID_CATALOGUE.map(raid => ({ id: raidId(raid), name: raid.name, diff: raid.diff, ilvl: raid.ilvl, gates: raid.gates })),
          limits: { raids: RAID_LIMIT, characters: CHARACTER_LIMIT, auto: AUTO_CHARACTERS },
          resets: { daily: nextReset(now(), 'daily'), weekly: nextReset(now(), 'weekly') },
          csrfToken: csrf(token),
        });
        if (homeworkMethod === 'POST') {
          if (request.headers.origin !== config.origin || !equal(request.headers['x-csrf-token'], csrf(token))) throw new RequestError(403, 'forbidden');
          if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new RequestError(400);
          if (!rateAllowed(request, 'homework-write', timestamp)) return json(response, 429, { error: 'rate_limited' });
          let value;
          try { value = JSON.parse(body); } catch { throw new RequestError(400); }
          const auto = url.pathname.endsWith('/auto');
          const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : null;
          if (!keys || keys.length !== (auto ? 0 : 1)) throw new RequestError(400);
          if (url.pathname.endsWith('/check')) {
            const board = homework.applyChecks(user.id, value.changes, timestamp);
            return json(response, 200, { ...board, ...content() });
          }
          // 표에 올릴 캐릭터는 이름만 받고 서버·직업·레벨은 원정대 조회 값을 쓴다.
          if (!auto && !Array.isArray(value.characters)) throw new RequestError(400);
          const snapshot = store.characterPreferences.capture(user.id, hash(token), timestamp);
          if (!memberRosters.allow(requestIp(request))) throw new GuildError(429, 'member_roster_rate_limited');
          const roster = await memberRosters.get(snapshot.anchor.characterName);
          response.accessCheck();
          // 자동 선정: 표가 비어 있으면 레벨 높은 순으로 채우고, 이미 있으면 레이드를 안 고른 캐릭터만 채운다.
          const wanted = auto ? autoSelection(roster.characters, homework.board(user.id, timestamp).characters) : value.characters;
          const entries = wanted.map(entry => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.characterName !== 'string') throw new RequestError(400);
            const member = roster.characters.find(item => item.characterName.toLowerCase() === entry.characterName.toLowerCase());
            if (!member) throw new GuildError(422, 'member_roster_selection_invalid');
            return { ...member, raids: Array.isArray(entry.raids) ? entry.raids : [] };
          });
          const board = homework.saveCharacters(user.id, entries, now());
          return json(response, 200, { ...board, ...content(), roster: roster.characters, rosterUpdatedAt: roster.updatedAt });
        }
        // 원정대 조회가 잠시 안 되더라도 저장해 둔 표는 그대로 보여 준다.
        const snapshot = store.characterPreferences.capture(user.id, hash(token), timestamp);
        let roster = null;
        if (memberRosters.allow(requestIp(request))) {
          try { roster = await memberRosters.get(snapshot.anchor.characterName); } catch { roster = null; }
        }
        response.accessCheck();
        const board = roster ? homework.syncLevels(user.id, roster.characters, now()) : homework.board(user.id, timestamp);
        return json(response, 200, { ...board, ...content(), roster: roster?.characters ?? null, rosterUpdatedAt: roster?.updatedAt ?? null });
      }
      // Character lookup is public (2026-09-17); it keeps its own per-IP limits below. Lounge and market stay member-only.
      if (marketRoute || url.pathname === '/api/lounge') {
        const user = requireSiteAccess(token);
        response.accessCheck = () => { if (requireSiteAccess(token).id !== user.id) throw new RequestError(401, 'login_required'); };
      }
      if (ownershipMethod) {
        const user = getAuthorizedSession(token, timestamp);
        if (!user) throw new RequestError(401, 'login_required');
        if (url.search || (request.headers.origin && request.headers.origin !== config.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'forbidden');
        if (ownershipMethod === 'GET') return json(response, 200, ownershipState(user, token, timestamp));
        if (request.headers.origin !== config.origin || !equal(request.headers['x-csrf-token'], csrf(token))) throw new RequestError(403, 'forbidden');
        if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new RequestError(400);
        let value; try { value = JSON.parse(body); } catch { throw new RequestError(400); }
        const fields = url.pathname.endsWith('/character') ? ['characterName'] : url.pathname.endsWith('/verify') ? ['revision', 'profileUrl'] : ['revision'];
        if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw new RequestError(400);
        if (!fields.includes('characterName') && (!Number.isSafeInteger(value.revision) || value.revision < 1)) throw new RequestError(400);
        if (!rateAllowed(request, 'ownership', timestamp)) throw new GuildError(429, 'rate_limited');
        if (url.pathname.endsWith('/renew')) {
          store.ownership.renew(user.id, hash(token), value.revision, timestamp);
          return json(response, 200, ownershipState(user, token, timestamp));
        }
        if (url.pathname.endsWith('/discord')) {
          if (!config.automaticApproval.enabled) throw new GuildError(503, 'automatic_unavailable');
          const state = nonce(); const verifier = nonce(); const binding = cookies[BINDING] || nonce();
          store.ownership.beginDiscord({ stateHash: hash(state), userId: user.id, sessionHash: hash(token), bindingHash: hash(binding), verifier, revision: value.revision }, timestamp);
          response.setHeader('Set-Cookie', cookie(BINDING, binding, STATE_TTL_SECONDS));
          return json(response, 200, { authorizationUrl: authorizationUrl('discord', config, state, verifier, true) });
        }
        const result = await runOwnershipWork(user.id, response, async signal => {
          if (url.pathname.endsWith('/character')) {
            const name = normalizeCharacter(value.characterName); if (!name) throw new RequestError(400);
            const revision = store.ownership.checkSelection(user.id, hash(token), timestamp);
            const profile = await findCharacterProfile(config, name, fetchImpl, { extended: true });
            if (signal.aborted) throw new GuildError(502, 'character_unavailable');
            if (getAuthorizedSession(token, now())?.id !== user.id) throw new RequestError(401, 'login_required');
            store.ownership.select(user.id, hash(token), profile, revision, now());
          } else {
            if (typeof value.profileUrl !== 'string' || value.profileUrl.length > 512) throw new RequestError(400);
            const proof = store.ownership.beginStove(user.id, hash(token), value.revision, timestamp);
            let result;
            try { result = await verifyStoveImpl({ profileUrl: value.profileUrl, characterName: proof.characterName, code: proof.code, fetchImpl: rawFetch, signal: signal }); }
            catch (error) { throw new GuildError([400, 403, 404, 409, 422, 429, 502, 503].includes(error.status) ? error.status : 502,
              /^[a-z_]{1,80}$/.test(error.code || '') ? error.code : 'verification_unavailable'); }
            if (signal.aborted) throw new GuildError(502, 'verification_unavailable');
            if (getAuthorizedSession(token, now())?.id !== user.id) throw new RequestError(401, 'login_required');
            store.ownership.finishStove(proof, result, now());
          }
          return ownershipState(user, token, now());
        });
        return json(response, 200, result);
      }
      if (url.pathname === '/api/lounge' || marketRoute) {
        if ((request.headers.origin && request.headers.origin !== config.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'forbidden');
        const keys = [...url.searchParams.keys()];
        if (new Set(keys).size !== keys.length) throw new RequestError(400);
        if (url.pathname === '/api/lounge') {
          if (keys.length !== 1 || keys[0] !== 'section' || !loungeSections.has(url.searchParams.get('section'))) throw new RequestError(400);
          if (!lounge.allow(requestIp(request))) throw new GuildError(429, 'lounge_rate_limited');
          return json(response, 200, await lounge.get(url.searchParams.get('section')));
        }
        if (url.pathname === HONING_PATH) {
          if (keys.length !== 3 || !['kind', 'from', 'to'].every(key => url.searchParams.has(key))) throw new RequestError(400);
          // 거래소 조회를 함께 쓰므로 시장 검색과 같은 한도를 적용한다.
          if (!market.allow(requestIp(request))) throw new GuildError(429, 'market_rate_limited');
          return json(response, 200, await honing.get({ kind: url.searchParams.get('kind'),
            from: url.searchParams.get('from'), to: url.searchParams.get('to') }));
        }
        if (url.pathname === '/api/market/gold-history') {
          if (keys.some(key => key !== 'server')) throw new RequestError(400);
          if (!goldHistory.allow(requestIp(request))) throw new GuildError(429, 'gold_history_rate_limited');
          return json(response, 200, await goldHistory.get(url.searchParams.get('server') ?? 'lupeon'));
        }
        if (!market.allow(requestIp(request))) throw new GuildError(429, 'market_rate_limited');
        if (url.pathname === '/api/market/options') {
          if (keys.length) throw new RequestError(400);
          return json(response, 200, await market.options());
        }
        if (historyMatch) {
          if (keys.length) throw new RequestError(400);
          return json(response, 200, await market.history(Number(historyMatch[1])));
        }
        if (url.pathname === '/api/market/bid') {
          if (keys.length !== 2 || keys.some(key => !['price', 'partySize'].includes(key))) throw new RequestError(400);
          return json(response, 200, market.calculateBid(url.searchParams.get('price'), url.searchParams.get('partySize')));
        }
        if (keys.some(key => !['kind', 'q', 'category', 'sort', 'order', 'page'].includes(key))) throw new RequestError(400);
        const values = Object.fromEntries(url.searchParams); const { q, ...filters } = values;
        return json(response, 200, await market.search({ ...filters, query: q ?? '' }));
      }
      if (url.pathname === CHARACTER_SPECUP_PATH) {
        // 스펙업 계산은 봇의 격리 슬롯 하나를 카카오톡·디스코드와 나눠 쓴다. 로그인 없이 걸 수 있으면
        // 방에서 쓰는 /스펙업이 먼저 밀리므로 이 탭만 가입 승인 회원으로 제한한다(설계 §3).
        requireSiteAccess(token);
        if ((request.headers.origin && request.headers.origin !== config.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'forbidden');
        const name = normalizeCharacter(url.searchParams.get('name'));
        const keys = [...url.searchParams.keys()];
        if (!name || keys.length !== 1 || keys[0] !== 'name') throw new RequestError(400);
        if (!rateAllowed(request, 'character-specup', timestamp)) return json(response, 429, { error: 'rate_limited' });
        return json(response, 200, await characterSpecup.read(name));
      }
      if (url.pathname === '/api/character/valuation') {
        const name = normalizeCharacter(url.searchParams.get('name'));
        const scope = url.searchParams.get('scope') || 'roster';
        const refresh = url.searchParams.get('refresh');
        const keys = [...url.searchParams.keys()];
        if (!name || !['character', 'roster'].includes(scope) || keys.length !== new Set(keys).size ||
            keys.some(key => !['name', 'scope', 'refresh'].includes(key)) ||
            (refresh !== null && refresh !== '0' && refresh !== '1')) throw new RequestError(400);
        if ((request.headers.origin && request.headers.origin !== config.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'forbidden');
        if (specRequests >= 100 || !characterValuation.allow(requestIp(request))) throw new GuildError(429, 'valuation_rate_limited');
        specRequests++;
        try { return json(response, 200, await characterValuation.get(name, scope, { refresh: refresh === '1' })); }
        finally { specRequests--; }
      }
      if (url.pathname === '/api/character/efficiency' || url.pathname === '/api/character/bracelet-value') {
        const service = url.pathname.endsWith('/bracelet-value') ? braceletValue : characterEfficiency;
        const name = normalizeCharacter(url.searchParams.get('name'));
        if (!name || [...url.searchParams.keys()].length !== 1 || !url.searchParams.has('name')) throw new RequestError(400);
        if ((request.headers.origin && request.headers.origin !== config.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'forbidden');
        if (specRequests >= 100 || !service.allow(requestIp(request))) throw new GuildError(429, 'efficiency_rate_limited');
        specRequests++;
        try { return json(response, 200, await service.get(name)); }
        finally { specRequests--; }
      }
      if (url.pathname === '/api/character/spec') {
        const name = normalizeCharacter(url.searchParams.get('name'));
        const section = url.searchParams.get('section');
        const keys = [...url.searchParams.keys()];
        const refresh = url.searchParams.get('refresh');
        if (!name || !specSections.has(section) || keys.length !== new Set(keys).size ||
            keys.some(key => !['name', 'section', 'refresh'].includes(key)) ||
            (refresh !== null && refresh !== '0' && refresh !== '1')) throw new RequestError(400);
        if ((request.headers.origin && request.headers.origin !== config.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'forbidden');
        if (specRequests >= 100 || !characterSpecs.allow(requestIp(request))) throw new GuildError(429, 'character_rate_limited');
        specRequests++;
        try { return json(response, 200, await characterSpecs.getForDisplay(name, section, { refresh: refresh === '1' })); }
        finally { specRequests--; }
      }
      if (url.pathname === '/api/auth/health') {
        if (inbox.hasAny()) throw new Error('Unlink inbox needs recovery');
        store.healthy();
        return json(response, 200, { ok: true });
      }
      if (signupRoute) {
        const user = getAuthorizedSession(token, timestamp);
        if (!user) return json(response, 401, { error: 'login_required' });
        if (user.provider !== 'kakao' || request.headers.origin !== config.origin || !equal(request.headers['x-csrf-token'], csrf(token))) return json(response, 403, { error: 'forbidden' });
        if (url.search || request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new RequestError(400);
        let value;
        try { value = JSON.parse(body); } catch { throw new RequestError(400); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError(400);
        const nickname = normalizeNickname(value.nickname);
        const characterName = normalizeCharacter(value.characterName);
        const isLookup = url.pathname === '/api/auth/signup/character';
        const fields = isLookup ? ['nickname', 'characterName'] : ['nickname', 'characterName', 'ticket'];
        if (!nickname || !characterName || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) throw new RequestError(400);
        if (store.signup.state(user.id)?.state === 'complete') throw new RequestError(409, 'signup_complete');
        if (!rateAllowed(request, 'signup', timestamp)) return json(response, 429, { error: 'rate_limited' });
        if (isLookup) {
          if (signupLookups.has(user.id) || signupLookups.size >= 20 || signupPreviews.size >= 1000) throw new RequestError(429, 'character_rate_limited');
          signupLookups.add(user.id);
          signupPreviews.delete(user.id);
          try {
            const character = await findCharacterProfile(config, characterName, fetchImpl);
            const completedAt = now();
            if (getAuthorizedSession(token, completedAt)?.id !== user.id) throw new RequestError(401, 'login_required');
            if (store.signup.state(user.id)?.state === 'complete') throw new RequestError(409, 'signup_complete');
            const preview = { ticket: nonce(), tokenHash: hash(token), nickname, character, expiresAt: completedAt + 300000 };
            signupPreviews.set(user.id, preview);
            return json(response, 200, { character, ticket: preview.ticket, expiresIn: 300 });
          } finally { signupLookups.delete(user.id); }
        }
        const preview = signupPreviews.get(user.id);
        if (!preview || preview.expiresAt <= timestamp || preview.tokenHash !== hash(token) || !equal(value.ticket, preview.ticket) ||
            preview.nickname !== nickname || preview.character.characterName.toLowerCase() !== characterName.toLowerCase()) throw new RequestError(409, 'character_confirmation_expired');
        const registration = store.signup.complete(user.id, nickname, preview.character, timestamp);
        signupPreviews.delete(user.id);
        return json(response, 200, { registration });
      }
      if (guildMethod) {
        const user = getAuthorizedSession(token, timestamp);
        if (!user) return json(response, 401, { error: 'login_required' });
        if (guildMethod === 'POST') {
          if (request.headers.origin !== config.origin || !equal(request.headers['x-csrf-token'], csrf(token))) return json(response, 403, { error: 'forbidden' });
          if (!rateAllowed(request, 'guild-write', timestamp)) return json(response, 429, { error: 'rate_limited' });
        }
        const targetAvailable = (userId) => {
          const identity = store.identity(userId);
          return Boolean(identity && (identity.provider !== 'kakao' || !inbox.has(identity.providerId)));
        };
        if (url.pathname === '/api/auth/guild/automatic') {
          throw new GuildError(410, 'ownership_required');
        }
        if (url.pathname === GUILD_ATTENDANCE_PATH) {
          // 승인된 길드원만 본다. 봇을 기다리는 사이 열람 권한이 바뀌면 답을 보내지 않는다.
          if (url.search) throw new RequestError(400);
          if (!store.guild.state(user.id, timestamp).canViewSheet) return json(response, 403, { error: 'forbidden' });
          response.accessCheck = () => {
            const current = getAuthorizedSession(token, now());
            if (current?.id !== user.id) throw new RequestError(401, 'login_required');
            if (!store.guild.state(user.id, now()).canViewSheet) throw new RequestError(403, 'forbidden');
          };
          return json(response, 200, await attendanceBoard.read());
        }
        const result = handleGuild({ store, user, url, body, request, timestamp, targetAvailable });
        return json(response, 200, result);
      }
      if (url.pathname === '/api/auth/kakao/unlink') {
        if (!config.providers.kakao.adminKey || !config.providers.kakao.appId) return json(response, 503, { error: 'provider_unavailable' });
        if (!equal(request.headers.authorization, `KakaoAK ${config.providers.kakao.adminKey}`)) return json(response, 403, { error: 'forbidden' });
        if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new RequestError(400);
        const fields = new URLSearchParams(body);
        const appId = fields.get('app_id');
        const userId = fields.get('user_id');
        if (fields.getAll('app_id').length !== 1 || fields.getAll('user_id').length !== 1 || appId !== config.providers.kakao.appId ||
            !/^[1-9][0-9]{0,15}$/.test(userId || '') || !Number.isSafeInteger(Number(userId))) throw new RequestError(400);
        let durable = false;
        try { inbox.enqueue(userId); durable = true; } catch {}
        try {
          if (removeUnlinked(userId, durable)) { try { inbox.remove(userId); } catch {} }
        } catch {
          if (!durable) throw new Error('Unlink storage unavailable');
        }
        response.writeHead(200);
        return response.end();
      }
      if (url.pathname === '/api/auth/session') {
        const user = getAuthorizedSession(token, timestamp);
        if (token && !user) response.setHeader('Set-Cookie', cookie(SESSION, '', 0));
        return json(response, 200, user ? { authenticated: true, providers, user, csrfToken: csrf(token), siteAccess: siteAccess(user, timestamp),
          ...(user.provider === 'kakao' ? { registration: store.signup.state(user.id) } : {}) } : { authenticated: false, providers, siteAccess: siteAccess(null, timestamp) });
      }
      if (url.pathname === '/api/auth/logout' || url.pathname === '/api/auth/account') {
        if (request.headers.origin !== config.origin || !token || !equal(request.headers['x-csrf-token'], csrf(token)) || !getAuthorizedSession(token, timestamp)) {
          return json(response, 403, { error: 'forbidden' });
        }
        if (url.pathname === '/api/auth/account') {
          const account = store.getAccount(hash(token), timestamp);
          if (timestamp - account.authenticatedAt > 300000) return json(response, 401, { error: 'reauthentication_required' });
          if (account.provider === 'kakao') {
            if (!providers.kakao) return json(response, 503, { error: 'provider_unavailable' });
            store.beginDeletion(account, timestamp);
            await executeDeletion(account.id);
          } else {
            // 계정이 지워진 뒤에는 그 회원의 숙제표를 가려낼 근거가 없으므로, 숙제표를 지우지 못하면 계정도 남기고
            // 다시 시도하게 한다(화면은 「회원 탈퇴를 완료하지 못했어요」를 보여 준다).
            if (!forgetHomework(account.id)) return json(response, 503, { error: 'storage_unavailable' });
            store.deleteLocalAccount(account.id);
          }
          response.writeHead(204, { 'Set-Cookie': cookie(SESSION, '', 0) });
          return response.end();
        }
        store.deleteSession(hash(token));
        response.writeHead(204, { 'Set-Cookie': cookie(SESSION, '', 0) });
        return response.end();
      }
      const [, provider, action] = authRoute;
      if (!rateAllowed(request, action, timestamp)) {
        return rateLimited(response, 600);
      }
      if (!providers[provider]) return redirect(response, 'provider_unavailable');
      if (provider === 'kakao' && inbox.hasAny()) return redirect(response, 'deletion_pending');
      if (action === 'start') {
        const state = nonce();
        const verifier = nonce();
        const binding = cookies[BINDING] || nonce();
        if (!store.addTransaction({ stateHash: hash(state), provider, bindingHash: hash(binding), verifier, expiresAt: timestamp + STATE_TTL_SECONDS * 1000 }, timestamp)) {
          return rateLimited(response, STATE_TTL_SECONDS);
        }
        response.writeHead(302, { Location: authorizationUrl(provider, config, state, verifier), 'Set-Cookie': cookie(BINDING, binding, STATE_TTL_SECONDS) });
        return response.end();
      }
      const values = url.searchParams;
      const state = values.get('state');
      const code = values.get('code');
      const error = values.get('error');
      if (values.getAll('state').length !== 1 || values.getAll('code').length > 1 || values.getAll('error').length > 1 ||
          !state || !NONCE.test(state) || !cookies[BINDING] || Boolean(code) === Boolean(error) ||
          (code && (code.length > 2048 || /[\x00-\x20\x7f]/.test(code)))) return redirect(response, 'invalid_request');
      const automatic = provider === 'discord' && token
        ? store.ownership.consumeDiscord(hash(state), hash(cookies[BINDING]), hash(token), timestamp) : null;
      if (automatic) {
        if (!config.automaticApproval.enabled) return redirect(response, 'automatic_unavailable');
        if (!getAuthorizedSession(token, timestamp) || getAuthorizedSession(token, timestamp).id !== automatic.userId) return redirect(response, 'automatic_state_changed');
        if (error) return redirect(response, error === 'access_denied' ? 'automatic_cancelled' : 'automatic_unavailable');
        try {
          await runOwnershipWork(automatic.userId, response, async signal => {
            const scopedFetch = (url, init) => {
              signal.throwIfAborted();
              return fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal });
            };
            await verifyAutomaticMembership(config, automatic, code, scopedFetch);
            if (signal.aborted) throw new GuildError(502, 'verification_unavailable');
            if (getAuthorizedSession(token, now())?.id !== automatic.userId) throw new GuildError(401, 'login_required');
            store.ownership.finishDiscord(automatic, now());
          });
        } catch (failure) { return redirect(response, failure instanceof GuildError ? failure.code : 'automatic_unavailable'); }
        response.writeHead(303, { Location: '/account.html?ownership=verified' });
        return response.end();
      }
      const transaction = store.consumeTransaction(hash(state), provider, hash(cookies[BINDING]), timestamp);
      if (!transaction) return redirect(response, 'invalid_request');
      if (error) return redirect(response, error === 'access_denied' ? 'access_denied' : 'provider_error');
      let identity;
      try { identity = await exchangeIdentity(provider, config, code, transaction.verifier, fetchImpl); }
      catch { return redirect(response, 'provider_error'); }
      if (provider === 'kakao' && inbox.has(identity.providerId)) return redirect(response, 'deletion_pending');
      const newToken = nonce();
      const completedAt = now();
      const sessionError = store.createSession({ ...identity, tokenHash: hash(newToken), oldTokenHash: token && hash(token), expiresAt: completedAt + SESSION_SECONDS * 1000, epoch: transaction.epoch }, completedAt);
      if (sessionError) return redirect(response, sessionError);
      response.setHeader('Set-Cookie', cookie(SESSION, newToken, SESSION_SECONDS));
      return redirect(response);
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      response.setHeader('Connection', 'close');
      if (error instanceof RequestError || error instanceof GuildError) {
        if (['character_rate_limited', 'efficiency_rate_limited'].includes(error.code)) response.setHeader('Retry-After', '60');
        return json(response, error.status, { error: error.code });
      }
      if (isAuthRoute) return redirect(response, 'server_error');
      return json(response, 503, { error: 'storage_unavailable' });
    }
  });
  server.on('clientError', (error, socket) => {
    if (!socket.writable) return;
    const status = error.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  return {
    server,
    close() {
      if (closing) return closing;
      clearInterval(timer);
      characterSpecs.close();
      characterEfficiency.close();
      braceletValue.close();
      characterValuation.close();
      rosterValues?.close();
      valuationPrices.close();
      valuationCurrency.close();
      lounge.close();
      market.close();
      honing.close();
      goldHistory.close();
      memberRosters.close();
      for (const controller of ownershipWork.values()) controller.abort();
      closing = new Promise((resolve, reject) => {
        const finish = (error) => {
          try { characterSnapshots?.close(); } catch { error ||= new Error('Snapshot storage close failed'); }
          try { braceletValueRecords?.close(); } catch { error ||= new Error('Bracelet value record storage close failed'); }
          try { scoreRecords?.close(); } catch { error ||= new Error('Score record storage close failed'); }
          try { rosterValueRecords?.close(); } catch { error ||= new Error('Roster value record storage close failed'); }
          try { rosterRecords?.close(); } catch { error ||= new Error('Roster record storage close failed'); }
          try { homework?.close(); } catch { error ||= new Error('Homework storage close failed'); }
          try { store.close(); } catch { error ||= new Error('Storage close failed'); }
          error ? reject(error) : resolve();
        };
        const drain = (error) => { void Promise.allSettled([...deletions.values(), ...(retries ? [retries] : [])]).then(() => finish(error)); };
        if (server.listening) server.close(drain);
        else drain();
      });
      return closing;
    },
  };
}
