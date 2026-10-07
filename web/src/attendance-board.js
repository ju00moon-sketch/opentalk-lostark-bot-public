// 길드 화면의 카카오톡 출석 현황(README.md).
// 출석 기록은 봇만 가진 attendance.json에 있고 웹 서비스 계정은 그 파일을 읽을 수 없어, 같은 기기의 봇 서버에서
// 루프백으로 받아 짧게 캐시해 보여 준다. 홈페이지에 사본을 저장하지 않으므로 지울 기록이 따로 생기지 않는다.
// 봇이 잠시 답하지 않으면 마지막으로 받은 판을 stale로 표시해 그대로 보여 주고, 처음부터 못 받았으면 비워 둔다.
export const GUILD_ATTENDANCE_PATH = '/api/auth/guild/attendance';
const BOT_PATH = '/internal/site/attendance';
const STATUSES = ['ok', 'empty', 'disabled'];
const MEMBER_LIMIT = 200;
const NAME_LIMIT = 64;
const MONTH = /^\d{4}-\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const counted = value => (Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : null);
const text = (value, limit) => (typeof value === 'string' && value.trim() && value.length <= limit ? value.trim() : null);

// 봇이 준 판을 화면이 그대로 쓸 수 있는 모양으로만 받아들인다. 한 줄이라도 어긋나면 판 전체를 버린다.
export function normalizeAttendanceBoard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !STATUSES.includes(value.status)) return null;
  const room = value.room === null ? null : text(value.room, NAME_LIMIT);
  const month = value.month === null ? null : (MONTH.test(value.month) ? value.month : undefined);
  const date = value.date === null ? null : (DAY.test(value.date) ? value.date : undefined);
  const todayCount = counted(value.todayCount);
  if (month === undefined || date === undefined || todayCount === null || !Array.isArray(value.members) ||
    value.members.length > MEMBER_LIMIT || (value.status === 'ok' && (!room || !month || !date || !value.members.length))) return null;
  const members = [];
  for (const [index, entry] of value.members.entries()) {
    const name = text(entry?.name, NAME_LIMIT);
    const points = counted(entry?.points), count = counted(entry?.count);
    if (!name || points === null || count === null || entry.rank !== index + 1 ||
      typeof entry.attendedToday !== 'boolean' || !(entry.last === null || DAY.test(entry.last))) return null;
    members.push({ rank: entry.rank, name, points, count, attendedToday: entry.attendedToday, last: entry.last ?? null });
  }
  // 봇은 순위 앞 200명까지만 보내고 memberCount·todayCount는 자르기 전 전체로 센다. memberCount가 없는 예전 봇은
  // 줄을 자르지 않았으므로 받은 줄 수로 본다(배포 순서상 새 웹이 예전 봇 응답을 잠깐 받을 수 있다).
  const memberCount = value.memberCount === undefined ? members.length : counted(value.memberCount);
  if (memberCount === null || memberCount < members.length || todayCount > memberCount) return null;
  return { status: value.status, room, month, date, todayCount, memberCount, members };
}

export function createAttendanceBoardService({ fetchImpl = fetch, base = process.env.BOT_INTERNAL_URL || 'http://127.0.0.1:8080',
  token = null, now = Date.now, cacheMs = 30_000, timeoutMs = 4000 } = {}) {
  let cached = null;
  let pending = null;
  const answer = (board, checkedAt, stale) => ({ ...board, checkedAt, stale });
  const closed = { status: 'unavailable', room: null, month: null, date: null, todayCount: 0, memberCount: 0, members: [] };

  async function load() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL(BOT_PATH, base), {
        headers: { 'X-Bot-Token': token, Accept: 'application/json' }, signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) return null;
      return normalizeAttendanceBoard(await response.json());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async read() {
      // 토큰을 공유하지 않은 환경에서는 봇에 묻지 않고 바로 비워 둔 판을 준다.
      if (typeof token !== 'string' || token.length < 32) return { ...closed, checkedAt: null, stale: false };
      const at = now();
      if (cached && at - cached.checkedAt < cacheMs) return answer(cached.board, cached.checkedAt, false);
      pending ??= load().finally(() => { pending = null; });
      const board = await pending;
      if (board) {
        cached = { board, checkedAt: now() };
        return answer(board, cached.checkedAt, false);
      }
      // 마지막으로 받은 판이 있으면 갱신 시각과 함께 그대로 보여 주고, 없으면 조회 불가로 남긴다.
      return cached ? answer(cached.board, cached.checkedAt, true) : { ...closed, checkedAt: null, stale: false };
    },
  };
}
