(function () {
  'use strict';

  const form = document.getElementById('spec-form');
  const input = document.getElementById('spec-name');
  const status = document.getElementById('spec-status');
  const results = document.getElementById('spec-results');
  const heading = document.getElementById('result-title');
  const detailSections = ['equipment', 'accessories', 'gems', 'engravings', 'arkpassive', 'crit', 'cards', 'arkgrid'];
  const allSections = [...detailSections, 'roster'];
  const tabs = [...document.querySelectorAll('[role="tab"][data-tab]')];
  const sectionTabs = { equipment: 'equipment', accessories: 'equipment', gems: 'build', engravings: 'engravings', cards: 'cards', arkpassive: 'arkpassive', crit: 'crit', roster: 'roster', arkgrid: 'arkgrid' };
  let summaryData = {};
  let summaryErrors = {};
  let snapshotMeta = {};
  let generation = 0;
  let active = null;
  let efficiencyController = null;
  let efficiencyState = { status: 'idle' };
  let tierState = { status: 'idle' };
  let scoreRecordState = null;
  let tierController = null;
  let braceletValueController = null;
  let braceletValueState = { status: 'idle' };
  let braceletValueRetryTimer = null;
  // 첫 가격 조회가 일시적으로 막히면(잠깐의 서버 오류·연결 끊김·조회 한도) 버튼을 누르기 전에 스스로 다시 확인한다.
  // 일반 오류는 짧은 간격으로 최대 3회, 조회 한도(429)는 한도 창이 풀릴 시간을 두고 최대 2회.
  const BRACELET_RETRY_DELAYS = [1500, 4000, 8000];
  const BRACELET_RETRY_DELAYS_LIMITED = [15000, 30000];
  // Character lookup is public; membership only adds the representative shortcut below.
  const accessApproved = true;
  let memberApproved = false;
  let entryHandled = false;
  let sessionController = null;
  let recent = [];
  let inputTouched = false;
  const valuation = window.PogeunValuation.create({
    getContext: () => ({ name: summaryData.profile?.characterName, approved: accessApproved,
      saved: !summaryData.details || snapshotMeta.details?.source === 'saved' }),
    onUnauthorized: denyAccess,
  });
  // 스펙업 계산은 봇의 격리 슬롯을 카카오톡과 나눠 써서 가입 승인 회원만 쓴다(설계 README.md).
  const specup = window.PogeunSpecup.create({
    getContext: () => ({ name: summaryData.profile?.characterName, approved: memberApproved,
      className: summaryData.profile?.characterClass, itemLevel: summaryData.profile?.itemLevel }),
    onUnauthorized: denyAccess,
  });
  const favoriteKey = 'pogeun-character-favorites';
  const recentKey = 'pogeun-character-recent';
  const validName = (value) => typeof value === 'string' && /^[가-힣A-Za-z0-9]{2,12}$/.test(value);
  function savedNames(key) {
    try {
      const raw = localStorage.getItem(key);
      const saved = raw && raw.length <= 4096 ? JSON.parse(raw) : null;
      if (Array.isArray(saved)) return [...new Map(saved.filter(validName).map((name) => [name.toLowerCase(), name])).values()].slice(0, 8);
    } catch { /* The search remains available when browser storage is unavailable. */ }
    return [];
  }
  let favorites = [];

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function renderSnapshotNotice() {
    const notice = document.getElementById('spec-snapshot-notice');
    const names = { profile: '기본 정보', details: '장비·세팅', roster: '원정대', arkgrid: '원정대 아크그리드' };
    const entries = Object.entries(snapshotMeta);
    const saved = entries.filter(([, data]) => data.source === 'saved');
    const timestamp = value => Number.isFinite(value)
      ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }) : '확인 불가';
    notice.replaceChildren();
    notice.hidden = saved.length === 0;
    if (saved.length) {
      notice.append(element('p', '', '최신 정보를 불러올 수 없어 저장된 정보를 표시합니다.'));
      const grouped = new Map();
      for (const [section, data] of saved) {
        const time = timestamp(data.capturedAt);
        grouped.set(time, [...(grouped.get(time) || []), names[section]]);
      }
      for (const [time, sections] of grouped) notice.append(element('p', '',
        `마지막 갱신 ${time} (한국 시간) · ${sections.join(' / ')}`));
    }
    const times = entries.map(([, data]) => data.capturedAt).filter(Number.isFinite);
    document.getElementById('spec-data-note').textContent = saved.length
      ? '저장 시점의 장착 정보입니다. 다시 검색하면 최신화를 시도합니다.'
      : times.length ? `최근 갱신 ${timestamp(Math.max(...times))} · 한국 시간`
        : '검색할 때 최신 정보로 갱신합니다.';
  }

  function safeImageUrl(value, portrait = false) {
    if (typeof value !== 'string' || value.length > 2048) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'cdn-lostark.game.onstove.com' || url.username || url.password || url.port || url.hash) return null;
      if (portrait && (!/^\/armory\/[A-Za-z0-9_/-]+\.(?:jpg|png|webp)$/i.test(url.pathname) || !/^(?:\?v=[A-Za-z0-9_-]{1,64})?$/.test(url.search))) return null;
      if (!portrait && !/\.(?:png|jpe?g|webp|gif)$/i.test(url.pathname)) return null;
      return url.href;
    } catch { return null; }
  }

  function appendImage(target, value, portrait = false) {
    const url = safeImageUrl(value, portrait);
    if (!url) return;
    const image = element('img');
    image.alt = '';
    image.decoding = 'async';
    image.loading = portrait ? 'eager' : 'lazy';
    image.referrerPolicy = 'no-referrer';
    const fallback = target.firstElementChild;
    image.addEventListener('load', () => { if (fallback) fallback.hidden = true; }, { once: true });
    image.addEventListener('error', () => {
      image.remove();
      if (fallback) fallback.hidden = false;
    }, { once: true });
    image.src = url;
    target.appendChild(image);
  }

  function itemIcon(value, fallback, small = false) {
    const icon = element('span', `spec-icon${small ? ' spec-icon-small' : ''}`);
    icon.appendChild(element('span', '', String(fallback || '·').slice(0, 1)));
    icon.setAttribute('aria-hidden', 'true');
    appendImage(icon, value);
    return icon;
  }

  function engravingIcon(value, small = false) {
    const icon = element('span', `spec-icon spec-engraving-icon${small ? ' spec-icon-small' : ''}`);
    icon.setAttribute('aria-hidden', 'true');
    const fallback = element('span', 'spec-engraving-fallback');
    fallback.append(symbol('engravings'));
    icon.append(fallback);
    appendImage(icon, value);
    return icon;
  }

  function numeric(value, digits = 2) {
    return typeof value === 'number' && Number.isFinite(value)
      ? value.toLocaleString('ko-KR', { maximumFractionDigits: digits }) : '정보 없음';
  }

  function percent(value) {
    return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}%` : '정보 없음';
  }

  // Top-N% text for tier percentiles: two decimals, and anything that would round to 0 reads as '0.01% 미만'.
  function topPercent(value) {
    return value < 0.005 ? '0.01% 미만' : `${numeric(value, 2)}%`;
  }
  function shortDate(ms) {
    const date = new Date(ms);
    return `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}`;
  }

  function setStatus(text, error = false, quiet = false) {
    status.textContent = text;
    status.dataset.error = String(error);
    status.classList.toggle('spec-visually-hidden', quiet);
  }

  function selectTab(name, { focus = false, updateHash = false } = {}) {
    if (!tabs.some((tab) => tab.dataset.tab === name)) return;
    for (const tab of tabs) {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
      if (selected && focus) tab.focus();
    }
    if (updateHash && window.location.hash !== `#panel-${name}`) {
      history.pushState(null, '', `#panel-${name}`);
    }
    if (name === 'valuation') valuation.selected();
    if (name === 'specup') specup.selected();
  }

  function selectLocationTab() {
    const hash = window.location.hash.slice(1);
    const name = hash.startsWith('card-') ? sectionTabs[hash.slice(5)] : hash.replace(/^(?:panel|tab)-/, '');
    selectTab(name || 'summary');
  }

  function summaryCard(title, tab, render, key) {
    const card = element('section', 'spec-summary-card');
    if (key) card.classList.add(`spec-summary-${key}`);
    const top = element('h3', 'spec-summary-heading');
    const caption = element('span', 'spec-summary-title-group');
    caption.append(element('span', 'spec-summary-title', title));
    const subtitle = ({ identity: 'PROFILE', combat: 'MAIN STATS', engravings: 'ENGRAVING', arkpassive: 'ARK PASSIVE', arkgrid: 'ARK GRID', equipment: 'EQUIPMENT', gems: 'GEMS', cards: 'CARDS', accessories: 'BRACELET' })[key];
    if (subtitle) {
      const label = element('span', 'spec-summary-subtitle', subtitle);
      label.setAttribute('aria-hidden', 'true');
      caption.append(label);
    }
    const body = element('div', 'spec-summary-body');
    render(body);
    if (!tab) {
      top.append(caption);
      card.append(top, body);
      return card;
    }
    const button = element('button', 'spec-summary-link');
    button.type = 'button';
    button.dataset.summaryTitle = title;
    const arrow = element('span', 'spec-summary-more', '상세보기');
    arrow.setAttribute('aria-hidden', 'true');
    button.setAttribute('aria-label', `${title} 상세`);
    button.append(caption, arrow);
    button.addEventListener('click', () => selectTab(tab, { focus: true, updateHash: true }));
    top.appendChild(button);
    card.append(top, body);
    return card;
  }

  function summaryUnavailable(target, section) {
    if (summaryErrors[section]) {
      empty(target, '조회 안 됨');
      return true;
    }
    if (!summaryData[section]) {
      target.appendChild(element('p', 'spec-loading', '불러오는 중'));
      return true;
    }
    return false;
  }

  const motifs = {
    combat:'m5 3 14 14m-3-14L3 16m0-5 8 8M13 3l6 6M3 19l3-3m10 0 3 3',
    heart:'M12 20S2 14 2 7a5 5 0 0 1 10-1 5 5 0 0 1 10 1c0 7-10 13-10 13Z',
    arkgrid:'m12 2 9 5v10l-9 5-9-5V7Zm0 4 5 3v6l-5 3-5-3V9Zm0 0v12M3 7l4 2m10 6 4 2',
    crit:'m12 2 2 7 8 3-8 2-2 8-2-8-8-2 8-3Z',
    equipment:'m8 3-6 4 3 5 3-2v12h8V10l3 2 3-5-6-4-4 3Z',
    engravings:'M5 3h14v18H5ZM8 7h8M8 11h8M8 15h5',
    gems:'m7 3-5 6 10 13L22 9l-5-6Zm-5 6h20M7 3l5 19 5-19',
    cards:'M3 3h12v17H3Zm15 2h3v17H9m-3-12 3-4 3 4-3 4Z',
    arkpassive:'m12 2 9 6-4 12H7L3 8Zm0 4-5 4 2 6h6l2-6Zm0-4v4m9 2-4 2m0 10-2-4M7 20l2-4M3 8l4 2',
    accessories:'M5 7a7 7 0 1 0 14 0M8 6l4-4 4 4-4 4Zm-3 1h3m8 0h3',
    roster:'m12 2 9 5v10l-9 5-9-5V7Zm0 4v12m-6-8 6 4 6-4',
    identity:'m12 2 8 5v10l-8 5-8-5V7Zm0 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm-5 11c1-5 9-5 10 0',
    server:'M5 3h14v7H5Zm0 11h14v7H5ZM8 6h1m-1 11h1m6-11h1m-1 11h1M12 10v4',
    guild:'M5 21V3m0 1h14l-3 5 3 5H5',
    resolve:'m12 2 7 4-2 11-5 5-5-5L5 6Zm0 4v11m-5-9 5 3 5-3',
    expertise:'M12 2v5m0 10v5M2 12h5m10 0h5m-16-6 3 3m6 6 3 3M6 18l3-3m6-6 3-3m-3 6-3-3-3 3 3 3Z',
    specup:'M4 20h16M7 20v-5m5 5V9m5 11V5m0 0h-4m4 0v4',
  };
  function symbol(key) {
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.4');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');svg.classList.add('spec-symbol');
    const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',motifs[key]||motifs.crit);svg.append(path);return svg;
  }
  for (const tab of tabs) tab.prepend(symbol(({ summary: 'combat', build: 'gems' })[tab.dataset.tab] || tab.dataset.tab));

  function appendSections(target, sections) {
    for (const section of sections || []) {
      if (section.title) target.append(element('p', 'spec-effect-title', section.title));
      target.append(entriesList(section.entries));
    }
  }

  function gridGemDescription(gem) {
    const parts = [gem.name || '이름 미확인 젬', gem.grade];
    for (const [label, value] of [['젬 포인트', gem.points], ['질서·혼돈 포인트', gem.corePoints], ['필요 의지력', gem.willpower]]) {
      if (typeof value === 'number' && Number.isFinite(value)) parts.push(`${label} ${numeric(value, 0)}`);
    }
    parts.push(gem.isActive === true ? '활성' : gem.isActive === false ? '비활성' : '활성 여부 미확인');
    return parts.filter(Boolean).join(' · ');
  }

  function renderGrid(target, grid, compact = false) {
    if (!grid || !Array.isArray(grid.cores)) return empty(target, '아크그리드 정보를 확인할 수 없어요.');
    if (!grid.cores.length) return empty(target, '장착한 아크그리드 코어가 없어요.');
    target.append(efficiencyBlock('gem', compact));
    const valuePreview = element('div', 'spec-gem-value-preview');
    valuePreview.dataset.gemValuePreview = '';
    target.append(valuePreview);
    queueMicrotask(() => valuation.refreshPreviews());
    const cores = element('div', `spec-core-grid${compact ? ' spec-core-grid-compact' : ''}`);
    for (const core of [...grid.cores].sort((a,b)=>a.slot-b.slot)) {
      const panel = element('section', 'spec-core');
      panel.dataset.grade = core.grade || '';
      panel.dataset.slot = core.slot;
      const title = element('div', 'spec-core-heading');
      const identity = element('div');
      identity.append(element(compact ? 'p' : 'h4', 'spec-core-name', core.name || '이름 미확인 코어'));
      identity.append(element('p', 'spec-core-meta', [core.grade, `코어 포인트 ${numeric(core.points, 0)}`].filter(Boolean).join(' · ')));
      title.append(itemIcon(core.icon, '코어'), identity);
      panel.append(title);
      if (Array.isArray(core.gems)) {
        if (!core.gems.length) panel.append(element('p', 'spec-core-empty', '장착 젬 없음'));
        const gems = element('ul', compact ? 'spec-core-gem-icons' : 'spec-core-gems');
        for (const gem of [...core.gems].sort((a,b)=>a.slot-b.slot)) {
          const row = element('li', 'spec-core-gem');
          row.dataset.slot = gem.slot;
          row.dataset.active = gem.isActive === true ? 'true' : gem.isActive === false ? 'false' : 'unknown';
          row.title = gridGemDescription(gem);
          row.append(itemIcon(gem.icon, '젬', true));
          if (compact) {
            row.append(element('span', 'spec-visually-hidden', gridGemDescription(gem)));
            if (gem.isActive !== true) row.append(element('span', 'spec-core-gem-state', gem.isActive === false ? '비활성' : '미확인'));
          } else {
            const body = element('div', 'spec-core-gem-body');
            body.append(element('p', 'spec-item-name', gem.name || '이름 미확인 젬'));
            body.append(element('p', 'spec-item-meta', [gem.grade, gem.isActive === true ? '활성' : gem.isActive === false ? '비활성' : '활성 여부 미확인'].filter(Boolean).join(' · ')));
            const metrics = element('dl', 'spec-grid-gem-metrics');
            for (const [label, value] of [['젬 포인트', gem.points], ['질서·혼돈 포인트', gem.corePoints], ['필요 의지력', gem.willpower]]) {
              if (typeof value === 'number' && Number.isFinite(value)) metrics.append(descriptionRow(label, numeric(value, 0)));
            }
            if (metrics.childElementCount) body.append(metrics);
            if (gem.sections?.length) {
              const details = element('details', 'spec-item-extra');
              details.append(element('summary', '', '젬 옵션'));
              appendSections(details, gem.sections);
              body.append(details);
            }
            row.append(body);
          }
          gems.append(row);
        }
        panel.append(gems);
      } else panel.append(element('p', 'spec-core-empty', '젬 정보 미확인'));
      if (!compact && core.sections?.length) {
        const details = element('details', 'spec-item-extra spec-core-effects');
        details.append(element('summary', '', '코어 옵션'));
        details.append(element('p', 'spec-item-meta', '포인트별 조건을 포함한 전체 옵션입니다.'));
        appendSections(details, core.sections);
        panel.append(details);
      }
      cores.append(panel);
    }
    target.append(cores);
    if (!compact) {
      target.append(element('h4', 'spec-subheading', '적용 효과'));
      if (!Array.isArray(grid.effects) || !grid.effects.length) {
        target.append(element('p', 'spec-muted', Array.isArray(grid.effects) ? '적용 효과 없음' : '적용 효과 정보를 확인할 수 없어요.'));
        return;
      }
      const effects = element('div', 'spec-grid-effects');
      for (const effect of grid.effects) {
        const item = element('section', 'spec-grid-effect');
        item.append(element('h5', '', [effect.name, typeof effect.level === 'number' ? `Lv.${effect.level}` : null].filter(Boolean).join(' ')), entriesList(effect.entries));
        effects.append(item);
      }
      target.append(effects);
    }
  }

  function efficiencyBlock(type, compact = false) {
    const block = element('div', `spec-efficiency${compact ? ' spec-efficiency-compact' : ''}`);
    block.dataset.efficiency = type;
    block.dataset.compact = String(compact);
    block.setAttribute('role', 'status');
    block.setAttribute('aria-live', 'polite');
    paintEfficiency(block);
    return block;
  }

  function paintEfficiency(block) {
    block.replaceChildren();
    const type = block.dataset.efficiency;
    const compact = block.dataset.compact === 'true';
    const value = efficiencyState.data?.[type];
    const label = type === 'bracelet' ? '팔찌 추정 효율' : '젬 추정 효율';
    const top = element('div', 'spec-efficiency-top');
    top.append(element('span', 'spec-efficiency-label', label));
    let message;
    if (efficiencyState.status === 'ready' && value?.status === 'ok' && typeof value.efficiency === 'number' && Number.isFinite(value.efficiency)) {
      top.append(element('strong', '', percent(value.efficiency)));
    } else {
      message = efficiencyState.status === 'error' ? efficiencyState.message
        : efficiencyState.status !== 'ready' ? '확인 중'
          : value?.status === 'absent' ? (type === 'bracelet' ? '팔찌 미장착' : '장착 젬 없음')
            : value?.status === 'unsupported' ? '지원되지 않는 세팅' : '계산 자료 확인 필요';
      top.append(element('span', 'spec-efficiency-state', message));
    }
    block.append(top);
    if (efficiencyState.status === 'ready') {
      if (type === 'bracelet' && efficiencyState.data?.braceletExpectation?.status === 'ok') {
        const result = efficiencyState.data.braceletExpectation;
        const amount = element('div', 'spec-efficiency-top spec-bracelet-value-head');
        amount.dataset.targetKey = result.targetKey;
        block.append(amount); paintBraceletValue(amount);
      } else if (type === 'bracelet') {
        const result = efficiencyState.data?.braceletExpectation;
        block.append(element('p', 'spec-efficiency-source', `팔찌 환산 가치 · ${result?.reason || '확률 자료 확인 필요'}`));
      }
      block.append(element('p', 'spec-efficiency-source', summaryData.details?.source === 'saved'
        ? '저장된 장착 정보 · 자체 계산' : '현재 장착 정보 · 자체 계산'));
      if (!compact && type === 'gem' && value?.status === 'ok') {
        const split = element('dl', 'spec-efficiency-split');
        for (const [label, number] of [['옵션 효율', value.optionEfficiency], ['포인트 효율', value.pointEfficiency]]) {
          if (typeof number === 'number' && Number.isFinite(number)) split.append(descriptionRow(label, percent(number)));
        }
        if (split.childElementCount) block.append(split);
        if (Array.isArray(value.effectEfficiencies) && value.effectEfficiencies.length) {
          const details = element('details', 'spec-item-extra');
          details.append(element('summary', '', '옵션별 실효율'));
          const list = element('ul', 'spec-efficiency-options');
          for (const effect of value.effectEfficiencies) {
            const row = element('li');
            row.append(element('span', '', `${effect.name || '옵션'}${typeof effect.level === 'number' ? ` Lv.${effect.level}` : ''}`), element('span', '', `효과 ${percent(effect.effect)} · 추정 ${percent(effect.efficiency)}`));
            list.append(row);
          }
          details.append(list);
          block.append(details);
        }
      }
      if (!compact && value) appendEfficiencyMethod(block, value);
      if (!compact && type === 'bracelet') appendBraceletExpectation(block, efficiencyState.data?.braceletExpectation);
      if (!compact && Number.isFinite(efficiencyState.data?.calculatedAt)) {
        block.append(element('p', 'spec-efficiency-source', `계산 확인 ${new Date(efficiencyState.data.calculatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })} · 한국 시간`));
      }
    }
    if (efficiencyState.status === 'error' && efficiencyState.code !== 'efficiency_not_configured' && summaryData.details?.source !== 'saved') {
      const retry = element('button', 'spec-efficiency-retry', '다시 조회');
      retry.type = 'button';
      retry.addEventListener('click', () => loadEfficiency(summaryData.profile?.characterName, generation));
      block.append(retry);
    }
  }

  function appendEfficiencyMethod(block, value) {
    const details = element('details', 'spec-efficiency-method');
    details.append(element('summary', '', '계산식과 적용 조건'));
    if (Array.isArray(value.formulas) && value.formulas.length) {
      const rows = element('dl', 'spec-efficiency-formulas');
      for (const item of value.formulas.slice(0, 40)) {
        const row = element('div');
        row.append(element('dt', '', item.label || '계산 항목'));
        const formula = element('dd');
        formula.append(element('code', '', item.formula || ''));
        if (typeof item.value === 'number' && Number.isFinite(item.value)) formula.append(element('span', '', ` = ${numeric(item.value, 4)}`));
        row.append(formula); rows.append(row);
      }
      details.append(rows);
    }
    if (Array.isArray(value.assumptions) && value.assumptions.length) {
      const list = element('ul', 'spec-efficiency-notes');
      for (const note of value.assumptions.slice(0, 40)) list.append(element('li', '', note));
      details.append(list);
    }
    if (Array.isArray(value.omitted) && value.omitted.length) {
      details.append(element('p', 'spec-efficiency-omitted-label', '합계에 포함하지 않은 효과'));
      const list = element('ul', 'spec-efficiency-notes');
      for (const note of value.omitted.slice(0, 40)) list.append(element('li', '', typeof note === 'string' ? note : note.text || note.reason || '조건 미확인'));
      details.append(list);
    }
    block.append(details);
  }

  function appendBraceletExpectation(block, result) {
    const details = element('details', 'spec-efficiency-method spec-bracelet-expectation');
    details.append(element('summary', '', '환산 가치 계산 · 뽑기 기대값'));
    const tierThree = result?.tier === 3;
    if (result?.status !== 'ok' || result.reconversionTickets !== (tierThree ? 0 : 3) || result.totalRolls !== (tierThree ? 4 : 7) ||
        !Number.isFinite(result.successProbability) || !Number.isFinite(result.expectedStartingBracelets)) {
      details.append(element('p', 'spec-efficiency-source', result?.reason || '확률 정보를 확인할 수 없습니다.'));
      block.append(details); return;
    }
    const name = efficiencyState.data?.characterName;
    const current = generation;
    details.append(element('p', '', '같은 고정 옵션 종류·부여 슬롯의 팔찌에서 현재 부여 옵션을 같은 수치 이상으로 뽑는 기준입니다. 시작 팔찌 가격은 아래에 표시한 특성 범위의 매물로 계산합니다.'));
    const target = element('ul', 'spec-efficiency-notes');
    for (const option of (result.target || []).slice(0, 5)) target.append(element('li', '', `${option.fixed ? '시작 조건' : '목표'} · ${option.text}`));
    details.append(target);
    const metrics = element('dl', 'spec-efficiency-split');
    const probability = value => value > 0 && value < 0.00000001 ? `${(value * 100).toExponential(2)}%` : `${numeric(value * 100, 8)}%`;
    metrics.append(descriptionRow(`팔찌 1개 성공 확률 · 최대 ${tierThree ? 4 : 7}회`, probability(result.successProbability)),
      descriptionRow('평균 시작 팔찌', `${numeric(result.expectedStartingBracelets, 2)}개`),
      descriptionRow('성공까지 평균 부여 횟수', `${numeric(result.expectedRollsUntilSuccess, 2)}회`));
    if (!tierThree && Number.isFinite(result.expectedReconversionTicketsUntilSuccess)) {
      metrics.append(descriptionRow('성공까지 평균 재변환권', `${numeric(result.expectedReconversionTicketsUntilSuccess, 2)}개`));
    }
    details.append(metrics);
    const valuation = element('div', 'spec-bracelet-valuation');
    valuation.dataset.targetKey = result.targetKey;
    valuation.setAttribute('aria-live', 'polite'); details.append(valuation);
    paintBraceletValue(valuation);
    details.addEventListener('toggle', () => {
      if (details.open) loadBraceletValue(name, result.targetKey, current);
    });
    details.append(element('p', 'spec-efficiency-source', '목표를 충족한 옵션은 잠그고 나머지를 모두 재변환합니다. 성공하면 멈춥니다. 평균값이므로 실제 필요한 횟수는 달라집니다.'),
      element('p', 'spec-efficiency-source', tierThree
        ? '환산 가치 = 경매장 기준 팔찌 가격 × 평균 시작 팔찌 수. 3티어는 기본 4회를 사용하며 재변환권을 적용하지 않습니다. 페온·실링은 포함하지 않습니다.'
        : '환산 가치 = 경매장 기준 팔찌 가격 × 평균 시작 팔찌 수. 기본 4회와 재변환권 최대 3개를 사용합니다. 재변환권 구매 비용·페온·실링은 포함하지 않습니다.'));
    const first = element('p', 'spec-efficiency-source', `첫 부여에서 한 번에 성공할 확률 ${probability(result.initialGrantProbability)} · 공식 확률표 ${result.dataVersion}`);
    const source = element('a', '', '공식 확률표');
    source.href = `https://lostark.game.onstove.com/Probability/%ED%8C%94%EC%B0%8C%20T${tierThree ? 3 : 4}`; source.target = '_blank'; source.rel = 'noopener noreferrer';
    first.append(document.createTextNode(' · '), source); details.append(first); block.append(details);
  }

  function savedBraceletRecord(data) {
    const record = data?.record;
    return record && record.characterName?.toLowerCase() === data.characterName?.toLowerCase() && record.targetKey === data.targetKey &&
      record.policyVersion === (data.tier === 3 ? 'bracelet-t3-no-reconversion-v1:bounded-combat-v1:log2sd-v1' : 'bracelet-three-reconversion-v2:bounded-combat-v1:log2sd-v1') &&
      Number.isFinite(record.costExpectedGold) && record.costExpectedGold > 0 && Number.isSafeInteger(record.recordedAt) && record.recordedAt >= 0 && record.recordedAt <= Date.now()
      ? record : null;
  }

  function paintBraceletValue(block) {
    block.replaceChildren();
    const state = braceletValueState;
    const record = savedBraceletRecord(state.data);
    if (block.classList.contains('spec-bracelet-value-head')) {
      block.append(element('span', 'spec-efficiency-label', record ? '팔찌 환산 가치 · 최고 기록' : '팔찌 환산 가치'));
      if (state.targetKey === block.dataset.targetKey && state.status === 'ready' && (record || state.data?.status === 'ok' && Number.isFinite(state.data.costExpectedGold))) {
        block.append(element('strong', '', `${numeric(record?.costExpectedGold ?? state.data.costExpectedGold, 0)} G`));
        if (!record) block.append(element('span', 'spec-efficiency-state', '현재 계산값 · 최고 기록 저장 안 됨'));
      } else {
        const text = summaryData.details?.source === 'saved' ? '최신화 후 확인'
          : state.retrying ? '가격 자동 재조회 대기 중'
          : state.targetKey !== block.dataset.targetKey || ['idle', 'loading'].includes(state.status) ? '매물 확인 중'
          : state.status === 'error' ? '가격 조회 필요' : '비교 매물 확인 필요';
        block.append(element('span', 'spec-efficiency-state', text));
      }
      return;
    }
    if (state.targetKey !== block.dataset.targetKey || state.status === 'idle') {
      block.append(element('p', 'spec-efficiency-source', '경매장 조건 매물의 기준 가격을 조회합니다.')); return;
    }
    if (state.status === 'loading') {
      block.append(element('p', 'spec-efficiency-source', state.retrying
        ? '첫 가격 조회가 지연되어 잠시 후 자동으로 다시 확인합니다.'
        : '조건에 맞는 경매장 매물의 가격 분포를 확인하고 있어요.')); return;
    }
    if (state.status === 'error') {
      block.append(element('p', 'spec-efficiency-source', state.message));
      if (summaryData.details?.source === 'saved') return;
      const retry = element('button', 'spec-efficiency-retry', '가격 다시 조회'); retry.type = 'button';
      retry.addEventListener('click', () => loadBraceletValue(state.name, state.targetKey, generation, true));
      block.append(retry); return;
    }
    const data = state.data, price = data?.price;
    if (record) {
      const saved = element('dl', 'spec-efficiency-split');
      saved.append(descriptionRow('현재 팔찌 최고 환산 가치', `${numeric(record.costExpectedGold, 0)} G`));
      block.append(saved, element('p', 'spec-efficiency-source', `최고 기록 ${new Date(record.recordedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })} · 같은 팔찌에서 더 높은 값이 계산될 때만 갱신합니다.`));
    }
    if (data?.recordStatus === 'unavailable') block.append(element('p', 'spec-efficiency-source', '최고 기록을 저장하거나 읽지 못했습니다. 현재 계산값과 저장 기록은 다를 수 있습니다.'));
    const conditions = price?.conditions;
    const comparisonLabel = price?.comparison === 'exact' ? '동일 수치 매물' : '유사 특성 매물';
    if (Array.isArray(conditions?.fixed)) {
      const fixed = conditions.fixed.filter(option => option.used !== false).map(option => option.operator === 'any' ? `${option.name} 수치 무관`
        : `${option.name} ${option.min === option.max ? numeric(option.value, 0) : `${numeric(option.min, 0)}~${numeric(option.max, 0)}`}`).join(' · ');
      block.append(element('p', 'spec-efficiency-source', `${comparisonLabel} · ${conditions.grade} T${conditions.tier} · 고정 ${conditions.fixedCount} / 부여 ${conditions.grantedCount} · ${fixed}`));
      if (price.relaxation === 'stats-only') block.append(element('p', 'spec-efficiency-source', '같은 조건의 매물이 없어 체력·특수 효과 조건을 빼고 조회했어요.'));
      else if (price.relaxation === 'stats-only-main-any') block.append(element('p', 'spec-efficiency-source', '같은 수치의 힘·민첩·지능 매물이 없어 주 스탯 수치를 빼고 특성 기준으로 조회했어요.'));
      if (conditions.fixed.some(option => option.used === false)) {
        const count = price.coreMismatchExcludedCount > 0 ? ` (${numeric(price.coreMismatchExcludedCount, 0)}개)` : '';
        block.append(element('p', 'spec-efficiency-source', `빠진 자리에 다른 전투 특성이나 힘·민첩·지능이 붙은 매물은 제외했어요.${count}`));
      }
    }
    if (data?.status !== 'ok' || !Number.isFinite(price?.meanGold) || !Number.isFinite(data.costExpectedGold)) {
      block.append(element('p', 'spec-efficiency-source', data?.reason || '표시한 특성 범위의 매물 가격을 확인할 수 없습니다.')); return;
    }
    const rows = element('dl', 'spec-efficiency-split');
    rows.append(descriptionRow(`${comparisonLabel} 평균`, `${numeric(price.meanGold, 0)} G`),
      descriptionRow('현재 시세 기준 환산 가치', `${numeric(data.costExpectedGold, 0)} G`),
      descriptionRow('사용한 매물 · 가격 이상치 제외', `${numeric(price.usedCount, 0)}개 · ${numeric(price.excludedCount, 0)}개`));
    block.append(rows);
    if (price.usedCount === 1) block.append(element('p', 'spec-efficiency-source', '조건에 맞는 매물이 1개여서 해당 매물 가격을 참고값으로 표시합니다.'));
    else if (price.lowSample) block.append(element('p', 'spec-efficiency-source', '표본이 10개 미만인 참고 가격입니다. 소수 매물에 따라 크게 달라질 수 있어요.'));
    const sampling = price.samplingMethod === 'all-listings' ? `조건 매물 ${numeric(price.totalCount, 0)}개를 조회했습니다.`
      : `조건 매물 ${numeric(price.totalCount, 0)}개 중 가격 순위별 최대 50개를 표본으로 조회했습니다.`;
    block.append(element('p', 'spec-efficiency-source', sampling + ' 로그 가격 평균 ±2표본표준편차 밖을 제외하고, 남은 등록 매물 가격을 평균 냅니다. 거래 완료 가격은 아닙니다.'));
    if (price.omittedTailCount > 0) block.append(element('p', 'spec-efficiency-source', `구간별 표본 수를 맞추기 위해 마지막 불완전 페이지 ${numeric(price.omittedTailCount, 0)}개는 표본에서 제외했습니다.`));
    if (Number.isFinite(price.checkedAt)) block.append(element('p', 'spec-efficiency-source', `공식 경매장 · ${new Date(price.checkedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })} 조회`));
  }

  async function loadBraceletValue(name, targetKey, current, retry = false, attempt = 0) {
    if (!accessApproved || current !== generation || !validName(name) || !/^[a-f0-9]{64}$/.test(targetKey || '')) return;
    if (summaryData.details?.source === 'saved') {
      braceletValueState = { status: 'error', name, targetKey,
        message: '저장된 장비를 표시 중입니다. 최신 장비·시세를 확인한 뒤 환산 가치를 보여드립니다.' };
      document.querySelectorAll('.spec-bracelet-valuation, .spec-bracelet-value-head').forEach(paintBraceletValue);
      return;
    }
    if (braceletValueState.targetKey === targetKey && (braceletValueState.status === 'loading' || (!retry && braceletValueState.status !== 'idle'))) return;
    braceletValueController?.abort();
    const controller = new AbortController(); braceletValueController = controller;
    braceletValueState = { status: 'loading', name, targetKey };
    const paint = () => document.querySelectorAll('.spec-bracelet-valuation, .spec-bracelet-value-head').forEach(paintBraceletValue);
    paint();
    const timer = setTimeout(() => controller.abort(), 30000);
    let readingResponse = true;
    try {
      const response = await fetch(`/api/character/bracelet-value?${new URLSearchParams({ name })}`, {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' },
      });
      if ([401, 403].includes(response.status) && current === generation) denyAccess(response.status);
      const data = await response.json().catch(error => {
        if (!response.ok) error.status = response.status;
        throw error;
      });
      readingResponse = false;
      if (!accessApproved || current !== generation || controller.signal.aborted) return;
      if (!response.ok) throw Object.assign(new Error('Price unavailable'), { code: data?.error, status: response.status });
      if (data?.characterName?.toLowerCase() !== name.toLowerCase() || data.targetKey !== targetKey) throw Object.assign(new Error('Equipment changed'), { code: 'equipment_changed' });
      if (data.record && !savedBraceletRecord(data)) throw Object.assign(new Error('Record policy changed'), { code: 'price_basis_changed' });
      if (data.status === 'ok') {
        const price = data.price, conditions = price?.conditions;
        const combatNames = ['치명', '특화', '신속', '제압', '인내', '숙련'], mainStatNames = ['힘', '민첩', '지능'];
        const validOption = option => {
          if (typeof option?.name !== 'string' || !option.name || option.name.length > 80 || !Number.isFinite(option.value) || option.value <= 0 || typeof option.used !== 'boolean') return false;
          // Options left out of the relaxed search carry no bounds; an any-value main stat carries its whole official range.
          if (!option.used) return option.operator === 'any' && option.min === null && option.max === null && !combatNames.includes(option.name) && !mainStatNames.includes(option.name);
          if (option.operator === 'any') return mainStatNames.includes(option.name) && Number.isInteger(option.min) && Number.isInteger(option.max) && option.min < option.max && option.value >= option.min && option.value <= option.max;
          let min = option.value, max = option.value;
          if (combatNames.includes(option.name)) {
            const floor = conditions.grade === '고대' ? 61 : 41, ceiling = conditions.grade === '고대' ? 120 : 100;
            if (!Number.isInteger(option.value) || option.value < floor || option.value > ceiling) return false;
            const tolerance = Math.min(5, ceiling - option.value);
            min = Math.max(floor, option.value - tolerance); max = option.value + tolerance;
          }
          return option.min === min && option.max === max && option.operator === (min === max ? '=' : 'range');
        };
        const anyMainStat = Array.isArray(conditions?.fixed) ? conditions.fixed.filter(option => option?.used === true && option.operator === 'any').length : -1;
        if (price?.basisVersion !== 'bounded-combat-v2' || !['exact', 'nearby'].includes(price?.comparison) || !['none', 'stats-only', 'stats-only-main-any'].includes(price?.relaxation) ||
            !Number.isInteger(price.coreMismatchExcludedCount) || price.coreMismatchExcludedCount < 0 ||
            conditions?.tier !== (data.tier === 3 ? 3 : 4) || !['고대', '유물'].includes(conditions?.grade) ||
            ![1, 2].includes(conditions.fixedCount) || ![1, 2, 3].includes(conditions.grantedCount) ||
            !Array.isArray(conditions.fixed) || conditions.fixed.length !== conditions.fixedCount ||
            conditions.fixed.some(option => !validOption(option)) ||
            (price.relaxation === 'none' && conditions.fixed.some(option => option.operator === 'any')) ||
            (price.relaxation === 'stats-only' && anyMainStat !== 0) || (price.relaxation === 'stats-only-main-any' && anyMainStat !== 1) ||
            price.comparison !== (conditions.fixed.some(option => option.used && option.min !== option.max) ? 'nearby' : 'exact')) {
          throw Object.assign(new Error('Price basis changed'), { code: 'price_basis_changed' });
        }
      } else if (!['unavailable', 'no_listings'].includes(data.status) || data.costExpectedGold !== null) {
        throw Object.assign(new Error('Unknown valuation state'), { code: 'price_basis_changed' });
      }
      braceletValueState = { status: 'ready', name, targetKey, data };
    } catch (error) {
      if (!accessApproved || current !== generation || braceletValueController !== controller) return;
      const status = error.status;
      const transient = [429, 502, 503, 504].includes(status) || readingResponse && ['TypeError', 'AbortError'].includes(error.name);
      const delays = status === 429 ? BRACELET_RETRY_DELAYS_LIMITED : BRACELET_RETRY_DELAYS;
      if (!retry && transient && attempt < delays.length) {
        braceletValueState = { status: 'loading', name, targetKey, retrying: true };
        braceletValueRetryTimer = setTimeout(() => {
          braceletValueRetryTimer = null;
          if (!accessApproved || current !== generation || braceletValueState.name !== name || braceletValueState.targetKey !== targetKey) return;
          braceletValueState = { status: 'idle' };
          void loadBraceletValue(name, targetKey, current, false, attempt + 1);
        }, delays[attempt]);
        return;
      }
      // 사유를 남겨 두면 "다시 조회"가 필요했던 이유를 화면과 콘솔에서 바로 알 수 있다.
      const reason = [error.code, Number.isInteger(status) ? `HTTP ${status}` : error.name === 'AbortError' ? '시간 초과' : null].filter(Boolean).join(' · ');
      console.warn('[팔찌 환산 가치] 조회 실패', { name, attempt, retry, code: error.code ?? null, status: status ?? null, error: error.message });
      braceletValueState = { status: 'error', name, targetKey, message: (error.code === 'equipment_changed' ? '장착 정보가 달라졌어요. 캐릭터를 다시 검색해 주세요.'
        : /rate_limited/.test(error.code || '') ? '조회가 많습니다. 잠시 후 가격을 다시 조회해 주세요.' : '매물 가격을 조회하지 못했어요. 잠시 후 다시 시도해 주세요.') + (reason ? ` (${reason})` : '') };
    } finally {
      clearTimeout(timer);
      if (braceletValueController === controller) braceletValueController = null;
      if (current === generation && accessApproved) paint();
    }
  }

  function paintEfficiencies() {
    document.querySelectorAll('[data-efficiency]').forEach(paintEfficiency);
  }

  function loadInitialBraceletValue(name, current) {
    const expectation = efficiencyState.data?.braceletExpectation;
    if (efficiencyState.status === 'ready' && expectation?.status === 'ok') {
      void loadBraceletValue(name, expectation.targetKey, current);
    }
  }

  const TIER_KEYS = ['iron', 'bronze', 'silver', 'gold', 'platinum', 'diamond', 'master', 'grandmaster', 'challenger', 'esther'];
  // 전용 그림(src/tier-art.js와 같은 목록): 문양·칭호판 파일만 바뀌고 티어·순위·문구는 실제 티어 그대로다. 칭호판 원본 크기가 다르다.
  const CUSTOM_TIER_ART = { dream: { plate: [960, 384] } };
  function validTierArt(art) {
    return art === undefined || art === null || (art && typeof art === 'object' && typeof art.key === 'string' && /^[a-z]{3,12}$/.test(art.key));
  }
  function validTier(tier) {
    return tier && typeof tier === 'object' && ['ok', 'unavailable'].includes(tier.status) && (tier.key === null || TIER_KEYS.includes(tier.key))
      && (tier.name === null || (typeof tier.name === 'string' && tier.name.length <= 12)) && ['lopec', 'sample', 'fixed'].includes(tier.basis)
      && (tier.percentile === null || (Number.isFinite(tier.percentile) && tier.percentile > 0 && tier.percentile <= 100)) && validTierArt(tier.art);
  }
  function validScoreRecord(record) {
    return record && typeof record === 'object' && Number.isFinite(record.score) && record.score > 0 && ['dealer', 'support'].includes(record.role)
      && Number.isSafeInteger(record.recordedAt) && record.recordedAt >= 0 && typeof record.current === 'boolean';
  }
  async function loadTier(name, current, delivered) {
    if (!accessApproved || !validName(name) || current !== generation) return;
    if (validTier(delivered)) { tierState = { status: 'ready', data: delivered }; renderProfileKpis(); return; }
    if (tierState.status === 'loading' || tierState.status === 'ready') return;
    tierController?.abort();
    const controller = new AbortController();
    tierController = controller;
    tierState = { status: 'loading' };
    renderProfileKpis();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`/api/character/efficiency?${new URLSearchParams({ name })}`, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' },
      });
      if ([401, 403].includes(response.status) && current === generation) denyAccess(response.status);
      const data = await response.json();
      if (current !== generation) return;
      if (!response.ok || typeof data?.characterName !== 'string' || data.characterName.toLowerCase() !== name.toLowerCase() || !validTier(data.tier)) throw new Error('Tier unavailable');
      tierState = { status: 'ready', data: data.tier };
      scoreRecordState = validScoreRecord(data.scoreRecord) ? data.scoreRecord : null;
    } catch {
      if (current !== generation) return;
      tierState = { status: 'error' };
    } finally {
      clearTimeout(timer);
      if (tierController === controller) tierController = null;
      if (current === generation) renderProfileKpis();
    }
  }

  async function loadEfficiency(name, current) {
    if (!accessApproved || !validName(name) || current !== generation || efficiencyState.status === 'loading') return;
    if (!summaryData.details?.bracelet && !summaryData.details?.arkgrid?.cores?.length) return;
    const local = summaryData.details?.efficiency;
    if (local?.source === 'official-api' && local.characterName?.toLowerCase() === name.toLowerCase() && local.bracelet && local.gem) {
      efficiencyState = { status: 'ready', data: local };
      paintEfficiencies();
      loadInitialBraceletValue(name, current);
      void loadTier(name, current, local.tier);
      return;
    }
    if (summaryData.details?.source === 'saved') {
      efficiencyState = { status: 'error', code: 'saved_calculation_unavailable', message: '저장된 계산 정보가 없습니다.' };
      paintEfficiencies();
      return;
    }
    if (efficiencyController) efficiencyController.abort();
    const controller = new AbortController();
    efficiencyController = controller;
    efficiencyState = { status: 'loading' };
    paintEfficiencies();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`/api/character/efficiency?${new URLSearchParams({ name })}`, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' },
      });
      if ([401, 403].includes(response.status) && current === generation) denyAccess(response.status);
      const data = await response.json();
      if (current !== generation) return;
      if (!response.ok) throw Object.assign(new Error('Efficiency unavailable'), { code: data?.error });
      if (!data || typeof data.characterName !== 'string' || data.characterName.toLowerCase() !== name.toLowerCase() || !data.bracelet || !data.gem) throw new Error('Invalid efficiency response');
      efficiencyState = { status: 'ready', data };
      scoreRecordState = validScoreRecord(data.scoreRecord) ? data.scoreRecord : null;
      void loadTier(name, current, data.tier);
    } catch (error) {
      if (current !== generation) return;
      const code = error.code;
      const message = ['efficiency_rate_limited', 'character_rate_limited'].includes(code) ? '잠시 후 다시 조회해 주세요'
        : code === 'efficiency_not_configured' ? '조회 준비 중' : '조회할 수 없어요';
      efficiencyState = { status: 'error', code, message };
    } finally {
      clearTimeout(timer);
      if (efficiencyController === controller) efficiencyController = null;
      if (current === generation) {
        paintEfficiencies();
        loadInitialBraceletValue(name, current);
      }
    }
  }

  function refinementRows(item) {
    if (!['목걸이', '귀걸이', '반지'].includes(item.type) || !Array.isArray(item.refinementOptions)) return [];
    return item.refinementOptions.slice(0, 32).filter(option => typeof option?.text === 'string' && option.text);
  }
  function refinementSummary(options) {
    const summary = element('span', 'spec-refinement-summary');
    options.forEach((option, index) => {
      if (index) summary.append(document.createTextNode(' · '));
      const grade = ['하', '중', '상'].includes(option.grade) ? option.grade : null;
      const text = option.shortName ? `${option.shortName} ${grade || '미확인'}` : option.text;
      const effect = element('span', 'spec-refinement-option', text);
      effect.dataset.grade = grade === '상' ? 'high' : grade === '중' ? 'middle' : grade === '하' ? 'low' : 'unknown';
      effect.title = option.text;
      summary.append(effect);
    });
    return summary;
  }
  function compactGear(items) {
    const list=element('ul','spec-summary-equipment-list');
    for(const item of items){const row=element('li');const body=element('div','spec-summary-item-body');
      body.append(element('span','spec-item-label',item.type||'장비'));
      const options = refinementRows(item);
      if (options.length) {
        const details = element('details', 'spec-refinement-detail');
        const summary = element('summary');
        summary.append(refinementSummary(options), element('span', 'spec-visually-hidden', ' — 연마 수치 상세'));
        details.append(summary, element('p', 'spec-summary-item-name', item.name || '이름 정보 없음'), entriesList(options));
        body.append(details);
      } else body.append(element('p','spec-summary-item-name',item.name||'이름 정보 없음'));
      const quality=element('span','spec-summary-quality',typeof item.quality==='number'?numeric(item.quality,0):'—');
      quality.setAttribute('aria-label',typeof item.quality==='number'?`품질 ${numeric(item.quality,0)}`:'품질 정보 없음');quality.title=quality.getAttribute('aria-label');
      quality.dataset.grade=typeof item.quality==='number'?(item.quality>=90?'high':item.quality>=70?'good':'normal'):'unknown';
      row.append(itemIcon(item.icon,item.type,true),body,quality);row.title=item.name||item.type||'';list.append(row);}
    return list;
  }
  function renderCards(target, cards, compact=false) {
    if(!cards||!Array.isArray(cards.items))return empty(target,'카드 정보 없음');
    if(!cards.items.length)return empty(target,'장착 카드 없음');
    const list=element('ul','spec-card-deck');
    for(const card of cards.items){const li=element('li');li.append(itemIcon(card.icon,card.name));li.title=card.name||'카드';li.append(element('span',compact?'spec-visually-hidden':'spec-card-name',card.name||'카드'));
      if(typeof card.awakeCount==='number')li.append(element('span','spec-card-awake',`각성 ${card.awakeCount}`));list.append(li);}
    target.append(list);
    const sets=element('div','spec-card-effects');
    for(const set of cards.sets||[]){const entries=set.items||[];
      if(compact&&entries.length){
        sets.append(element('p','spec-card-set-name',entries.at(-1).name||'카드 세트'));
        const effects=element('ul','spec-card-compact-effects');
        for(const item of entries){const stage=item.name?.match(/(\d+)세트(?:\s*\((\d+)각성합계\))?$/);const label=stage?(stage[2]?`${stage[2]}각성`:`${stage[1]}세트`):item.name||'세트';
          for(const effect of item.effects||[]){if(!effect.text)continue;const row=element('li');row.append(element('span','',label),element('span','',`${effect.text}${effect.truncated?' …':''}`));effects.append(row);}}
        sets.append(effects);
      }else for(const item of entries){sets.append(element('p','spec-card-set-name',item.name||'카드 세트'));sets.append(entriesList(item.effects));}}
    if(sets.childElementCount)target.append(sets);
  }
  function renderSummary() {
    const data=summaryData.details;
    const refinementsOpen=content('summary').querySelector('.spec-summary-refinements')?.open ?? true;
    const stableFocus=document.activeElement?.closest('[data-summary-focus]')?.dataset.summaryFocus;
    const focused=document.activeElement?.closest('.spec-summary-link')?.dataset.summaryTitle;
    const refinementState = [...content('summary').querySelectorAll('.spec-refinement-detail')]
      .map(details => ({ open: details.open, focused: details.contains(document.activeElement) }));
    const card=(title,tab,render,key)=>{const section=summaryCard(title,tab,render,key);section.querySelector('.spec-summary-heading').prepend(symbol(key));return section;};
    content('summary').replaceChildren(
      card('캐릭터 정보',null,target=>{
        const profile=summaryData.profile;
        if(!profile)return empty(target,'캐릭터 정보를 확인하고 있어요.');
        const list=element('dl','spec-character-facts');
        const roster=summaryData.roster?.roster?.characters;
        for(const [label,value,icon] of [['서버',profile.serverName,'server'],['클래스',profile.characterClass,'identity'],['칭호',profile.title,'crit'],['길드',profile.guildName||'가입 길드 없음','guild'],['원정대',`Lv.${numeric(profile.expeditionLevel,0)}`,'roster'],['보유 캐릭터',Array.isArray(roster)?`${roster.length}명`:'확인 중','identity'],['공식 전투력',numeric(profile.combatPower),'combat']]){
          const row=descriptionRow(label,value||'—');row.querySelector('dt').prepend(symbol(icon));list.append(row);
        }
        target.append(list);
        const links=element('div','spec-character-links');
        const armory=element('a','spec-action','로스트아크');armory.href=`https://lostark.game.onstove.com/Profile/Character/${encodeURIComponent(profile.characterName)}`;armory.target='_blank';armory.rel='noopener noreferrer';armory.setAttribute('aria-label','로스트아크 캐릭터 정보 (새 탭)');
        const rosterLink=element('button','spec-action','원정대 보기');rosterLink.type='button';rosterLink.addEventListener('click',()=>selectTab('roster',{focus:true,updateHash:true}));
        armory.dataset.summaryFocus='official-profile';rosterLink.dataset.summaryFocus='roster';
        links.append(armory,rosterLink);target.append(links);
      },'identity'),
      card('주요 전투 능력치',null,target=>{
        if(summaryUnavailable(target,'details'))return;
        if(!Array.isArray(data.combatStats)||!data.combatStats.length)return empty(target,'전투 특성 정보 없음');
        const stats=element('dl','spec-combat-stats');
        for(const stat of data.combatStats){if(typeof stat.name!=='string'||typeof stat.value!=='number'||!Number.isFinite(stat.value))continue;const row=descriptionRow(stat.name,numeric(stat.value));row.dataset.stat=stat.name;row.prepend(symbol(({'최대 생명력':'heart','공격력':'combat','특화':'arkpassive','신속':'gems','제압':'resolve','인내':'resolve','숙련':'expertise'})[stat.name]||'crit'));stats.append(row);}
        target.append(stats);
        if(Number.isFinite(data.crit?.total)){const link=element('button','spec-combat-crit',`치명타 적중률 ${percent(data.crit.total)} →`);link.type='button';link.dataset.summaryFocus='crit';link.addEventListener('click',()=>selectTab('crit',{focus:true,updateHash:true}));target.append(link);}
      },'combat'),
      card('아크패시브','arkpassive',target=>{
        if(summaryUnavailable(target,'details'))return;const ark=data.arkpassive;
        if(!ark)return empty(target,'아크패시브 정보 없음');if(ark.isEnabled===false)return empty(target,'아크패시브 미사용');
        const points=element('div','spec-overview-points');for(const p of ark.points||[]){const n=element('div');n.append(element('b','',numeric(p.value,0)),element('span','',p.name||'포인트'));points.append(n);}target.append(points);
        const list=element('ul','spec-overview-nodes');for(const p of ark.points||[]){const effects=(ark.effects||[]).filter(e=>e.category===p.name);const li=element('li');li.append(element('b','',p.name||'노드'),element('span','',effects.slice(-2).map(e=>e.description||e.name).filter(Boolean).join(' · ')||'채용 노드 없음'));list.append(li);}target.append(list);
      },'arkpassive'),
      card('아크그리드 · 코어와 젬','arkgrid',target=>{
        if(!summaryUnavailable(target,'details'))renderGrid(target,data.arkgrid,true);
      },'arkgrid'),
      card('장비 현황','equipment',target=>{
        if(summaryUnavailable(target,'details'))return;if(!Array.isArray(data.equipment))return empty(target,'장비 정보 없음');
        const primary=data.equipment.filter(i=>['무기','투구','상의','하의','장갑','어깨','완갑'].includes(i.type));const left=primary.length?primary:data.equipment.slice(0,6);
        const list=element('ul','spec-gear-strip');
        for(const item of left){const row=element('li');row.title=item.name||item.type;const level=item.name?.match(/^\+(\d+)/)?.[1];row.append(itemIcon(item.icon,item.type),element('span','',level?`+${level}`:item.type),element('span','spec-visually-hidden',item.name||item.type));list.append(row);}target.append(list);
        if(data.accessories?.length){const detail=element('details','spec-summary-refinements');const summary=element('summary','','악세서리 연마 옵션');summary.dataset.summaryFocus='refinements';detail.append(summary,compactGear(data.accessories));target.append(detail);}
      },'equipment'),
      card('각인 설정','engravings',target=>{
        if(summaryUnavailable(target,'details'))return;const items=data.engravings?.items;if(!Array.isArray(items))return empty(target,'각인 정보 없음');if(!items.length)return empty(target,'활성 각인 없음');
        const list=element('ul','spec-summary-engraving-list');for(const item of items){const row=element('li');row.append(engravingIcon(item.icon,true),element('span','',item.name||'각인'),element('span','spec-summary-engraving-level',typeof item.level==='number'?`Lv.${item.level}`:''));list.append(row);}target.append(list);
      },'engravings'),
      card('보석 설정','build',target=>{
        if(summaryUnavailable(target,'details'))return;const gems=data.gems?.items;if(!Array.isArray(gems))return empty(target,'보석 정보 없음');if(!gems.length)return empty(target,'장착 보석 없음');
        const list=element('ul','spec-summary-gems-list');const levels=new Map();for(const gem of gems){const level=typeof gem.level==='number'&&Number.isFinite(gem.level)?gem.level:null;levels.set(level,(levels.get(level)||0)+1);const row=element('li');row.append(itemIcon(gem.icon,'보석'),element('span','spec-summary-gem-level',level===null?'?':String(level)));const name=gem.name||(level===null?'레벨 미확인 보석':`${level}레벨 보석`);row.append(element('span','spec-visually-hidden',name));row.title=name;list.append(row);}target.append(list,element('p','spec-summary-caption',[...levels].sort(([a],[b])=>(b??-1)-(a??-1)).map(([l,n])=>`${l===null?'미확인':`${l}레벨`} ${n}개`).join(' · ')));
      },'gems'),
      card('카드 효과','cards',target=>{if(!summaryUnavailable(target,'details'))renderCards(target,data.cards,true);},'cards'),
      card('팔찌 · 스톤','equipment',target=>{
        if(summaryUnavailable(target,'details'))return;
        if(data.bracelet)target.append(efficiencyBlock('bracelet',true));
        if(data.stone){const row=element('div','spec-overview-special');row.append(itemIcon(data.stone.icon,data.stone.type,true),element('b','',data.stone.name||data.stone.type));target.append(row);}
        if(!target.childElementCount)empty(target,'장착 정보 없음');
      },'accessories'),
    );
    if(focused)[...document.querySelectorAll('.spec-summary-link')].find(b=>b.dataset.summaryTitle===focused)?.focus({preventScroll:true});
    const refinements=content('summary').querySelector('.spec-summary-refinements');
    if(refinements)refinements.open=refinementsOpen;
    if(stableFocus)[...content('summary').querySelectorAll('[data-summary-focus]')].find(n=>n.dataset.summaryFocus===stableFocus)?.focus({preventScroll:true});
    content('summary').querySelectorAll('.spec-refinement-detail').forEach((details, index) => {
      details.open = refinementState[index]?.open === true;
      if (refinementState[index]?.focused) details.querySelector('summary').focus({ preventScroll: true });
    });
    renderProfileKpis();
  }

  // The lopec rank the service set aside because its record score no longer matches the current score.
  function tierReference(data) {
    const ref = data?.reason === 'lopec_record_mismatch' ? data.reference : null;
    return ref && typeof ref === 'object' && Number.isFinite(ref.score) && ref.score > 0 && Number.isFinite(ref.percentile) && ref.percentile > 0
      && ref.percentile <= 100 && typeof ref.source === 'string' && ref.source.length > 0 && ref.source.length <= 20 ? ref : null;
  }
  function tierShown() {
    const score = summaryData.details?.efficiency?.score;
    const ready = score?.status === 'ok' && Number.isFinite(score.score) && typeof score.tier?.name === 'string';
    if (!ready) return { ready: false, tier: null, basis: '', note: null, next: null };
    const data = tierState.status === 'ready' ? tierState.data : null;
    const live = data?.key ? data : score.tier;
    const reference = tierReference(data);
    const basis = data?.status === 'ok' && Number.isFinite(data.percentile)
      ? `${data.source} 기준 상위 ${topPercent(data.percentile)}`
      : reference ? '현재 장착 점수 구간 기준'
      : tierState.status === 'loading' ? '순위 확인 중' : '점수 구간 기준 · 순위 자료 없음';
    const note = reference ? `${reference.source} 최고 기록 ${numeric(reference.score, 0)}점 기준 상위 ${topPercent(reference.percentile)}` : null;
    return { ready: true, tier: live, basis, note, next: data?.status === 'ok' ? data.next : null };
  }
  function renderHeroTier() {
    const target = document.getElementById('profile-tier');
    if (!target) return;
    target.replaceChildren();
    if (!summaryData.profile) return;
    const { ready, tier, basis, note: reference, next } = tierShown();
    if (!ready || !tier?.key || !TIER_KEYS.includes(tier.key)) {
      target.append(element('p', 'spec-hero-tier-pending', summaryData.details || summaryErrors.details ? '티어를 계산할 수 없어요' : '티어 계산 중'));
      return;
    }
    // 전용 그림 대상이면 파일만 바꾼다(모르는 키는 무시). alt·문구는 실제 티어다.
    const art = tier.art && Object.hasOwn(CUSTOM_TIER_ART, tier.art.key) ? tier.art.key : null;
    const imageKey = art ?? tier.key;
    const [plateWidth, plateHeight] = art ? CUSTOM_TIER_ART[art].plate : [960, 270];
    const emblem = element('img', art ? 'spec-hero-tier-emblem spec-hero-tier-emblem--custom' : 'spec-hero-tier-emblem');
    // 문양 640px·이름판 960px 원본 축소본 — 210px 표시 영역이 고해상도 화면(2배)에서도 또렷하게 보이도록 한다.
    emblem.src = `assets/tiers/${imageKey}.png`; emblem.width = 640; emblem.height = 640; emblem.alt = ''; emblem.decoding = 'async';
    const plate = element('img', art ? 'spec-hero-tier-name spec-hero-tier-name--custom' : 'spec-hero-tier-name');
    plate.src = `assets/tiers/${imageKey}-name.png`; plate.width = plateWidth; plate.height = plateHeight; plate.alt = `${tier.name} 티어`; plate.decoding = 'async';
    const note = element('p', 'spec-hero-tier-note', [next?.name && Number.isFinite(next.percentile)
      ? `${basis} · ${next.name}까지 상위 ${topPercent(next.percentile)}` : basis, reference].filter(Boolean).join(' · '));
    target.append(emblem, plate, note);
  }

  function content(section) { return document.getElementById(`spec-${section}`); }

  function empty(target, text = '장착한 정보가 없어요.') {
    target.replaceChildren(element('p', 'spec-empty', text));
  }

  function loading(section, text = '정보를 확인하고 있어요.') {
    content(section).replaceChildren(element('p', 'spec-loading', text));
    document.getElementById(`card-${section}`).setAttribute('aria-busy', 'true');
  }

  function finished(section) {
    document.getElementById(`card-${section}`).removeAttribute('aria-busy');
  }

  function errorMessage(error) {
    if (error.code === 'character_not_found') return '캐릭터를 찾을 수 없어요. 캐릭터명을 다시 확인해 주세요.';
    if (error.code === 'character_rate_limited') return '지금은 조회가 많아 잠시 쉬고 있어요. 잠시 후 다시 조회해 주세요.';
    if (error.code === 'invalid_request') return '캐릭터명은 한글·영문·숫자 2~12자로 입력해 주세요.';
    return '게임 정보를 일시적으로 불러오지 못했어요. 잠시 후 다시 조회해 주세요.';
  }

  async function requestSection(name, section, signal) {
    if (!accessApproved) throw new Error('Site approval required');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    const timeout = setTimeout(abort, 15000);
    try {
      const query = new URLSearchParams({ name, section, refresh: '1' });
      const response = await fetch(`/api/character/spec?${query}`, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if ([401, 403].includes(response.status) && !signal.aborted) denyAccess(response.status);
      const data = await response.json();
      if (!response.ok || !data || typeof data !== 'object' || Array.isArray(data)) {
        const error = new Error('Character information unavailable');
        error.code = data?.error;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
  }

  function remember(name) {
    recent = [name, ...recent.filter((item) => item.toLowerCase() !== name.toLowerCase())].slice(0, 8);
    try { localStorage.setItem(recentKey, JSON.stringify(recent)); } catch { /* Keep this page's recent searches in memory. */ }
    renderRecent();
  }

  function renderRecent() {
    const list = document.getElementById('spec-recent-list');
    list.replaceChildren();
    for (const item of recent.slice(0, 3)) {
      const button = element('button', '', item);
      button.type = 'button';
      button.addEventListener('click', () => search(item));
      list.appendChild(button);
    }
    document.getElementById('spec-recent').hidden = recent.length === 0;
  }

  function renderFavorites() {
    const list = document.getElementById('spec-favorite-list');
    list.replaceChildren();
    for (const name of favorites) {
      const button = characterButton(name);
      list.appendChild(button);
    }
    document.getElementById('spec-favorites').hidden = favorites.length === 0;
    const name = summaryData.profile?.characterName;
    const saved = typeof name === 'string' && favorites.some((item) => item.toLowerCase() === name.toLowerCase());
    const bookmark = document.getElementById('spec-bookmark');
    bookmark.setAttribute('aria-pressed', String(saved));
    bookmark.querySelector('span').textContent = saved ? '저장됨' : '즐겨찾기';
  }

  function toggleFavorite() {
    const name = summaryData.profile?.characterName;
    if (!validName(name)) return;
    const saved = favorites.some((item) => item.toLowerCase() === name.toLowerCase());
    const message = document.getElementById('spec-action-status');
    if (!saved && favorites.length >= 8) {
      message.textContent = '즐겨찾기는 8명까지 저장할 수 있습니다. 저장된 캐릭터를 열어 즐겨찾기를 해제해 주세요.';
      return;
    }
    const next = saved ? favorites.filter((item) => item.toLowerCase() !== name.toLowerCase()) : [...favorites, name];
    try {
      localStorage.setItem(favoriteKey, JSON.stringify(next));
      favorites = next;
      renderFavorites();
      message.textContent = saved ? '즐겨찾기를 해제했습니다.' : '이 브라우저의 즐겨찾기에 저장했습니다.';
    } catch {
      message.textContent = '브라우저에서 저장을 허용하지 않아 즐겨찾기를 저장하지 못했습니다.';
    }
  }

  async function shareCharacter() {
    const name = summaryData.profile?.characterName;
    if (!validName(name)) return;
    const current = generation;
    const url = new URL(window.location.pathname, window.location.origin);
    url.searchParams.set('characterName', name);
    url.hash = `panel-${tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.dataset.tab || 'summary'}`;
    const fallback = document.getElementById('spec-share-fallback');
    const message = document.getElementById('spec-action-status');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url.href);
      if (current !== generation) return;
      fallback.hidden = true;
      message.textContent = '캐릭터와 선택한 탭의 주소를 복사했습니다.';
    } catch {
      if (current !== generation) return;
      const field = document.getElementById('spec-share-url');
      field.value = url.href;
      fallback.hidden = false;
      field.focus();
      field.select();
      message.textContent = '자동 복사를 사용할 수 없습니다. 아래 주소를 복사해 주세요.';
    }
  }

  function descriptionRow(label, value) {
    const row = element('div');
    row.append(element('dt', '', label), element('dd', '', value));
    return row;
  }

  function profileKpi(label, value, notes = [], pending = false) {
    const row = descriptionRow(label, value);
    row.className = 'spec-profile-kpi';
    row.lastElementChild.className = `spec-kpi-value${pending ? ' spec-kpi-state' : ''}`;
    for (const note of notes) if (note) row.appendChild(element('dd', 'spec-kpi-note', note));
    return row;
  }

  function renderProfileKpis() {
    const profile = summaryData.profile;
    if (!profile) return;
    const stats = document.getElementById('profile-stats');
    const power = numeric(profile.combatPower);
    const score = summaryData.details?.efficiency?.score;
    const ready = score?.status === 'ok' && Number.isFinite(score.score) && typeof score.tier?.name === 'string';
    const value = ready ? numeric(score.score, 2) : summaryData.details || summaryErrors.details ? '계산 불가' : '계산 중';
    stats.classList.toggle('spec-profile-stats-long-value', value.length > 8);
    const { tier: shown, basis, note: reference } = tierShown();
    const record = ready && scoreRecordState
      ? `최고 기록 ${numeric(scoreRecordState.score, 2)}점 · ${shortDate(scoreRecordState.recordedAt)}${scoreRecordState.current ? ' · 현재 점수' : ''}` : null;
    stats.replaceChildren(profileKpi('환산 점수', value, [ready ? [shown?.name, score.role === 'support' ? '서포터' : '딜러'].filter(Boolean).join(' · ') : '', basis, ...(reference ? [reference] : []), ...(record ? [record] : []), `공식 전투력 ${power}`], !ready));
    renderHeroTier();
    const method = document.getElementById('profile-score-method');
    method.replaceChildren();
    if (score) {
      appendEfficiencyMethod(method, score);
      method.querySelector('summary').textContent = '환산 점수 계산 기준';
      const omitted = method.querySelector('.spec-efficiency-omitted-label');
      if (omitted) omitted.textContent = '계산할 수 없는 항목';
    }
  }

  function renderProfile(profile) {
    if (!profile || typeof profile.characterName !== 'string') throw new Error('Invalid character profile');
    heading.textContent = profile.characterName;
    const portrait = document.getElementById('profile-portrait');
    portrait.replaceChildren(element('span', 'spec-portrait-fallback', profile.characterName.slice(0, 1)));
    appendImage(portrait, profile.characterImage, true);
    document.getElementById('profile-context').textContent = [profile.serverName, profile.characterClass].filter(Boolean).join(' · ');
    document.getElementById('profile-class-mark').textContent = profile.characterClass || '';
    const title = document.getElementById('profile-title');
    title.textContent = profile.title || '';
    title.hidden = !profile.title;
    document.getElementById('profile-item-level').replaceChildren(descriptionRow('아이템 레벨', numeric(profile.itemLevel)));
    document.getElementById('profile-meta').replaceChildren(
      descriptionRow('길드', profile.guildName || '가입 길드 없음'),
      descriptionRow('원정대 레벨', numeric(profile.expeditionLevel, 0)),
    );
    summaryData.profile = profile;
    renderProfileKpis();
    renderFavorites();
    results.hidden = false;
    document.body.classList.add('spec-has-result');
    placeSearchDock();
    document.querySelector('.spec-profile-more').open = true;
    remember(profile.characterName);
  }

  // 결과 화면의 좁은 검색창은 넓은 화면에서 머리말의 메뉴와 오른쪽 도구 사이 빈칸에 얹는다. 도구 폭은
  // 로그인 상태·글꼴에 따라 달라지므로 실제 빈칸을 재고, 모자라면 본문 위 제자리에 둔다(겹침 방지).
  const dockQuery = window.matchMedia('(min-width: 1220px)');
  const DOCK_GAP = 24, DOCK_MIN = 260, DOCK_MAX = 420;
  let dockObserver = null;
  function placeSearchDock() {
    const header = document.querySelector('[data-site-header]');
    const links = header ? [...header.querySelectorAll('.realm-nav > a')].filter(link => link.getClientRects().length) : [];
    const tools = header?.querySelector('.realm-header-tools');
    if (header && tools && !dockObserver && 'ResizeObserver' in window) {
      dockObserver = new ResizeObserver(() => placeSearchDock());
      dockObserver.observe(header);
      dockObserver.observe(tools);
    }
    form.style.left = form.style.top = form.style.width = '';
    let docked = false;
    if (document.body.classList.contains('spec-has-result') && dockQuery.matches && links.length && tools) {
      // 캐릭터 검색 아이콘을 먼저 숨겨야 도구 영역의 왼쪽 끝이 최종 위치가 된다.
      document.body.classList.add('spec-search-docked');
      const start = links.at(-1).getBoundingClientRect().right + DOCK_GAP;
      const end = tools.getBoundingClientRect().left - DOCK_GAP;
      const width = Math.floor(Math.min(DOCK_MAX, end - start));
      if (width >= DOCK_MIN) {
        form.style.width = `${width}px`;
        const bar = header.getBoundingClientRect(), box = form.getBoundingClientRect();
        const left = start + (end - start - width) / 2, top = bar.top + (bar.height - box.height) / 2;
        form.style.left = `${Math.round(left - box.left + form.offsetLeft)}px`;
        form.style.top = `${Math.round(top - box.top + form.offsetTop)}px`;
        docked = true;
      }
    }
    if (!docked) document.body.classList.remove('spec-search-docked');
  }

  function entriesList(entries) {
    const list = element('ul', 'spec-item-details');
    for (const entry of entries || []) {
      if (entry?.text) list.appendChild(element('li', '', `${entry.text}${entry.truncated ? ' … (긴 효과 설명 일부 생략)' : ''}`));
    }
    return list;
  }

  function renderItem(item) {
    const row = element('li', 'spec-item spec-item-with-icon');
    const body = element('div', 'spec-item-body');
    const top = element('div', 'spec-item-top');
    top.appendChild(element('span', 'spec-item-label', item.type || '장착 아이템'));
    top.appendChild(element('span', 'spec-item-meta', item.grade));
    body.append(top, element('p', 'spec-item-name', item.name || '이름 정보 없음'));
    const refinement = refinementRows(item);
    if (refinement.length) {
      const summary = element('p', 'spec-refinement-inline');
      summary.append(element('span', 'spec-visually-hidden', '연마 효과: '), refinementSummary(refinement));
      body.append(summary);
    }
    const metrics = element('div', 'spec-item-metrics');
    if (typeof item.quality === 'number' && Number.isFinite(item.quality)) {
      const quality = element('span', 'spec-quality', `품질 ${numeric(item.quality, 0)}`);
      const track = element('span', 'spec-quality-track');
      track.setAttribute('aria-hidden', 'true');
      const value = element('span', 'spec-quality-value');
      value.style.width = `${Math.max(0, Math.min(100, item.quality))}%`;
      track.appendChild(value);
      quality.appendChild(track);
      metrics.appendChild(quality);
    }
    if (typeof item.itemLevel === 'number') metrics.appendChild(element('span', 'spec-item-meta', `아이템 Lv.${numeric(item.itemLevel)}`));
    if (item.refinement && !String(item.name || '').startsWith(`+${item.refinement} `)) metrics.appendChild(element('span', 'spec-item-meta', `재련 ${item.refinement}`));
    if (metrics.childElementCount) body.appendChild(metrics);
    if (item.stats?.length) {
      body.appendChild(element('p', 'spec-item-details', item.stats.map((stat) => stat.text || `${stat.name} ${numeric(stat.value)}`).join(' · ')));
    }
    if (item.engravings?.length) {
      const effects = item.engravings.map((engraving) => ({ text: `${engraving.name || '각인'}${typeof engraving.level === 'number' ? ` Lv.${engraving.level}` : ''}${engraving.negative ? ' · 감소 효과' : ''}` }));
      body.appendChild(entriesList(effects));
    }
    row.append(itemIcon(item.icon, item.type), body);
    if (item.sections?.length || item.effects?.length) {
      const details = element('details', 'spec-item-extra');
      details.appendChild(element('summary', '', '상세 효과'));
      if (item.effects?.length) details.appendChild(entriesList(item.effects));
      for (const section of item.sections || []) {
        if (section.title) details.appendChild(element('p', 'spec-effect-title', section.title));
        details.appendChild(entriesList(section.entries));
      }
      row.appendChild(details);
    }
    return row;
  }

  function renderItems(target, items, emptyText) {
    if (!Array.isArray(items)) return empty(target, '이 장착 정보를 확인할 수 없어요.');
    if (!items.length) return empty(target, emptyText);
    const list = element('ul', 'spec-list');
    items.forEach((item) => list.appendChild(renderItem(item)));
    target.replaceChildren(list);
  }

  function renderAccessories(data) {
    const target = content('accessories');
    target.replaceChildren();
    const parts = [
      ['악세서리', data.accessories],
      ['팔찌', data.bracelet ? [data.bracelet] : Array.isArray(data.accessories) ? [] : null],
      ['어빌리티 스톤', data.stone ? [data.stone] : Array.isArray(data.accessories) ? [] : null],
    ];
    for (const [title, items] of parts) {
      const group = element('div');
      target.appendChild(element('h4', 'spec-subheading', title));
      renderItems(group, items, `장착한 ${title === '악세서리' ? '악세서리가' : title === '팔찌' ? '팔찌가' : '어빌리티 스톤이'} 없어요.`);
      target.appendChild(group);
      if(title === '팔찌' && data.bracelet) target.append(efficiencyBlock('bracelet'));
    }
  }

  function renderGems(data) {
    const target = content('gems');
    if (!data || !Array.isArray(data.items)) return empty(target, '보석 정보를 확인할 수 없어요.');
    if (!data.items.length) return empty(target, '장착한 보석이 없어요.');
    const list = element('ul', 'spec-list spec-gem-list');
    for (const gem of data.items) {
      const row = element('li', 'spec-item');
      const visual = element('div', 'spec-gem-visual');
      visual.appendChild(itemIcon(gem.icon, '보석'));
      if (typeof gem.level === 'number') visual.appendChild(element('span', 'spec-gem-level', gem.level));
      row.append(visual, element('p', 'spec-item-name', (gem.name || '보석').replace(/^\d+\s*레벨\s*/, '').replace(/의 보석$/, '')));
      const names = (gem.skills || []).map((skill) => skill.name).filter(Boolean);
      if (names.length) row.appendChild(element('p', 'spec-gem-skill', names.join(' · ')));
      const details = element('details', 'spec-item-extra');
      details.appendChild(element('summary', '', '보석 효과'));
      details.appendChild(element('p', 'spec-item-meta', [gem.name, gem.grade].filter(Boolean).join(' · ')));
      for (const skill of gem.skills || []) {
        if (skill.name) details.appendChild(element('p', 'spec-item-details', skill.name));
        details.appendChild(entriesList(skill.effects));
      }
      row.appendChild(details);
      list.appendChild(row);
    }
    target.replaceChildren(list);
    if (data.effects?.length) {
      target.appendChild(element('h4', 'spec-subheading', '보석 장착 효과'));
      target.appendChild(entriesList(data.effects));
    }
  }

  function renderEngravings(data) {
    const target = content('engravings');
    if (!data || !Array.isArray(data.items)) return empty(target, '각인 정보를 확인할 수 없어요.');
    if (!data.items.length) return empty(target, '활성화한 각인이 없어요.');
    const list = element('ul', 'spec-list');
    for (const engraving of data.items) {
      const row = element('li', 'spec-item spec-item-with-icon');
      const body = element('div', 'spec-item-body');
      const top = element('div', 'spec-item-top');
      top.append(element('p', 'spec-item-name', engraving.name || '각인'), element('span', 'spec-item-meta', typeof engraving.level === 'number' ? `Lv.${engraving.level}` : ''));
      body.appendChild(top);
      const meta = [engraving.grade];
      if (typeof engraving.abilityStoneLevel === 'number' && engraving.abilityStoneLevel > 0) meta.push(`스톤 Lv.${engraving.abilityStoneLevel}`);
      if (meta.filter(Boolean).length) body.appendChild(element('p', 'spec-item-meta', meta.filter(Boolean).join(' · ')));
      row.append(engravingIcon(engraving.icon), body);
      if (engraving.effects?.length) {
        const details = element('details', 'spec-item-extra');
        details.append(element('summary', '', '각인 효과'), entriesList(engraving.effects));
        row.appendChild(details);
      }
      list.appendChild(row);
    }
    target.replaceChildren(list);
  }

  function renderArkpassive(data) {
    const target = content('arkpassive');
    if (!data) return empty(target, '아크패시브 정보를 확인할 수 없어요.');
    target.replaceChildren();
    if (data.isEnabled === false) target.appendChild(element('p', 'spec-section-note', '아크패시브 미사용'));
    const categories = new Map();
    for (const point of data.points || []) {
      const key = point.name || '포인트';
      if (!categories.has(key)) categories.set(key, { points: [], effects: [] });
      categories.get(key).points.push(point);
    }
    for (const effect of data.effects || []) {
      const key = effect.category || '적용 효과';
      if (!categories.has(key)) categories.set(key, { points: [], effects: [] });
      categories.get(key).effects.push(effect);
    }
    const groups = element('div', 'spec-ark-categories');
    for (const [category, { points, effects }] of categories) {
      const group = element('section', 'spec-ark-category');
      const top = element('div', 'spec-ark-category-heading');
      top.appendChild(element('h4', '', category));
      for (const point of points) top.appendChild(element('strong', '', typeof point.value === 'number' ? `${numeric(point.value, 0)}P` : '정보 없음'));
      group.appendChild(top);
      for (const point of points) if (point.description) group.appendChild(element('p', 'spec-point-description', point.description));
      const list = element('ul', 'spec-list');
      for (const effect of effects) {
        const row = element('li', 'spec-item spec-ark-node');
        const body = element('div', 'spec-item-body');
        row.append(itemIcon(effect.icon, effect.name || category, true), body);
        body.appendChild(element('p', 'spec-item-name', effect.description || effect.name || '노드'));
        if (effect.effects?.length) {
          const details = element('details', 'spec-item-extra');
          details.append(element('summary', '', '효과 보기'), entriesList(effect.effects));
          body.appendChild(details);
        }
        list.appendChild(row);
      }
      if (effects.length) group.appendChild(list);
      else group.appendChild(element('p', 'spec-empty', '채용 노드 없음'));
      groups.appendChild(group);
    }
    if (categories.size) target.appendChild(groups);
    if (!target.childElementCount) empty(target, '적용 중인 아크패시브가 없어요.');
  }

  function renderCrit(data) {
    const target = content('crit');
    if (!data || typeof data.total !== 'number') return empty(target, '치명타 적중률 계산에 필요한 정보를 확인할 수 없어요.');
    const layout = element('div', 'spec-crit-layout');
    const values = element('div');
    const context = element('div');
    values.appendChild(element('p', 'spec-crit-total', percent(data.total)));
    layout.append(values, context);
    target.replaceChildren(layout);
    const breakdown = element('dl', 'spec-breakdown');
    for (const source of data.sources || []) {
      const row = descriptionRow(source.source, percent(source.value));
      if (source.details?.length) row.appendChild(element('dd', 'spec-breakdown-detail', source.details.map((item) => {
        const stacks = typeof item.stacks === 'number' && item.stacks > 1 ? ` (${percent(item.baseValue)} × ${item.stacks}중첩)` : '';
        return `${item.detail} ${percent(item.value)}${stacks}`;
      }).join(' · ')));
      breakdown.appendChild(row);
    }
    values.appendChild(breakdown);
    context.appendChild(element('p', 'spec-section-note', '파티 시너지와 별도로 표시한 조건부 효과는 총합에서 제외해요.'));
    if (data.bluntThorn) {
      const thorn = data.bluntThorn;
      const notice = element('div', 'spec-notice');
      notice.appendChild(element('strong', '', `뭉툭한 가시 Lv.${thorn.level} 채용 중`));
      if (thorn.effect && thorn.calculation) {
        notice.appendChild(element('p', '', `치적은 ${percent(thorn.effect.cap)}까지만 적용돼요.`));
        notice.appendChild(element('p', '', `진화형 피해 +${percent(thorn.calculation.evolutionDamage)}${thorn.calculation.capped ? ' · 상한 도달' : ''}`));
        notice.appendChild(element('p', 'spec-item-meta', `기본 ${percent(thorn.effect.base)} + 초과 치적 ${percent(thorn.calculation.excess)} × ${numeric(thorn.effect.rate)}% = ${percent(thorn.calculation.converted)} · 노드 상한 ${percent(thorn.effect.max)}`));
      } else notice.appendChild(element('p', '', '노드 효과를 확인할 수 없어 진화형 피해 계산을 생략했어요.'));
      context.appendChild(notice);
    }
    const labels = { identities: '아이덴티티', nodes: '조건부 노드', derived: '다른 특성에 따른 효과', synergies: '치적 시너지', replacements: '효과 대체', skills: '스킬 효과' };
    const conditional = element('details', 'spec-item-extra');
    conditional.appendChild(element('summary', '', '총합에 더하지 않은 조건부 효과'));
    let count = 0;
    for (const [key, label] of Object.entries(labels)) {
      const entries = data.conditional?.[key];
      if (!entries?.length) continue;
      count += entries.length;
      conditional.appendChild(element('h4', 'spec-effect-title', label));
      const list = element('ul', 'spec-item-details');
      for (const entry of entries) {
        const parts = [entry.label || entry.detail];
        if (typeof entry.crit === 'number') parts.push(percent(entry.crit));
        else if (typeof entry.totalValue === 'number') parts.push(percent(entry.totalValue));
        else if (typeof entry.value === 'number') parts.push(percent(entry.value));
        if (entry.note) parts.push(entry.note);
        if (entry.clause) parts.push(entry.clause);
        list.appendChild(element('li', '', parts.filter(Boolean).join(' · ')));
      }
      conditional.appendChild(list);
    }
    if (count) context.appendChild(conditional);
  }

  function renderDetails(data) {
    renderItems(content('equipment'), data.equipment, '장착한 장비가 없어요.');
    renderAccessories(data);
    renderGems(data.gems);
    renderEngravings(data.engravings);
    content('cards').replaceChildren();
    renderCards(content('cards'), data.cards);
    renderArkpassive(data.arkpassive);
    content('arkgrid').replaceChildren();
    renderGrid(content('arkgrid'),data.arkgrid);
    renderCrit(data.crit);
    detailSections.forEach(finished);
  }

  // 원정대·즐겨찾기에서 다른 캐릭터를 고르면 그 캐릭터의 종합 정보부터 보여 준다(원정대 탭에 머무르지 않는다).
  // 탭을 먼저 바꿔야 search()가 주소를 갱신할 때 #panel-summary가 남고, 뒤로 가기는 이전 캐릭터의 원정대 탭으로 돌아간다.
  function characterButton(name) {
    const button = element('button', 'spec-character-button', name);
    button.type = 'button';
    button.addEventListener('click', () => {
      selectTab('summary', { updateHash: true });
      search(name);
      results.scrollIntoView({ block: 'start' });
    });
    return button;
  }

  function table(columns, label, className = '') {
    const wrap = element('div', 'spec-table-wrap');
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', label);
    const node = element('table', `spec-table ${className}`.trim());
    const head = element('thead');
    const row = element('tr');
    columns.forEach((name) => {
      const cell = element('th', '', name);
      cell.scope = 'col';
      row.appendChild(cell);
    });
    const body = element('tbody');
    head.appendChild(row);
    node.append(head, body);
    wrap.appendChild(node);
    return { wrap, body };
  }

  function renderRoster(data) {
    const target = content('roster');
    if (!data || !Array.isArray(data.characters)) return empty(target, '원정대 정보를 확인할 수 없어요.');
    if (!data.characters.length) return empty(target, '원정대 캐릭터가 없어요.');
    const servers = new Map();
    for (const character of data.characters) {
      const server = character.serverName || '서버 정보 없음';
      if (!servers.has(server)) servers.set(server, []);
      servers.get(server).push(character);
    }
    target.replaceChildren();
    for (const [server, characters] of servers) {
      target.appendChild(element('h4', 'spec-subheading', `${server} · ${characters.length}명`));
      const { wrap, body } = table(['캐릭터', '아이템 레벨'], `${server} 원정대 캐릭터`);
      for (const character of characters) {
        const row = element('tr');
        const identity = element('td');
        identity.append(characterButton(character.characterName), element('span', 'spec-roster-class', character.characterClass));
        row.append(identity, element('td', 'spec-number', numeric(character.itemLevel)));
        body.appendChild(row);
      }
      target.appendChild(wrap);
    }
  }

  async function search(value) {
    if (!accessApproved) return;
    const name = String(value || '').normalize('NFC').trim();
    inputTouched = true;
    input.value = name;
    if (!validName(name)) {
      valuation.reset();
      specup.reset();
      if (active) active.controller.abort();
      if (efficiencyController) efficiencyController.abort();
      braceletValueController?.abort(); braceletValueController = null; braceletValueState = { status: 'idle' };
      clearTimeout(braceletValueRetryTimer); braceletValueRetryTimer = null;
      active = null;
      generation += 1;
      results.hidden = true;
      setStatus(name ? errorMessage({ code: 'invalid_request' }) : '조회할 캐릭터명을 입력해 주세요.', true);
      input.focus();
      return;
    }
    if (active?.name.toLowerCase() === name.toLowerCase()) return;
    const searchUrl = new URL(window.location.href);
    searchUrl.searchParams.set('characterName', name);
    history.replaceState(null, '', `${searchUrl.pathname}${searchUrl.search}${searchUrl.hash}`);
    valuation.reset();
    specup.reset();
    if (active) active.controller.abort();
    if (efficiencyController) efficiencyController.abort();
    efficiencyState = { status: 'idle' };
    tierController?.abort(); tierController = null; tierState = { status: 'idle' }; scoreRecordState = null;
    braceletValueController?.abort(); braceletValueController = null; braceletValueState = { status: 'idle' };
    clearTimeout(braceletValueRetryTimer); braceletValueRetryTimer = null;
    const current = ++generation;
    const controller = new AbortController();
    active = { name, controller };
    const isCurrent = () => generation === current && !controller.signal.aborted;
    results.hidden = true;
    document.getElementById('spec-action-status').textContent = '';
    document.getElementById('spec-share-fallback').hidden = true;
    document.getElementById('spec-empty-guide').hidden = true;
    summaryData = {};
    summaryErrors = {};
    snapshotMeta = {};
    renderSnapshotNotice();
    renderSummary();
    allSections.forEach((section) => loading(section));
    setStatus(`${name} 캐릭터를 찾고 있어요.`);
    let failures = 0;
    let lastError = null;
    try {
      const profile = await requestSection(name, 'profile', controller.signal);
      if (!isCurrent()) return;
      renderProfile(profile.profile);
      snapshotMeta.profile = profile;
      renderSnapshotNotice();
      setStatus(`${profile.profile.characterName}의 기본 정보를 불러왔어요. 장비와 원정대를 확인하고 있어요.`);
      async function fill(section, render, affected = [section]) {
        try {
          const data = await requestSection(name, section, controller.signal);
          if (!isCurrent()) return;
          summaryData[section] = data;
          snapshotMeta[section] = data;
          render(data);
          renderSnapshotNotice();
          renderSummary();
          if(section === 'details') void loadEfficiency(name,current);
        } catch (error) {
          if (!isCurrent()) return;
          failures += 1;
          lastError = error;
          affected.forEach((key) => empty(content(key), errorMessage(error)));
          summaryErrors[section] = errorMessage(error);
          renderSummary();
        } finally {
          if (isCurrent()) affected.forEach(finished);
        }
      }
      await Promise.all([
        fill('details', renderDetails, detailSections),
        fill('roster', (data) => renderRoster(data.roster)),
      ]);
      if (!isCurrent()) return;
      const usingSaved = Object.values(snapshotMeta).some(data => data.source === 'saved');
      if (document.getElementById('tab-valuation').getAttribute('aria-selected') === 'true') valuation.selected();
      if (document.getElementById('tab-specup').getAttribute('aria-selected') === 'true') specup.selected();
      setStatus(failures ? `확인된 정보를 먼저 보여드려요. ${errorMessage(lastError)}`
        : usingSaved ? `${name}의 저장된 정보를 표시합니다. 마지막 갱신 시각을 확인해 주세요.`
          : `${name}의 스펙 조회를 마쳤어요.`, failures > 0, failures === 0);
      if (document.activeElement === document.body || form.contains(document.activeElement)) {
        heading.focus({ preventScroll: true });
      }
    } catch (error) {
      if (isCurrent()) {
        results.hidden = true;
        setStatus(errorMessage(error), true);
      }
    } finally {
      if (generation === current) active = null;
    }
  }

  form.addEventListener('submit', (event) => { event.preventDefault(); search(input.value); });
  document.getElementById('spec-bookmark').addEventListener('click', toggleFavorite);
  document.getElementById('spec-share').addEventListener('click', shareCharacter);
  input.addEventListener('input', () => { inputTouched = true; });
  for (const tab of tabs) {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab, { updateHash: true }));
    tab.addEventListener('keydown', (event) => {
      const index = tabs.indexOf(tab);
      const keys = { ArrowLeft: (index + tabs.length - 1) % tabs.length, ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1 };
      if (Object.hasOwn(keys, event.key)) {
        event.preventDefault();
        tabs.forEach((item, position) => { item.tabIndex = position === keys[event.key] ? 0 : -1; });
        tabs[keys[event.key]].focus();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectTab(tab.dataset.tab, { updateHash: true });
      }
    });
  }
  window.addEventListener('hashchange', selectLocationTab);
  window.addEventListener('popstate', () => {
    const names = new URL(window.location.href).searchParams.getAll('characterName');
    const name = String(names[0] || '').normalize('NFC').trim();
    const currentName = active?.name || summaryData.profile?.characterName;
    if (accessApproved && names.length === 1 && validName(name) && name.toLowerCase() !== currentName?.toLowerCase()) search(name);
    selectLocationTab();
  });
  selectLocationTab();

  function startApproved() {
    favorites = savedNames(favoriteKey); recent = savedNames(recentKey);
    renderFavorites(); renderRecent();
    const entryUrl = new URL(window.location.href);
    if (!entryHandled && entryUrl.searchParams.has('characterName')) {
      entryHandled = true;
      const values = entryUrl.searchParams.getAll('characterName');
      const name = String(values[0] || '').normalize('NFC').trim();
      inputTouched = true;
      if (values.length === 1 && validName(name)) search(name);
      else {
        entryUrl.searchParams.delete('characterName');
        history.replaceState(null, '', `${entryUrl.pathname}${entryUrl.search}${entryUrl.hash}`);
        setStatus(errorMessage({ code: 'invalid_request' }), true);
      }
      return;
    }
    entryHandled = true;
    sessionController?.abort();
    const controller = new AbortController(); sessionController = controller;
    const current = generation;
    const sessionTimeout = setTimeout(() => controller.abort(), 8000);
    Promise.resolve(window.getPogeunMemberProfile?.())
    .then((data) => {
      const name = data?.representative?.characterName;
      if (accessApproved && current === generation && !controller.signal.aborted && typeof name === 'string' && /^[가-힣A-Za-z0-9]{2,12}$/.test(name) && !inputTouched && !input.value) input.value = name;
    })
    .catch(() => {})
      .finally(() => { clearTimeout(sessionTimeout); if (sessionController === controller) sessionController = null; });
  }

  function clearProtected() {
    document.getElementById('spec-personal').hidden = true;
    document.getElementById('spec-representative').dataset.characterName = '';
  }
  // Lookup routes no longer answer 401/403 for visitors; nothing on this page is withdrawn on a session change.
  function denyAccess() {}
  function accessChanged(detail) {
    const approved = detail?.approved === true;
    // 세션은 60초마다 다시 확인되고 그때마다 이 사건이 온다(renewal.js). 승인 상태가 실제로 바뀔 때만
    // 스펙업 판을 버린다 — 조건 없이 버리면 계산해 둔 판이 1분마다 사라진다.
    const changed = approved !== memberApproved;
    memberApproved = approved;
    if (!memberApproved) clearProtected();
    if (changed) specup.reset();
  }
  document.addEventListener('site:member-profile', event => {
    const panel = document.getElementById('spec-personal'), button = document.getElementById('spec-representative');
    const name = event.detail?.representative?.characterName;
    panel.hidden = !memberApproved;
    button.hidden = !memberApproved || !validName(name);
    button.dataset.characterName = button.hidden ? '' : name;
    if (!button.hidden) {
      button.textContent = `${name} 바로 조회`;
      if (!inputTouched) input.value = name;
    } else if (!inputTouched) input.value = '';
  });
  document.getElementById('spec-representative').addEventListener('click', event => {
    const name = event.currentTarget.dataset.characterName;
    if (memberApproved && validName(name)) { inputTouched = true; input.value = name; search(name); }
  });
  document.addEventListener('site:access', event => accessChanged(event.detail));
  accessChanged(window.pogeunSiteAccess);
  startApproved();
}());
