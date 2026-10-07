// 출석 체크 저장소 — 방마다 하루(한국 시간 자정 기준) 한 번 1~3P를 무작위로 주고 누적한다.
// user-links.json과 같은 방식으로 루트 attendance.json에 저장해 배포(src/ 교체)에도 유지된다.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSync, closeSync, unlinkSync } from 'node:fs';
import { readJson, writeJsonAtomic, CorruptStoreError } from './json-store.js';
import { checkIn as checkInV2, getAttendanceStatus as getAttendanceStatusV2 } from './attendance-v2.js';

const STORE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'attendance.json');
const KST_OFFSET = 9 * 60 * 60 * 1000;
export const POINT_MIN = 1;
export const POINT_MAX = 3;

// epoch ms → 한국 시간 날짜 'YYYY-MM-DD'
export const kstDate = (ms) => new Date(ms + KST_OFFSET).toISOString().slice(0, 10);

// 1·2·3을 같은 확률로. random은 [0, 1) 값을 주는 함수(테스트에서 주입).
export const rollPoints = (random = Math.random) => POINT_MIN + Math.floor(random() * (POINT_MAX - POINT_MIN + 1));

// v2: 방별 사용자 기록과, 방을 알 수 없는 기존 공통 기록을 함께 보관한다.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isEntry = (entry) => isObject(entry) && isCount(entry.points) && isCount(entry.count)
  && (entry.last === null || (typeof entry.last === 'string' && DATE_RE.test(entry.last)));
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
// 한국 시간 연월로 나눈다. 월초에 봇이 꺼져 있어도 다음 조회/출석부터 새 달로 계산한다.
const isThisMonth = (entry, date) => entry.last?.slice(0, 7) === date.slice(0, 7);
// 이번 달 기록만 남기고 포인트 → 횟수 → 이름 → 저장 키 순으로 세운다. 세 조회 경로가 같은 순위를 쓴다.
const monthlyRanking = (entries, date) => entries
  .filter(([, entry]) => isThisMonth(entry, date))
  .map(([userId, entry]) => ({ userId, ...entry, attendedToday: entry.last === date }))
  .sort((a, b) => b.points - a.points || b.count - a.count
    || a.name.localeCompare(b.name, 'ko') || a.userId.localeCompare(b.userId, 'ko'));

function validateEntries(entries, storePath, withNames = false) {
  if (!isObject(entries)) throw new CorruptStoreError(storePath, new Error('사용자 기록이 객체가 아님'));
  for (const entry of Object.values(entries)) {
    if (!isEntry(entry) || (withNames && (typeof entry.name !== 'string' || !entry.name.trim()))) {
      throw new CorruptStoreError(storePath, new Error('출석 항목 형식 오류'));
    }
  }
}

export class AttendanceIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AttendanceIdentityError';
    this.code = code;
  }
}

const SOURCE = 'android-person-key-v1';
const ROOM_SOURCE = 'android-conversation-shortcut-v1';
const opaque = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512
  && /\S/u.test(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const identityKey = (source, value) => JSON.stringify([source, value]);
function validStoredKey(key) {
  try {
    const parts = JSON.parse(key);
    return Array.isArray(parts) && parts.length === 2 && parts[0] === SOURCE
      && opaque(parts[1]) && identityKey(...parts) === key;
  } catch { return false; }
}

export function validateAttendanceIdentity(identity) {
  if (!isObject(identity) || identity.source !== SOURCE || !opaque(identity.roomId) || !opaque(identity.userId)) {
    throw new AttendanceIdentityError('IDENTITY_REQUIRED', '안정된 방과 사용자 식별자가 필요해요');
  }
  return { roomKey: identityKey(identity.source, identity.roomId), memberKey: identityKey(identity.source, identity.userId) };
}

export function validateAttendanceRoomIdentity(identity) {
  if (!isObject(identity) || identity.source !== ROOM_SOURCE || !opaque(identity.roomId)) {
    throw new AttendanceIdentityError('ROOM_IDENTITY_REQUIRED', '안정된 방 식별자가 필요해요');
  }
  return { roomKey: identityKey(identity.source, identity.roomId) };
}

function validStoredRoomKey(key) {
  try {
    const parts = JSON.parse(key);
    return Array.isArray(parts) && parts.length === 2
      && validateAttendanceRoomIdentity({ source: parts[0], roomId: parts[1] }).roomKey === key;
  } catch { return false; }
}

// 모든 출석 쓰기와 수동 연결 적용이 같은 잠금을 사용한다. 남은 잠금은 자동 삭제하지 않는다.
export function withAttendanceStoreLock(storePath, action) {
  const lock = `${storePath}.identity-lock`;
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw new AttendanceIdentityError('MIGRATION_IN_PROGRESS', '출석 기록을 변경 중이에요. 잠시 후 다시 시도해주세요');
    throw error;
  }
  try { return action(); } finally { closeSync(fd); unlinkSync(lock); }
}

export function normalizeAttendanceStore(store, storePath = 'attendance.json') {
  if (!isObject(store)) throw new CorruptStoreError(storePath, new Error('루트가 객체가 아님'));
  if (![2, 3, 4].includes(store.version)) {
    // 기존 기록에는 방 정보가 없다. 조회만으로 파일을 바꾸거나 어느 방에 적립하지 않는다.
    validateEntries(store, storePath);
    return { version: 2, rooms: {}, legacy: store };
  }
  const fields = ['version', 'rooms', 'legacy', ...(store.version === 3 ? ['stableRooms'] : store.version === 4 ? ['roomBindings'] : [])];
  if (!isObject(store.rooms) || !isObject(store.legacy)
    || Object.keys(store).some((key) => !fields.includes(key))) {
    throw new CorruptStoreError(storePath, new Error('방별 저장 구조 오류'));
  }
  validateEntries(store.legacy, storePath);
  for (const entries of Object.values(store.rooms)) validateEntries(entries, storePath, true);
  if (store.version === 2) return store;
  if (store.version === 4) {
    if (!isObject(store.roomBindings)) throw new CorruptStoreError(storePath, new Error('안정 방 연결 구조 오류'));
    const boundRooms = new Set();
    for (const [key, storageRoom] of Object.entries(store.roomBindings)) {
      if (!validStoredRoomKey(key) || typeof storageRoom !== 'string' || !storageRoom.trim()
        || !Object.hasOwn(store.rooms, storageRoom) || boundRooms.has(storageRoom)) {
        throw new CorruptStoreError(storePath, new Error('안정 방 연결 항목 오류'));
      }
      boundRooms.add(storageRoom);
    }
    return store;
  }
  if (!isObject(store.stableRooms)) throw new CorruptStoreError(storePath, new Error('안정 방 저장 구조 오류'));
  const linkedRooms = new Set();
  for (const [key, room] of Object.entries(store.stableRooms)) {
    if (!validStoredKey(key) || !isObject(room) || typeof room.name !== 'string' || !room.name.trim()
      || !isObject(room.links) || !(room.legacyRoom === null || typeof room.legacyRoom === 'string')
      || Object.keys(room).some((field) => !['name', 'legacyRoom', 'members', 'links'].includes(field))) {
      throw new CorruptStoreError(storePath, new Error('안정 방 항목 오류'));
    }
    validateEntries(room.members, storePath, true);
    if (Object.keys(room.members).some((member) => !validStoredKey(member))) throw new CorruptStoreError(storePath, new Error('안정 사용자 키 오류'));
    if (room.legacyRoom !== null) {
      if (!Object.hasOwn(store.rooms, room.legacyRoom) || linkedRooms.has(room.legacyRoom)) throw new CorruptStoreError(storePath, new Error('기존 방 중복 연결'));
      linkedRooms.add(room.legacyRoom);
    }
    const targets = new Set();
    for (const [oldKey, target] of Object.entries(room.links)) {
      if (room.legacyRoom === null || !Object.hasOwn(store.rooms[room.legacyRoom], oldKey)
        || typeof target !== 'string' || !Object.hasOwn(room.members, target) || targets.has(target)) {
        throw new CorruptStoreError(storePath, new Error('기존 회원 연결 오류'));
      }
      targets.add(target);
    }
  }
  return store;
}

const loadStore = (storePath) => normalizeAttendanceStore(readJson(storePath, {}), storePath);

function requireKey(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('방 이름과 사용자 식별자가 필요해요');
  return value.trim();
}

function stableRoom(store, roomName, roomKey) {
  const found = own(store.stableRooms, roomKey);
  if (found) return found;
  if (Object.keys(store.rooms).length) throw new AttendanceIdentityError('ROOM_LINK_REQUIRED', '기존 방 연결 또는 신규 방 확인이 필요해요');
  return { name: roomName, legacyRoom: null, members: {}, links: {} };
}

const unlinkedMembers = (store, room) => room.legacyRoom === null ? []
  : Object.entries(store.rooms[room.legacyRoom]).filter(([key]) => !Object.hasOwn(room.links, key));

function resolveBoundRoom(store, roomName, roomIdentity) {
  const { roomKey } = validateAttendanceRoomIdentity(roomIdentity);
  const bound = own(store.roomBindings, roomKey);
  if (bound !== undefined) return { roomKey, storageRoom: bound };
  // 제목이 같다는 이유로 기존 방에 연결하지 않는다. 새 방은 식별자를 저장 키로 사용한다.
  if (Object.hasOwn(store.rooms, roomName) || Object.hasOwn(store.rooms, roomKey)) {
    throw new AttendanceIdentityError('ROOM_LINK_REQUIRED', '기존 방 연결 또는 신규 방 확인이 필요해요');
  }
  return { roomKey, storageRoom: roomKey };
}

function checkInBoundRoom(store, userId, { roomName, name, roomIdentity, now, random, storePath }) {
  const title = requireKey(roomName);
  const id = requireKey(userId);
  const { roomKey, storageRoom } = resolveBoundRoom(store, title, roomIdentity);
  const entries = own(store.rooms, storageRoom) ?? {};
  const entry = own(entries, id) ?? { points: 0, count: 0, last: null };
  const date = kstDate(now());
  if (entry.last === date) return { status: 'already', total: entry.points, count: entry.count, date };
  const totals = isThisMonth(entry, date) ? entry : { points: 0, count: 0 };
  const gained = rollPoints(random);
  const next = {
    name: typeof name === 'string' && name.trim() ? name.trim() : entry.name ?? id.replace(/^kakao:oc:/, ''),
    points: totals.points + gained, count: totals.count + 1, last: date,
  };
  if (!isEntry(next)) throw new RangeError('출석 포인트 또는 횟수의 저장 범위를 넘었어요');
  store.rooms = { ...store.rooms, [storageRoom]: { ...entries, [id]: next } };
  store.roomBindings = { ...store.roomBindings, [roomKey]: storageRoom };
  writeJsonAtomic(storePath, store);
  return { status: 'done', gained, total: next.points, count: next.count, date };
}

export function checkIn(userId, { roomName, name, identity, roomIdentity, now = Date.now, random = Math.random, storePath = STORE_PATH } = {}) {
  return withAttendanceStoreLock(storePath, () => {
    const store = loadStore(storePath);
    // 기존 저장소는 명시적 이관 전까지 같은 읽기·쓰기 계약을 유지한다.
    if (store.version === 2) return checkInV2(userId, { roomName, name, now, random, storePath });
    if (store.version === 4) return checkInBoundRoom(store, userId, { roomName, name, roomIdentity, now, random, storePath });
    const { roomKey, memberKey } = validateAttendanceIdentity(identity);
    const title = requireKey(roomName);
    const room = stableRoom(store, title, roomKey);
    const existing = own(room.members, memberKey);
    if (!existing && unlinkedMembers(store, room).length) throw new AttendanceIdentityError('MEMBER_LINK_REQUIRED', '기존 회원 기록 연결 또는 신규 회원 확인이 필요해요');
    const date = kstDate(now());
    const entry = existing ?? { points: 0, count: 0, last: null };
    const displayName = typeof name === 'string' && name.trim() ? name.trim() : entry.name ?? requireKey(userId).replace(/^kakao:oc:/, '');
    const save = (next) => {
      store.stableRooms = { ...store.stableRooms, [roomKey]: { ...room, name: title, members: { ...room.members, [memberKey]: next } } };
      writeJsonAtomic(storePath, store);
    };
    if (entry.last === date) {
      if (entry.name !== displayName || room.name !== title) save({ ...entry, name: displayName });
      return { status: 'already', total: entry.points, count: entry.count, date };
    }
    const totals = isThisMonth(entry, date) ? entry : { points: 0, count: 0 };
    const gained = rollPoints(random);
    const next = {
      name: displayName,
      points: totals.points + gained, count: totals.count + 1, last: date,
    };
    if (!isEntry(next)) throw new RangeError('출석 포인트 또는 횟수의 저장 범위를 넘었어요');
    // 계산된 속성은 __proto__ 같은 방/사용자 이름도 일반 키로 저장한다.
    save(next);
    return { status: 'done', gained, total: next.points, count: next.count, date };
  });
}

// 이번 달 출석 기록이 있는 참여자만 조회한다. 파일 생성이나 변환 저장은 하지 않는다.
export function getAttendanceStatus(roomName, options = {}) {
  const { now = Date.now, storePath = STORE_PATH } = options;
  const room = requireKey(roomName);
  const store = loadStore(storePath);
  if (store.version === 2) return getAttendanceStatusV2(roomName, { now, storePath });
  const date = kstDate(now());
  if (store.version === 4) {
    const { storageRoom } = resolveBoundRoom(store, room, options.roomIdentity);
    const members = monthlyRanking(Object.entries(own(store.rooms, storageRoom) ?? {}), date);
    return { roomName: room, date, todayCount: members.filter((entry) => entry.attendedToday).length, members };
  }
  const { roomKey } = validateAttendanceIdentity(options.identity);
  const stable = stableRoom(store, room, roomKey);
  const members = monthlyRanking([...Object.entries(stable.members), ...unlinkedMembers(store, stable)], date);
  return { roomName: room, date, todayCount: members.filter((entry) => entry.attendedToday).length, members };
}

// 저장 키로 한 방의 이번 달 현황만 읽는다(홈페이지 길드 화면용). 방 식별자·사용자 식별자를 요구하지 않고
// 조회만 하므로 파일을 만들거나 바꾸지 않으며, 그 키의 기록이 없으면 null을 준다.
export function readRoomAttendance(storageRoom, { now = Date.now, storePath = STORE_PATH } = {}) {
  const key = requireKey(storageRoom);
  const store = loadStore(storePath);
  const date = kstDate(now());
  let entries;
  if (store.version === 3) {
    // 사용자 식별 저장소에서는 옮겨 둔 회원과 아직 연결되지 않은 기존 회원을 함께 센다.
    const stable = Object.values(store.stableRooms).find((room) => room.legacyRoom === key || room.name === key);
    entries = stable ? [...Object.entries(stable.members), ...unlinkedMembers(store, stable)] : null;
  } else {
    const room = own(store.rooms, key);
    entries = room === undefined ? null : Object.entries(room);
  }
  if (entries === null) return null;
  const members = monthlyRanking(entries, date);
  return { roomName: key, date, todayCount: members.filter((entry) => entry.attendedToday).length, members };
}

// 명시적으로 확인한 일대일 연결만 만든다. 기존 rooms와 legacy는 변경하지 않는다.
export function buildAttendanceIdentityMigration(input, mapping) {
  const conflict = (message) => { throw new AttendanceIdentityError('IDENTITY_CONFLICT', message); };
  if (!isObject(mapping) || !Array.isArray(mapping.links) || !Array.isArray(mapping.enroll)
    || !(mapping.legacyRoom === null || typeof mapping.legacyRoom === 'string')
    || Object.keys(mapping).some((key) => !['expectedSha256', 'source', 'roomId', 'roomName', 'legacyRoom', 'links', 'enroll'].includes(key))) conflict('연결 계획 형식이 올바르지 않아요');
  const { roomKey } = validateAttendanceIdentity({ ...mapping, userId: 'mapping-validation' });
  const title = requireKey(mapping.roomName);
  const normalized = normalizeAttendanceStore(structuredClone(input));
  if (normalized.version === 4) conflict('방 식별 저장소는 사용자 식별 이관을 지원하지 않아요');
  // 저장 형식 승격은 원본과 연결 계획을 확인하는 이 경로에서만 허용한다.
  const store = normalized.version === 2 ? { ...normalized, version: 3, stableRooms: {} } : normalized;
  let room = own(store.stableRooms, roomKey);
  if (mapping.legacyRoom === null && Object.hasOwn(store.rooms, title)) conflict('기존 제목의 방은 원본 방 연결이 필요해요');
  if (room && room.legacyRoom !== mapping.legacyRoom) conflict('이미 다른 기존 방에 연결됐어요');
  if (mapping.legacyRoom !== null) {
    if (!Object.hasOwn(store.rooms, mapping.legacyRoom)) conflict('기존 방 기록이 없어요');
    if (Object.entries(store.stableRooms).some(([key, value]) => key !== roomKey && value.legacyRoom === mapping.legacyRoom)) conflict('기존 방이 이미 연결됐어요');
  }
  room = room ?? { name: title, legacyRoom: mapping.legacyRoom, members: {}, links: {} };
  room.name = title;
  for (const link of mapping.links) {
    if (!isObject(link) || typeof link.legacyUserId !== 'string' || mapping.legacyRoom === null
      || Object.keys(link).some((key) => !['legacyUserId', 'userId', 'expected'].includes(key))) conflict('연결할 원본 회원이 필요해요');
    const original = own(store.rooms[mapping.legacyRoom], link.legacyUserId);
    const expected = link.expected;
    if (!original || !isObject(expected) || Object.keys(original).length !== Object.keys(expected).length
      || Object.keys(original).some((key) => original[key] !== expected[key] || !Object.hasOwn(expected, key))) conflict('기존 회원 필드가 계획과 달라요');
    const { memberKey } = validateAttendanceIdentity({ ...mapping, userId: link.userId });
    if (Object.hasOwn(room.links, link.legacyUserId) || Object.hasOwn(room.members, memberKey)) conflict('원본 또는 대상 회원이 이미 연결됐어요');
    room.links = { ...room.links, [link.legacyUserId]: memberKey };
    room.members = { ...room.members, [memberKey]: { ...original } };
  }
  for (const enrollment of mapping.enroll) {
    if (!isObject(enrollment) || Object.keys(enrollment).some((key) => !['userId', 'name'].includes(key))) conflict('신규 회원 형식이 올바르지 않아요');
    const { memberKey } = validateAttendanceIdentity({ ...mapping, userId: enrollment.userId });
    if (Object.hasOwn(room.members, memberKey)) conflict('대상 회원이 이미 등록됐어요');
    const name = requireKey(enrollment.name);
    room.members = { ...room.members, [memberKey]: { name, points: 0, count: 0, last: null } };
  }
  store.stableRooms = { ...store.stableRooms, [roomKey]: room };
  return normalizeAttendanceStore(store);
}

// 운영자가 확인한 방만 연결한다. 회원 키·포인트와 기존 방 기록은 그대로 보존한다.
export function buildAttendanceRoomMigration(input, mapping) {
  const conflict = (message) => { throw new AttendanceIdentityError('IDENTITY_CONFLICT', message); };
  if (!isObject(mapping) || Object.keys(mapping).some((key) => !['source', 'roomId', 'storageRoom'].includes(key))
    || typeof mapping.storageRoom !== 'string' || !mapping.storageRoom.trim()) conflict('방 연결 계획 형식이 올바르지 않아요');
  const { roomKey } = validateAttendanceRoomIdentity(mapping);
  const normalized = normalizeAttendanceStore(structuredClone(input));
  if (normalized.version === 3) conflict('사용자 식별 저장소는 방 식별 이관을 지원하지 않아요');
  const store = normalized.version === 2 ? { ...normalized, version: 4, roomBindings: {} } : normalized;
  if (!Object.hasOwn(store.rooms, mapping.storageRoom)) conflict('연결할 기존 방 기록이 없어요');
  const existing = own(store.roomBindings, roomKey);
  if (existing !== undefined && existing !== mapping.storageRoom) conflict('이미 다른 기존 방에 연결됐어요');
  if (Object.entries(store.roomBindings).some(([key, target]) => key !== roomKey && target === mapping.storageRoom)) {
    conflict('기존 방이 이미 연결됐어요');
  }
  store.roomBindings = { ...store.roomBindings, [roomKey]: mapping.storageRoom };
  return normalizeAttendanceStore(store);
}
