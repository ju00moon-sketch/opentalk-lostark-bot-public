(() => {
  'use strict';
  // 길드 화면의 카카오톡 출석 현황. 서버가 준 판만 그리고, 판이 없거나 모양이 어긋나면 카드를 숨긴다.
  const node = (tag, text, className = '') => {
    const element = document.createElement(tag);
    element.textContent = text;
    element.className = className;
    return element;
  };
  const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
  const MONTH = /^(\d{4})-(\d{2})$/;
  const counted = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const dayLabel = value => { const parts = DAY.exec(value || ''); return parts ? `${Number(parts[2])}월 ${Number(parts[3])}일` : ''; };
  const monthLabel = value => { const parts = MONTH.exec(value || ''); return parts ? `${parts[1]}년 ${Number(parts[2])}월` : ''; };
  const time = value => {
    if (!Number.isSafeInteger(value)) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('ko-KR', {month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul'}).format(date);
  };

  // 그릴 수 있는 판이면 화면용 값으로, 아니면 null.
  // 명단은 순위 앞 200명까지만 오고 memberCount(전체 인원)·todayCount는 자르기 전 기준이다. memberCount가 없으면 받은 줄 수로 본다.
  function summarize(data) {
    const memberCount = data && Array.isArray(data.members) ? (data.memberCount === undefined ? data.members.length : counted(data.memberCount)) : null;
    if (!data || typeof data !== 'object' || !['ok', 'empty'].includes(data.status) || !Array.isArray(data.members) ||
      memberCount === null || memberCount < data.members.length ||
      counted(data.todayCount) === null || data.todayCount > memberCount ||
      (data.room !== null && typeof data.room !== 'string') || (data.month !== null && !MONTH.test(data.month)) ||
      (data.date !== null && !DAY.test(data.date)) || typeof data.stale !== 'boolean') return null;
    const members = [];
    for (const [index, entry] of data.members.entries()) {
      if (!entry || typeof entry.name !== 'string' || !entry.name || entry.rank !== index + 1 ||
        counted(entry.points) === null || counted(entry.count) === null || typeof entry.attendedToday !== 'boolean') return null;
      members.push({rank: entry.rank, name: entry.name, points: entry.points, count: entry.count, attendedToday: entry.attendedToday});
    }
    return {
      room: data.room || '', month: monthLabel(data.month), day: dayLabel(data.date),
      todayCount: data.todayCount, memberCount, members, top: members.length ? members[0].points : 0,
      checkedAt: time(data.checkedAt), stale: data.stale,
    };
  }

  class Attendance {
    constructor({root}) {
      this.root = root;
    }

    clear() {
      this.root.hidden = true;
      for (const id of ['attendance-members', 'attendance-today', 'attendance-top']) document.getElementById(id).textContent = '—';
      document.getElementById('attendance-list').replaceChildren();
      for (const id of ['attendance-period', 'attendance-note']) document.getElementById(id).textContent = '';
    }

    render(data) {
      const summary = window.pogeunSiteAccess?.approved === true ? summarize(data) : null;
      if (!summary) { this.clear(); return; }
      this.root.hidden = false;
      document.getElementById('attendance-period').textContent = [summary.month, summary.day && `${summary.day} 기준`].filter(Boolean).join(' · ');
      for (const [id, value] of [['attendance-members', summary.memberCount], ['attendance-today', summary.todayCount], ['attendance-top', summary.top]]) {
        document.getElementById(id).textContent = value.toLocaleString('ko-KR');
      }
      const list = document.getElementById('attendance-list');
      list.replaceChildren();
      for (const member of summary.members) {
        const row = node('li', '', `attendance-row${member.attendedToday ? ' attended' : ''}`);
        row.append(node('span', String(member.rank), `attendance-rank${member.rank <= 3 ? ' top' : ''}`), node('span', member.name, 'attendance-name'),
          node('span', `${member.points.toLocaleString('ko-KR')}P`, 'attendance-score'), node('span', `${member.count.toLocaleString('ko-KR')}회`, 'attendance-count'),
          node('span', member.attendedToday ? '오늘 출석' : '', 'attendance-mark'));
        list.append(row);
      }
      if (!summary.members.length) list.append(node('li', '아직 이번 달 출석 기록이 없어요. 카카오톡 방에서 ㅊㅊ를 보내면 이 자리에 순위가 생겨요.', 'dashboard-empty attendance-empty'));
      document.getElementById('attendance-note').textContent = [
        summary.room ? `카카오톡 ${summary.room} 방 기준` : '카카오톡 방 기준',
        '방에서 ㅊㅊ를 보내면 하루 한 번 1~3P가 쌓이고 매월 1일 새로 시작해요',
        summary.memberCount > summary.members.length && `순위는 ${summary.members.length.toLocaleString('ko-KR')}위까지만 보여요`,
        summary.checkedAt && `${summary.stale ? '마지막 확인' : '확인'} ${summary.checkedAt}`,
        summary.stale && '방금은 새로 확인하지 못해 이전 기록을 보여 주고 있어요',
      ].filter(Boolean).join(' · ');
    }
  }
  window.PogeunGuildAttendance = {Attendance, summarize};
})();
