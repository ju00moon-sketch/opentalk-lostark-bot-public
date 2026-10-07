// 홈페이지 길드 화면에 띄우는 카카오톡 출석 현황(README.md).
// 출석 기록은 봇만 가진 attendance.json에 있고 웹 서비스는 다른 계정으로 돌아 그 파일을 읽을 수 없어서,
// 같은 기기의 웹 서비스가 루프백으로 이 경로를 읽어 간다. 공개 주소로는 넘기지 않는 경로이며 루프백 주소와
// 공유 토큰이 모두 맞아야 답한다. 공개할 방은 KAKAO_ATTENDANCE_ROOM 하나로 고정해, 토큰이 있어도 다른 방이나
// 일대일 대화 기록은 읽히지 않는다. 내보내는 값은 이름·포인트·횟수·오늘 여부뿐이고 카카오 사용자 키는 빼둔다.
import { timingSafeEqual } from 'node:crypto';
import { readRoomAttendance } from './attendance.js';

export const ATTENDANCE_SITE_PATH = '/internal/site/attendance';
export const ATTENDANCE_SITE_LIMIT = 200;
const NAME_LIMIT = 64;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const isLoopbackAddress = (address) => typeof address === 'string' && LOOPBACK.has(address);

// 설정한 토큰과 보내온 토큰이 같은 바이트일 때만 통과한다. 토큰을 두지 않았으면 무엇도 통과하지 않는다.
export function siteTokenMatches(configured, presented) {
  if (typeof configured !== 'string' || configured.length < 32 || typeof presented !== 'string') return false;
  const expected = Buffer.from(configured), actual = Buffer.from(presented);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// status: ok(기록 있음) · empty(그 방 기록 없음) · disabled(공개할 방을 정하지 않음).
// members는 순위 앞 ATTENDANCE_SITE_LIMIT명까지만 보내고, memberCount·todayCount는 자르기 전 전체 기준이다.
export function siteAttendanceBoard({ room, now = Date.now, storePath } = {}) {
  const name = typeof room === 'string' ? room.trim() : '';
  if (!name) return { status: 'disabled', room: null, month: null, date: null, todayCount: 0, memberCount: 0, members: [] };
  const board = readRoomAttendance(name, { now, ...(storePath === undefined ? {} : { storePath }) });
  if (!board) return { status: 'empty', room: name, month: null, date: null, todayCount: 0, memberCount: 0, members: [] };
  const members = board.members.slice(0, ATTENDANCE_SITE_LIMIT).map((entry, index) => ({
    rank: index + 1, name: entry.name.slice(0, NAME_LIMIT), points: entry.points, count: entry.count,
    attendedToday: entry.attendedToday, last: entry.last,
  }));
  return { status: members.length ? 'ok' : 'empty', room: name, month: board.date.slice(0, 7), date: board.date,
    todayCount: board.todayCount, memberCount: board.members.length, members };
}
