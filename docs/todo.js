(() => {
  'use strict';
  // 숙제표: 내 원정대에서 고른 캐릭터의 일일·주간 숙제를 체크한다(README.md).
  // 공식 API는 클리어 여부를 주지 않으므로 체크는 직접 하고, 06:00(주간은 수요일)에 서버가 새 주기로 넘긴다.
  if (location.origin === 'https://opentalk.example.invalid' && location.pathname === '/opentalk-lostark-bot/todo.html') {
    location.replace('https://opentalk.example.invalid/todo.html');
    return;
  }
  const byId = id => document.getElementById(id);
  const status = byId('todo-status');
  const board = byId('todo-board');
  const picker = byId('todo-picker');
  const rosterList = byId('todo-roster');
  const summary = byId('todo-summary');
  const node = (tag, text, className = '') => {
    const element = document.createElement(tag);
    element.textContent = text;
    element.className = className;
    return element;
  };
  const number = value => value.toLocaleString('ko-KR');
  const level = value => value.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let data = null;
  let approved = false;
  let generation = 0;
  let busy = false;
  let picking = false;
  let pending = new Map();
  let sending = new Map();
  let lost = false;
  let chain = Promise.resolve();
  let sendTimer = null;
  let drafts = new Map();
  let openPickers = new Set();
  let autoTried = false;
  // 선택창을 연 동안 사용자가 바꾼 상자(아직 저장 전). 체크 응답 등으로 다시 그려도 이 선택을 쓰고, 닫거나 저장하면 버린다.
  let pickerDraft = null;
  const controllers = new Set();

  function announce(message, error = false) {
    if (status.textContent !== message) status.textContent = message;
    status.classList.toggle('error', error);
  }

  async function request(path, options = {}) {
    if (!approved) throw new Error('Site approval required');
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal });
      if ([401, 403].includes(response.status) && !controller.signal.aborted) {
        window.publishPogeunSiteAccess?.({ approved: false, authenticated: response.status !== 401, status: response.status === 401 ? 'anonymous' : 'unavailable' });
      }
      const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
      if (!response.ok) { const error = new Error('request failed'); error.status = response.status; error.code = body?.error; throw error; }
      if (!body) throw new Error('invalid response');
      return body;
    } finally { clearTimeout(timer); controllers.delete(controller); }
  }

  // 서버가 준 판만 그린다. 모양이 어긋나면 화면을 비우고 다시 확인하게 둔다.
  function valid(value) {
    return value && typeof value === 'object' && Array.isArray(value.characters) && Array.isArray(value.daily) &&
      Array.isArray(value.weekly) && Array.isArray(value.raids) && value.periods && typeof value.periods.weekly === 'string' &&
      value.limits && Number.isSafeInteger(value.limits.raids) && typeof value.csrfToken === 'string';
  }

  const raidOf = id => data.raids.find(entry => entry.id === id) ?? null;
  const itemsOf = scope => (scope === 'daily' ? data.daily : data.weekly);
  const valueOf = (character, scope, itemId) => character[scope][itemId] ?? 0;

  // 이번 주 레이드 골드: 체크한 관문의 골드에서 더보기 비용을 뺀다.
  function goldOf(character) {
    let gold = 0;
    for (const id of character.raids) {
      const raid = raidOf(id);
      if (!raid) continue;
      raid.gates.forEach((gate, index) => {
        if (valueOf(character, 'weekly', `${id}|${index}`)) gold += gate.g;
        if (valueOf(character, 'weekly', `${id}|${index}|bonus`)) gold -= gate.bonus;
      });
    }
    return gold;
  }

  function dailyLeft(character) {
    return data.daily.reduce((left, item) => left + Math.max(0, item.max - valueOf(character, 'daily', item.id)), 0);
  }

  // 판을 바꾸는 요청(체크 저장·캐릭터 저장·자동 선정·새로 읽기)은 한 번에 하나씩 차례로 보낸다. 늦게 온 이전 응답이 새
  // 화면을 덮거나, 다른 요청이 도는 동안 예약해 둔 체크가 버려지지 않게 한다(2026-09-23 교차 검토 F-P2-1·F-P2-2).
  // 차례 안의 작업은 다른 차례를 기다리지 않는다 — 기다리면 줄이 막힌다.
  function serial(task) {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  // 서버가 준 판을 받되, 아직 확인받지 못한 체크(보내는 중·보낼 차례)는 그 위에 다시 얹어 누른 대로 보이게 한다.
  // 체크 저장 응답에는 원정대 목록이 없고, 새로 읽을 때 원정대 조회가 잠시 실패하면 null이 온다. 그때는 직전에 받은
  // 목록을 이어 쓴다 — 그러지 않으면 「캐릭터 고르기」가 비어 빈 명단이 저장될 수 있다(2026-09-23 회원 화면 점검).
  function adopt(result) {
    for (const change of [...sending.values(), ...pending.values()]) {
      const character = result.characters.find(entry => entry.characterName === change.characterName);
      if (character) character[change.scope][change.itemId] = change.value;
    }
    if (!Array.isArray(result.roster) && Array.isArray(data?.roster)) {
      result.roster = data.roster;
      result.rosterUpdatedAt = data.rosterUpdatedAt;
    }
    data = result;
  }
  const rosterOf = () => (Array.isArray(data?.roster) ? data.roster : []);

  // 체크 한 칸을 바로 화면에 반영하고, 잠깐 모았다가 한 번에 보낸다.
  function queue(characterName, scope, itemId, value) {
    if (busy || !data) return;
    const character = data.characters.find(entry => entry.characterName === characterName);
    if (!character) return;
    character[scope][itemId] = value;
    pending.set(`${characterName}|${scope}|${itemId}`, { characterName, scope, itemId, value });
    render();
    clearTimeout(sendTimer);
    sendTimer = setTimeout(flush, 500);
  }

  function flush() {
    clearTimeout(sendTimer);
    return serial(sendChecks);
  }

  // 다시 보내면 저장될 수 있는 실패인가(연결·시간 초과·서버 오류·요청 과다·모양이 어긋난 응답).
  const retryable = error => !error.status || error.status === 429 || error.status >= 500;

  // 모인 체크를 60칸씩 보낸다. 보내는 동안 새로 누른 체크는 응답을 받은 뒤 이어서 보낸다. 저장하지 못한 체크가
  // 남아 있지 않을 때만 true — 그래야 뒤에 줄 선 표 바꾸기·새로 읽기가 앞선 실패를 덮지 않는다(2026-09-23 교차 검토
  // F-R1: 전에는 실패한 체크를 대기열에서 빼 버려, 뒤 요청이 보낼 것이 없다는 이유로 성공처럼 진행했다).
  // - 다시 보내면 될 실패: 체크를 대기열에 되돌려 화면에 남기고, 다음 저장·새로고침·표 바꾸기 때 먼저 다시 보낸다.
  // - 다시 보내도 안 될 실패: 그 체크는 버리고 `lost`를 켠다. 다음 저장 응답이나 새로고침이 저장된 판을 받아 끈다.
  async function sendChecks() {
    while (pending.size && data && approved) {
      const batch = [...pending].slice(0, 60);
      for (const [key, change] of batch) { pending.delete(key); sending.set(key, change); }
      const current = generation;
      let result = null, failure = null;
      try {
        result = await request('/api/auth/homework/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': data.csrfToken },
          body: JSON.stringify({ changes: batch.map(([, change]) => change) }),
        });
        if (!valid(result)) throw new Error('invalid response');
      } catch (error) { failure = error; }
      sending = new Map();
      if (current !== generation) return false;
      if (failure) {
        if ([401, 403].includes(failure.status)) { handleError(failure, ''); return false; }
        if (retryable(failure)) {
          // 보내는 동안 같은 칸을 다시 눌렀으면 그 새 값을 남긴다.
          for (const [key, change] of batch) if (!pending.has(key)) pending.set(key, change);
          announce(failure.status === 429
            ? '요청이 많아 체크를 아직 저장하지 못했어요. 조금 뒤 「새로고침」을 누르면 다시 저장해 볼게요.'
            : '체크를 저장하지 못했어요. 누른 체크는 화면에 남겨 두었고, 「새로고침」을 누르면 다시 저장해 볼게요.', true);
        } else {
          lost = true;
          announce('체크를 저장하지 못했어요. 「새로고침」을 누르면 저장된 상태로 돌아가요.', true);
        }
        return false;
      }
      const recovered = lost;
      adopt(result);
      lost = false; // 방금 받은 판이 저장된 상태를 그대로 보여 준다.
      render();
      announce(recovered ? '숙제 체크를 저장했어요. 저장하지 못했던 체크는 저장된 상태로 되돌렸어요.' : '숙제 체크를 저장했어요.');
    }
    return !lost;
  }

  function handleError(error, message) {
    if ([401, 403].includes(error.status)) {
      clearBoard();
      announce(error.status === 401 ? '로그인이 필요합니다.' : '가입 승인 후 이용할 수 있어요.', true);
      return;
    }
    announce(error.status === 429 ? '요청이 많아 잠시 기다려야 해요. 조금 뒤 다시 시도해 주세요.' : message, true);
  }

  function clearBoard() {
    data = null;
    clearTimeout(sendTimer);
    pending = new Map();
    sending = new Map();
    lost = false;
    drafts = new Map();
    openPickers = new Set();
    board.replaceChildren();
    summary.hidden = true;
    picker.hidden = true;
    picking = false;
    pickerDraft = null;
    byId('todo-period').textContent = '';
    byId('todo-note').textContent = '';
  }

  function resetLabel() {
    const daily = data.resets?.daily, weekly = data.resets?.weekly;
    const fmt = value => (Number.isSafeInteger(value)
      ? new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' }).format(new Date(value))
      : '');
    return [`이번 주 ${data.periods.weekly} 시작`, daily && `일일 초기화 ${fmt(daily)}`, weekly && `주간 초기화 ${fmt(weekly)}`].filter(Boolean).join(' · ');
  }

  // 0 → 1 → … → max → 0 으로 도는 칸. max가 1이면 그냥 켜고 끈다.
  function counter(character, scope, item) {
    const value = valueOf(character, scope, item.id);
    const button = node('button', '', `todo-item${value >= item.max ? ' done' : value ? ' partial' : ''}`);
    button.type = 'button';
    button.disabled = busy;
    button.setAttribute('aria-pressed', String(value >= item.max));
    button.append(node('span', item.short || item.name, 'todo-item-name'));
    if (item.max > 1) button.append(node('span', `${value}/${item.max}`, 'todo-item-count'));
    button.addEventListener('click', () => queue(character.characterName, scope, item.id, (value + 1) % (item.max + 1)));
    return button;
  }

  function raidRow(character, id) {
    const raid = raidOf(id);
    if (!raid) return null;
    const row = node('div', '', 'todo-raid');
    const cleared = raid.gates.every((gate, index) => valueOf(character, 'weekly', `${id}|${index}`));
    row.append(node('span', `${raid.name} ${raid.diff}`, `todo-raid-name${cleared ? ' done' : ''}`));
    const gates = node('div', '', 'todo-gates');
    raid.gates.forEach((gate, index) => {
      const gateId = `${id}|${index}`;
      const done = valueOf(character, 'weekly', gateId);
      const bonus = valueOf(character, 'weekly', `${gateId}|bonus`);
      const cell = node('div', '', 'todo-gate');
      const clear = node('button', `${index + 1}관`, `todo-gate-clear${done ? ' done' : ''}`);
      clear.type = 'button';
      clear.disabled = busy;
      clear.setAttribute('aria-pressed', String(Boolean(done)));
      clear.title = `${number(gate.g)} G`;
      clear.addEventListener('click', () => queue(character.characterName, 'weekly', gateId, done ? 0 : 1));
      const more = node('button', '더보기', `todo-gate-bonus${bonus ? ' done' : ''}`);
      more.type = 'button';
      more.disabled = busy;
      more.setAttribute('aria-pressed', String(Boolean(bonus)));
      more.title = `더보기 ${number(gate.bonus)} G`;
      more.addEventListener('click', () => queue(character.characterName, 'weekly', `${gateId}|bonus`, bonus ? 0 : 1));
      cell.append(clear, more);
      gates.append(cell);
    });
    row.append(gates);
    return row;
  }

  const draftOf = character => drafts.get(character.characterName) ?? character.raids;
  const sameRaids = (a, b) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

  // 그 캐릭터가 갈 수 있는 레이드를 칩으로 보여 준다. 세 개까지 골라 둔 뒤 「적용」을 누르면 한 번에 저장한다.
  function raidPicker(character) {
    const name = character.characterName;
    const draft = draftOf(character);
    const wrap = node('div', '', 'todo-raid-picker');
    wrap.append(node('p', `${data.limits.raids}개까지 고른 뒤 「적용」을 누르면 한 번에 저장돼요.`, 'todo-picker-hint'));
    const chips = node('div', '', 'todo-chips');
    const available = data.raids.filter(entry => character.itemLevel >= entry.ilvl);
    for (const raid of available) {
      const chosen = draft.includes(raid.id);
      const chip = node('button', `${raid.name} ${raid.diff}`, `todo-chip${chosen ? ' chosen' : ''}`);
      chip.type = 'button';
      chip.disabled = busy || (!chosen && draft.length >= data.limits.raids);
      chip.setAttribute('aria-pressed', String(chosen));
      chip.addEventListener('click', () => {
        drafts.set(name, chosen ? draft.filter(entry => entry !== raid.id) : [...draft, raid.id]);
        render();
      });
      chips.append(chip);
    }
    if (!available.length) chips.append(node('p', '아직 들어갈 수 있는 레이드가 없어요.', 'todo-empty'));
    wrap.append(chips);
    if (available.length) {
      const changed = !sameRaids(draft, character.raids);
      const actions = node('div', '', 'todo-draft-actions');
      actions.append(node('span', `고른 레이드 ${draft.length} / ${data.limits.raids}`, 'todo-draft-count'));
      const apply = node('button', '적용', 'home-button');
      apply.type = 'button';
      apply.disabled = busy || !changed;
      apply.addEventListener('click', () => {
        const picked = [...draft];
        drafts.delete(name);
        saveCharacters(data.characters.map(entry => ({
          characterName: entry.characterName,
          raids: entry.characterName === name ? picked : entry.raids,
        })), `${name}의 주간 레이드 ${picked.length}개를 저장했어요.`);
      });
      const reset = node('button', '되돌리기', 'quiet-button');
      reset.type = 'button';
      reset.disabled = busy || !changed;
      reset.addEventListener('click', () => { drafts.delete(name); render(); });
      actions.append(apply, reset);
      wrap.append(actions);
    }
    return wrap;
  }

  function card(character) {
    const article = node('article', '', 'todo-card');
    const head = node('div', '', 'todo-card-head');
    head.append(node('h2', character.characterName, 'todo-card-name'));
    head.append(node('span', `${character.characterClass} · ${level(character.itemLevel)}`, 'todo-card-meta'));
    const gold = goldOf(character);
    head.append(node('span', gold ? `${number(gold)} G` : '', 'todo-card-gold'));
    article.append(head);

    const daily = node('div', '', 'todo-line');
    daily.append(node('span', '일일', 'todo-line-label'));
    const dailyItems = node('div', '', 'todo-items');
    for (const item of data.daily) dailyItems.append(counter(character, 'daily', item));
    daily.append(dailyItems);
    article.append(daily);

    const weekly = node('div', '', 'todo-line');
    weekly.append(node('span', '주간', 'todo-line-label'));
    const weeklyItems = node('div', '', 'todo-items');
    for (const item of data.weekly) weeklyItems.append(counter(character, 'weekly', item));
    weekly.append(weeklyItems);
    article.append(weekly);

    const raids = node('div', '', 'todo-raids');
    for (const id of character.raids) {
      const row = raidRow(character, id);
      if (row) raids.append(row);
    }
    if (!character.raids.length) raids.append(node('p', '주간 레이드를 아직 고르지 않았어요.', 'todo-empty'));
    article.append(raids);

    const details = document.createElement('details');
    details.className = 'todo-raid-edit';
    details.open = openPickers.has(character.characterName);
    details.append(node('summary', '주간 레이드 고르기'));
    details.addEventListener('toggle', () => {
      if (details.open) openPickers.add(character.characterName);
      else { openPickers.delete(character.characterName); drafts.delete(character.characterName); }
    });
    details.append(raidPicker(character));
    article.append(details);
    return article;
  }

  function render() {
    if (!approved || !data) { clearBoard(); return; }
    byId('todo-period').textContent = resetLabel();
    board.replaceChildren();
    for (const character of data.characters) board.append(card(character));
    if (!data.characters.length) {
      board.append(node('p', '표가 비어 있어요. 위의 「자동 선정」을 누르면 아이템 레벨이 높은 캐릭터와 레이드를 골라 주고, 「캐릭터 고르기」로 직접 정할 수도 있어요.', 'todo-empty todo-empty-board'));
    }
    summary.hidden = !data.characters.length;
    byId('todo-count').textContent = number(data.characters.length);
    byId('todo-daily-left').textContent = number(data.characters.reduce((sum, entry) => sum + dailyLeft(entry), 0));
    byId('todo-gold').textContent = number(data.characters.reduce((sum, entry) => sum + goldOf(entry), 0));
    byId('todo-note').textContent = [
      '공식 API는 클리어 여부를 알려 주지 않아 체크는 직접 해요',
      '일일은 매일 06시, 주간은 수요일 06시에 새로 시작해요',
      `콘텐츠 자료 ${data.dataDate} 기준`,
    ].join(' · ');
    if (picking) renderPicker();
  }

  function renderPicker() {
    const roster = rosterOf();
    pickerDraft ??= new Set(data.characters.map(entry => entry.characterName));
    const chosen = pickerDraft;
    const counted = () => roster.filter(character => chosen.has(character.characterName)).length;
    rosterList.replaceChildren();
    byId('todo-save').disabled = !roster.length;
    if (!roster.length) {
      rosterList.append(node('p', '원정대를 불러오지 못했어요. 잠시 후 새로고침해 주세요.', 'todo-empty'));
      byId('todo-picker-count').textContent = '';
      return;
    }
    // 저장 뒤 자동 선정이 채우는 규칙을 미리 알린다(README.md §3). 동작은 그대로다.
    const auto = data.limits.auto ?? 6;
    const hint = node('p', `${auto}명보다 적게 고르면 저장할 때 아이템 레벨이 높은 순으로 ${auto}명까지 채우고, 비어 있는 주간 레이드도 레벨에 맞게 골라 드려요.`, 'todo-picker-hint');
    hint.style.gridColumn = '1 / -1'; // 원정대 목록은 격자라 안내가 한 칸에 갇히지 않게 한 줄 전체를 쓴다.
    rosterList.append(hint);
    for (const character of roster) {
      const label = node('label', '', 'todo-roster-row');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = character.characterName;
      box.checked = chosen.has(character.characterName);
      box.disabled = busy;
      box.addEventListener('change', () => {
        if (box.checked) chosen.add(character.characterName); else chosen.delete(character.characterName);
        byId('todo-picker-count').textContent = `${counted()} / ${data.limits.characters}명 선택`;
      });
      label.append(box, node('span', character.characterName, 'todo-roster-name'),
        node('span', `${character.characterClass} · ${level(character.itemLevel)}`, 'todo-roster-meta'));
      rosterList.append(label);
    }
    byId('todo-picker-count').textContent = `${counted()} / ${data.limits.characters}명 선택`;
  }

  // 표를 바꾸는 요청(캐릭터 저장·자동 선정). 먼저 모인 체크를 보낸 뒤에 표를 바꾸고, 체크를 저장하지 못했으면 표는
  // 그대로 두고 그 안내를 남긴다 — 표를 바꾼 뒤 보내면 그 사이 빠진 캐릭터의 체크가 거절된다.
  // 서버가 표를 바꿔 저장했을 때만 true — 뒤따르는 자동 선정이 실패를 덮지 않게 한다(2026-09-23 교차 검토 P2:
  // 캐릭터 저장이 422·503·연결 끊김으로 실패해도 /auto가 이어져 기본 인원으로 저장되고 실패 안내가 사라졌다).
  function changeBoard(path, body, message, failure, after = () => {}) {
    if (busy || !data) return Promise.resolve(false);
    busy = true;
    render();
    clearTimeout(sendTimer);
    return serial(async () => {
      const saved = await sendChecks();
      const current = generation;
      if (!saved || !data) { busy = false; render(); return false; }
      try {
        const result = await request(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': data.csrfToken },
          body: JSON.stringify(body),
        });
        if (current !== generation) return false;
        if (!valid(result)) throw new Error('invalid response');
        adopt(result);
        after();
        announce(message);
        return true;
      } catch (error) {
        if (current !== generation) return false;
        handleError(error, failure(error));
        return false;
      } finally {
        if (current === generation) { busy = false; render(); }
      }
    });
  }

  const saveCharacters = (characters, message) => changeBoard('/api/auth/homework/characters', { characters }, message,
    error => (error.code === 'member_roster_selection_invalid'
      ? '내 원정대에 없는 캐릭터는 표에 올릴 수 없어요.' : '캐릭터를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.'));

  // 서버가 표를 채운다. 레이드는 세 개까지, 캐릭터는 주간 골드를 받는 여섯 명까지 레벨이 높은 순으로 올린다.
  const autoFill = message => changeBoard('/api/auth/homework/auto', {}, message,
    () => '자동 선정을 하지 못했어요. 잠시 후 다시 시도해 주세요.', () => { drafts = new Map(); });

  // 자동 선정이 채울 것이 남았나. 레이드가 덜 찬 캐릭터가 있거나 골드를 받는 인원이 덜 찼을 때.
  function needsAuto() {
    if (!data) return false;
    const limit = data.limits.raids ?? 3;
    const short = data.characters.some(entry => {
      if (entry.raids.length >= limit) return false;
      const names = new Set(entry.raids.map(id => raidOf(id)?.name));
      return data.raids.some(raid => entry.itemLevel >= raid.ilvl && !names.has(raid.name));
    });
    if (short) return true;
    const want = Math.min(data.limits.auto ?? 6, data.limits.characters ?? 24, rosterOf().length);
    return data.characters.length < want;
  }

  // 새로 읽기도 같은 차례를 탄다. 모인 체크를 먼저 보내야 읽어 온 판이 방금 누른 체크를 되돌리지 않는다.
  function load(message = '') {
    if (!approved || document.hidden) return Promise.resolve();
    clearTimeout(sendTimer);
    return serial(async () => {
      if (!approved || document.hidden) return;
      const saved = await sendChecks();
      // 다시 보내도 저장되지 않은 체크가 남았으면 판을 덮지 않고 그 안내를 남긴다. 버린 체크(`lost`)만 있으면
      // 저장된 판을 받아 되돌린다 — 새로고침이 그 상태를 끄는 유일한 동작이다.
      if (!saved && (pending.size || !data)) return;
      const recovering = lost;
      const current = ++generation;
      busy = true;
      try {
        const result = await request('/api/auth/homework');
        if (current !== generation) return;
        if (!valid(result)) throw new Error('invalid response');
        adopt(result);
        lost = false;
        busy = false;
        render();
        if (recovering) announce('저장하지 못한 체크는 빼고, 저장된 숙제 현황을 다시 불러왔어요.', true);
        else announce(message || (data.characters.length ? '현재 숙제 현황이에요. 칸을 눌러 체크할 수 있어요.' : '표에 올릴 캐릭터를 골라 주세요.'));
        if (!autoTried && !data.characters.length && Array.isArray(data.roster) && data.roster.length) {
          autoTried = true;
          // 이 차례가 끝난 다음 차례로 선다(여기서 기다리지 않는다).
          void autoFill(`원정대에서 아이템 레벨이 높은 ${data.limits.auto ?? 6}캐릭터를 올리고 주간 레이드를 골랐어요. 「캐릭터 고르기」와 카드의 「주간 레이드 고르기」로 바꿀 수 있어요.`);
        }
      } catch (error) {
        if (current !== generation) return;
        busy = false;
        handleError(error, '숙제표를 불러오지 못했어요. 잠시 후 다시 확인해 주세요.');
      }
    });
  }

  byId('todo-pick').addEventListener('click', () => {
    if (!data || busy) return;
    picking = !picking;
    picker.hidden = !picking;
    pickerDraft = null; // 열 때마다 저장된 표에서 시작한다.
    if (picking) { renderPicker(); byId('picker-title').focus({ preventScroll: true }); }
  });
  byId('todo-cancel').addEventListener('click', () => { picking = false; picker.hidden = true; pickerDraft = null; });
  byId('todo-save').addEventListener('click', async () => {
    if (!data || busy) return;
    // 고를 목록이 없을 때 누른 저장은 빈 명단 저장이 되므로 보내지 않는다.
    if (!rosterOf().length) {
      announce('원정대 목록을 불러오지 못해 저장하지 않았어요. 「새로고침」 뒤 다시 골라 주세요.', true);
      return;
    }
    const names = [...rosterList.querySelectorAll('input:checked')].map(box => box.value).slice(0, data.limits.characters);
    const keep = new Map(data.characters.map(entry => [entry.characterName, entry.raids]));
    picking = false;
    picker.hidden = true;
    pickerDraft = null;
    const saved = await saveCharacters(names.map(name => ({ characterName: name, raids: keep.get(name) ?? [] })), '표에 올릴 캐릭터를 저장했어요.');
    if (saved && needsAuto()) await autoFill('표에 올린 캐릭터와 레벨에 맞는 주간 레이드를 저장했어요.');
  });
  byId('todo-auto').addEventListener('click', () =>
    autoFill(`아이템 레벨이 높은 ${data?.limits?.auto ?? 6}캐릭터까지 올리고 캐릭터마다 주간 레이드를 ${data?.limits?.raids ?? 3}개로 채웠어요.`));
  byId('todo-refresh').addEventListener('click', () => { if (!busy) load('현재 숙제 현황을 다시 확인했어요.'); });
  window.addEventListener('pagehide', () => { generation++; for (const controller of controllers) controller.abort(); controllers.clear(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

  function accessChanged(detail) {
    const was = approved;
    approved = detail?.approved === true;
    if (!approved) {
      generation++;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      clearBoard();
      announce('');
    } else if (!was) load();
  }
  document.addEventListener('site:access', event => accessChanged(event.detail));
  accessChanged(window.pogeunSiteAccess);
})();
