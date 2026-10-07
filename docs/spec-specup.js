(function () {
  'use strict';
  // 캐릭터 화면 스펙업 탭. 계산은 봇이 하고(설계 README.md) 여기서는 그린다.
  // 한 번 계산이 10~30초라 서버가 기다리지 않고 running을 주므로, 탭이 열려 있는 동안만 다시 물어본다.
  const POLL_MS = 2500;
  const POLL_MAX = 60;          // 2.5초 × 60 = 2분 반. 그 뒤에는 스스로 멈추고 다시 계산 단추를 남긴다.
  const PREVIEW_ROWS = 10;

  const node = (tag, className, text) => {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined && text !== null) result.textContent = String(text);
    return result;
  };
  const fixed1 = n => n.toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fixed2 = n => n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const gold = n => `${Math.round(n).toLocaleString('ko-KR')} G`;
  const signed = n => `${n < 0 ? '−' : '+'}${fixed2(Math.abs(n))}%`;
  const clock = ms => new Date(ms).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
  const monthDay = ms => {
    const date = new Date(ms + 9 * 3600 * 1000);
    return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
  };

  // 한 줄을 「무엇을」과 「어떻게」로 나눈다. 보석 행은 코어가 준 변경 내용이 본문보다 읽기 쉽고,
  // 나머지는 첫 ' · ' 앞을 제목으로 둔다. 형식이 다르면 나누지 않고 원문을 그대로 제목에 둔다.
  function rowParts(row) {
    if (row.gem) return { title: row.gem.skill, detail: `${row.gem.type === '피해' ? '겁화' : '작열'} ${row.gem.from} → ${row.gem.to}레벨` };
    const at = row.option.indexOf(' · ');
    return at < 0 ? { title: row.option, detail: '' } : { title: row.option.slice(0, at), detail: row.option.slice(at + 3) };
  }
  const rowTitle = row => rowParts(row).title;
  const level = value => (typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null);

  window.PogeunSpecup = { create({ getContext, onUnauthorized }) {
    const root = document.getElementById('spec-specup');
    let controller = null, serial = 0, last = null, busy = false, message = '', expanded = false, polls = 0;
    const current = () => getContext();

    function reset() {
      serial += 1; controller?.abort(); controller = null;
      last = null; busy = false; message = ''; expanded = false; polls = 0;
      render();
    }

    function footerNotes(answer) {
      const { guide, crystal } = answer;
      const notes = [];
      const gems = guide.rows.filter(row => row.kind === '보석');
      const modeled = gems.some(row => row.gainSource === 'model');
      notes.push(`딜 상승률은 로펙 점수 비율${modeled ? ', 보석은 스킬 딜 비중 기준' : ''}`);
      if (gems.some(row => row.gainSource !== 'model')) notes.push(modeled ? '일부 보석은 로펙 점수 비율' : '보석은 로펙 점수 비율(딜 비중 모델 미적용)');
      // 봇 src/specup-view.js의 COOLDOWN_ASSUMPTION과 같은 문장·같은 조건(test/specup-cooldown-note.test.mjs가 대조).
      if (gems.some(row => row.gainSource === 'model' && row.gem?.type === '쿨감')) notes.push('쿨감 보석은 스킬을 쿨타임마다 쓴다고 가정');
      notes.push('비용은 거래소·경매장 실시간 시세');
      if (guide.pricedAt !== null) notes.push(`시세 기준 ${clock(guide.pricedAt)} 한국 시간`);
      if (guide.priceStale) notes.push('로펙 시세 갱신 지연');
      if (guide.rows.some(row => row.priceSource === 'lopec')) notes.push('* 로펙 시세로 계산한 행');
      if (guide.rows.some(row => row.priceSource === 'fixed')) notes.push('스톤·카르마는 로펙 고정 비용 모델');
      if (guide.crystalPrice95 === null) notes.push('페온 제외 — 크리스탈 시세를 아직 못 받았어요');
      else notes.push(`페온 포함 — 크리스탈 95개 ${gold(guide.crystalPrice95)}${crystal?.at ? ` (${monthDay(crystal.at)} ${crystal.source === 'auto' ? '자동' : '설정'})` : ''}`);
      if (guide.droppedForPrice > 0) notes.push(`비용을 확인하지 못한 후보 ${guide.droppedForPrice}개 제외`);
      notes.push(`계산 확인 ${new Date(answer.finishedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} 한국 시간`);
      return notes;
    }

    function rowTable(rows, offset) {
      const frame = node('table', 'spec-specup-table');
      const head = node('thead'), headRow = node('tr');
      for (const [label, className] of [['#', 'spec-specup-rank'], ['항목', ''], ['딜 상승', 'spec-specup-number'],
        ['예상 비용', 'spec-specup-number'], ['10만 G당', 'spec-specup-number']]) {
        const cell = node('th', className, label);
        cell.scope = 'col';
        headRow.append(cell);
      }
      head.append(headRow);
      const body = node('tbody');
      for (const [index, row] of rows.entries()) {
        const free = row.per100k === null || row.expectedCost === 0;
        const line = node('tr');
        line.append(node('td', 'spec-specup-rank', offset + index + 1));
        const what = node('td', 'spec-specup-what'), parts = rowParts(row);
        what.append(node('span', 'spec-specup-kind', row.kind), node('strong', '', parts.title));
        if (parts.detail) what.append(node('span', 'spec-specup-detail', parts.detail));
        line.append(what);
        // 좁은 화면에서는 머리글이 빠지고 이 이름표가 숫자 앞에 붙는다(spec-specup.css).
        for (const [label, className, value] of [
          ['딜 상승', 'spec-specup-gain', signed(row.gainPercent)],
          ['비용', '', `${free ? '무료' : gold(row.expectedCost)}${row.priceSource === 'lopec' ? '*' : ''}`],
          ['10만 G당', 'spec-specup-per', free ? '—' : `${fixed2(row.per100k)}%`],
        ]) {
          const cell = node('td', `spec-specup-number${className ? ` ${className}` : ''}`, value);
          cell.dataset.label = label;
          line.append(cell);
        }
        body.append(line);
      }
      frame.append(head, body);
      return frame;
    }

    function board(answer) {
      const guide = answer.guide;
      const wrap = node('div');
      if (!guide.rows.length) {
        wrap.append(node('p', 'spec-specup-status', '지금 추천할 스펙업이 없어요. 로펙 스펙업 가이드에 후보가 없습니다.'));
        return wrap;
      }
      const context = current();
      const summary = node('section', 'spec-specup-summary');
      summary.append(node('span', 'spec-specup-summary-label', '현재 로펙 점수'),
        node('strong', '', `${fixed1(guide.baseScore)}점`));
      const best = guide.rows[0], bestParts = rowParts(best);
      summary.append(node('p', 'spec-specup-summary-best',
        `지금 가장 효율이 좋은 것은 ${best.kind} ${[bestParts.title, bestParts.detail].filter(Boolean).join(' ')} — ${signed(best.gainPercent)} · ${best.expectedCost === 0 ? '무료' : gold(best.expectedCost)}`));
      const itemLevel = level(context.itemLevel);
      if (context.className || itemLevel) {
        summary.append(node('p', 'spec-specup-note', [context.className, itemLevel ? `Lv. ${itemLevel}` : ''].filter(Boolean).join(' · ')));
      }
      wrap.append(summary);

      const shown = expanded ? guide.rows : guide.rows.slice(0, PREVIEW_ROWS);
      wrap.append(rowTable(shown, 0));
      if (guide.rows.length > PREVIEW_ROWS) {
        const more = node('button', 'spec-specup-more', expanded ? `상위 ${PREVIEW_ROWS}개만 보기` : `전체 ${guide.rows.length}개 보기`);
        more.type = 'button';
        more.setAttribute('aria-expanded', String(expanded));
        more.addEventListener('click', () => { expanded = !expanded; render(); });
        wrap.append(more);
      }
      const notes = node('details', 'spec-specup-method');
      notes.append(node('summary', '', '계산 기준'));
      for (const text of footerNotes(answer)) notes.append(node('p', '', text));
      notes.append(node('p', '', '10만 G당 값이 높을수록 같은 골드로 더 많이 오릅니다. 실제 시세는 계속 바뀌므로 참고값입니다.'));
      wrap.append(notes);
      return wrap;
    }

    function render() {
      if (!root) return;
      root.replaceChildren();
      const context = current();
      const top = node('div', 'spec-specup-heading'), title = node('div');
      title.append(node('h2', '', '스펙업 효율'), node('p', '', '같은 골드로 딜이 가장 많이 오르는 순서'));
      top.append(title);
      if (context.approved && context.name) {
        const actions = node('div', 'spec-specup-actions');
        const retry = node('button', '', busy ? '계산 중' : last?.status === 'done' ? '다시 계산' : '계산하기');
        retry.type = 'button'; retry.disabled = busy;
        retry.addEventListener('click', () => void start());
        actions.append(retry);
        top.append(actions);
      }
      root.append(top);

      if (!context.approved) {
        const notice = node('p', 'spec-specup-status');
        notice.append(document.createTextNode('스펙업 계산은 가입 승인 회원만 쓸 수 있어요. '));
        const link = node('a', '', '로그인하고 승인받기');
        link.href = 'account.html';
        notice.append(link);
        root.append(notice, node('p', 'spec-specup-note', '계산 한 번에 20초 안팎이 걸리고 카카오톡 봇과 같은 자리를 나눠 써서, 방에서 쓰는 /스펙업이 밀리지 않게 회원만 열어 두었습니다.'));
        return;
      }
      const settled = last?.status === 'done' && last.guide.rows.length;
      const status = node('p', 'spec-specup-status', message
        || (settled ? `후보 ${last.guide.rows.length}개를 효율이 높은 순서로 보여 드려요.`
          : !context.name ? '캐릭터를 검색해 주세요.' : '탭을 열면 계산을 시작합니다.'));
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      root.append(status);
      if (last?.status === 'done') root.append(board(last));
    }

    async function start() {
      const context = current();
      if (busy || !context.approved || !context.name) return;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal, turn = ++serial, name = context.name;
      busy = true; polls = 0; expanded = false; last = null;
      message = '로펙 스펙업 가이드를 계산하고 있어요. 20초 안팎 걸립니다.';
      render();
      try {
        while (polls < POLL_MAX) {
          polls += 1;
          const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), 15000);
          let answer;
          try {
            const response = await fetch(`/api/auth/character/specup?name=${encodeURIComponent(name)}`,
              { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([signal, timeout.signal]) });
            if ([401, 403].includes(response.status)) { onUnauthorized(response.status); throw Error('가입 승인 회원만 쓸 수 있어요. 로그인 상태를 확인해 주세요.'); }
            if (response.status === 429) throw Error('조회가 잠시 많습니다. 잠시 후 다시 계산해 주세요.');
            if (!response.ok) throw Error('계산 결과를 불러오지 못했어요. 다시 시도해 주세요.');
            answer = await response.json();
          } finally { clearTimeout(timer); }
          if (turn !== serial || signal.aborted || current().name !== name) return;

          if (answer.status === 'running') {
            const seconds = Math.round((answer.elapsedMs || 0) / 1000);
            message = `계산하고 있어요… ${seconds}초 지났습니다.`;
            render();
            await new Promise(resolve => setTimeout(resolve, POLL_MS));
            if (turn !== serial || signal.aborted || current().name !== name) return;
            continue;
          }
          if (answer.status === 'busy') {
            message = '다른 계산이 진행 중이라 잠시 기다리고 있어요.';
            render();
            await new Promise(resolve => setTimeout(resolve, POLL_MS * 2));
            if (turn !== serial || signal.aborted || current().name !== name) return;
            continue;
          }
          if (answer.status === 'done') {
            last = answer;
            message = answer.guide.rows.length ? '' : '추천할 후보가 없어요.';
            return;
          }
          if (answer.status === 'unavailable') {
            message = '이 캐릭터의 스펙업 가이드를 계산할 수 없어요. 로펙 미갱신·서포터(미지원)·계산 시간 초과·시세 조회 실패 중 하나입니다.';
            return;
          }
          message = '봇이 답하지 않아 계산을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.';
          return;
        }
        message = '계산이 예상보다 오래 걸립니다. 다시 계산을 눌러 주세요.';
      } catch (error) {
        if (turn === serial && !signal.aborted) message = error.name === 'AbortError' ? '계산이 지연되고 있어요. 다시 시도해 주세요.' : error.message;
      } finally {
        if (turn === serial) { busy = false; render(); }
      }
    }

    // 탭을 열 때마다 한 번 그린다 — 승인 전에는 계산을 걸지 않으므로 그리지 않으면 빈 칸만 남는다.
    function selected() { render(); if (!last && !busy) void start(); }
    return { reset, selected };
  } };
})();
