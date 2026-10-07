(() => {
  'use strict';
  const node = (tag, text, className = '') => {
    const element = document.createElement(tag);
    element.textContent = text;
    element.className = className;
    return element;
  };
  const clean = value => String(value ?? '').normalize('NFC').trim();

  function summarize(data) {
    const groups = data?.sheet?.layout?.groups || [];
    const slots = groups.filter(group => group.kind === 'entry');
    const entries = data?.entries || {};
    const jobs = new Map();
    let filled = 0, owned = 0;
    for (const group of slots) {
      const entry = entries[group.id];
      if (!group.cells.some(field => clean(entry?.values?.[field.address]))) continue;
      filled++;
      if (entry?.owned === true) owned++;
      const field = group.cells.find(field => clean(field.label) === '직업');
      const job = clean(field && entry?.values?.[field.address]) || '직업 미입력';
      jobs.set(job, (jobs.get(job) || 0) + 1);
    }
    return {
      total: slots.length, filled, owned,
      empty: slots.length - filled,
      title: data?.sheet?.title || '',
      tabs: (data?.tabs || []).filter(tab => !tab.hidden),
      jobs: [...jobs].map(([name, count]) => ({name, count})).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ko')),
    };
  }

  class Dashboard {
    constructor({root, selectSheet}) {
      this.root = root;
      this.selectSheet = selectSheet;
    }

    clear() {
      this.root.hidden = true;
      for (const id of ['dashboard-sheet-name', 'dashboard-filled', 'dashboard-total', 'dashboard-owned']) document.getElementById(id).textContent = '—';
      for (const id of ['dashboard-sheets', 'dashboard-jobs']) document.getElementById(id).replaceChildren();
      document.getElementById('dashboard-fill-progress').value = 0;
      document.getElementById('dashboard-fill-description').textContent = '';
      document.getElementById('dashboard-job-description').textContent = '';
    }

    render(data) {
      if (window.pogeunSiteAccess?.approved !== true) { this.clear(); return; }
      const summary = summarize(data);
      this.root.hidden = false;
      document.getElementById('dashboard-sheet-name').textContent = summary.title || '일정표 선택';
      for (const [id, count] of [['dashboard-filled', summary.filled], ['dashboard-total', summary.total], ['dashboard-owned', summary.owned]]) document.getElementById(id).textContent = count.toLocaleString('ko-KR');
      const progress = document.getElementById('dashboard-fill-progress');
      progress.max = Math.max(1, summary.total);
      progress.value = summary.filled;
      document.getElementById('dashboard-fill-description').textContent = summary.total ? `현재 시트 ${summary.total}칸 중 ${summary.filled}칸 입력 · 빈칸 ${summary.empty}개` : '이 시트에는 참여 입력칸이 없습니다.';
      const tabs = document.getElementById('dashboard-sheets');
      tabs.replaceChildren();
      for (const tab of summary.tabs) {
        const button = node('button', '', 'dashboard-sheet');
        button.type = 'button';
        button.setAttribute('aria-pressed', String(tab.id === data?.sheet?.id));
        button.append(node('span', tab.title), node('span', tab.id === data?.sheet?.id ? '선택됨' : '일정 보기', 'dashboard-sheet-action'));
        button.addEventListener('click', () => this.selectSheet(tab.id));
        tabs.append(button);
      }
      if (!summary.tabs.length) tabs.append(node('p', '등록된 일정표가 없습니다.', 'dashboard-empty'));
      const jobs = document.getElementById('dashboard-jobs');
      jobs.replaceChildren();
      for (const job of summary.jobs) {
        const row = node('div', '', 'dashboard-job');
        const label = node('div', '', 'dashboard-job-label');
        label.append(node('span', job.name), node('span', `${job.count}건`));
        const bar = document.createElement('progress');
        bar.max = Math.max(1, summary.filled);
        bar.value = job.count;
        bar.setAttribute('aria-label', `${job.name} 입력 ${job.count}건`);
        row.append(label, bar);
        jobs.append(row);
      }
      if (!summary.jobs.length) jobs.append(node('p', '참여 입력이 생기면 직업별 현황을 확인할 수 있습니다.', 'dashboard-empty'));
      document.getElementById('dashboard-job-description').textContent = '현재 시트의 입력 건수 기준입니다. 같은 캐릭터의 중복 입력도 각각 셉니다.';
    }
  }
  window.PogeunGuildDashboard = {Dashboard, summarize};
})();
