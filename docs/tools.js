(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const all = selector => [...document.querySelectorAll(selector)];
  const el = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  };
  const format = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '—';
  const key = 'pogeun-market-favorites-v1';
  const normalText = value => typeof value === 'string' && value.length <= 140 && !/[<>\u0000-\u001f]/u.test(value);
  const validFavorite = value => value && normalText(value.name) && ['market', 'gems'].includes(value.kind)
    && normalText(value.query) && value.query.length <= 60 && typeof value.id === 'string' && /^[a-z0-9가-힣 -]{1,100}$/i.test(value.id)
    && Number.isSafeInteger(value.category) && value.category > 0 && value.category <= 999999;
  let favorites = [], favoritesPersistent = true;
  let accessApproved = false, accessGeneration = 0, optionsController = null;
  function loadFavorites() { try {
    const raw = localStorage.getItem(key);
    if (raw && raw.length < 24000) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) favorites = [...new Map(parsed.filter(validFavorite).map(value => [value.id, value])).values()].slice(0, 24);
    }
  } catch { favoritesPersistent = false; } }
  const state = { kind: 'market', query: '', category: 50010, page: 1, view: 'cards', result: null,
    request: 0, controller: null, historyRequest: 0, historyController: null, historyTrigger: null, bidRequest: 0, bidController: null };
  const errorMessage = error => error.status === 429 ? '조회가 잠시 몰렸습니다. 1분 뒤 다시 검색해 주세요.'
    : error.status === 400 ? (state.kind === 'gems' ? '보석 종류와 레벨을 함께 적어 주세요. 예: 10겁, 9작' : '아이템 이름과 검색 조건을 확인해 주세요.')
      : error.status === 404 ? '해당 아이템의 정보를 찾지 못했습니다.' : '시세를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
  async function request(url, controller) {
    if (!accessApproved) throw new Error('Site approval required');
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } });
      if ([401, 403].includes(response.status) && !controller.signal.aborted) {
        window.publishPogeunSiteAccess?.({ approved: false, authenticated: response.status !== 401, status: response.status === 401 ? 'anonymous' : 'unavailable' });
      }
      if (!response.ok) { const error = new Error('request failed'); error.status = response.status; throw error; }
      return await response.json();
    } finally { clearTimeout(timer); }
  }
  const favoriteId = item => state.kind === 'gems' ? `gems-${state.query}` : `market-${item.id}`;
  function saveFavorites() {
    try { localStorage.setItem(key, JSON.stringify(favorites)); favoritesPersistent = true; } catch { favoritesPersistent = false; }
    renderFavorites();
    if (state.result) renderItems(state.result);
  }
  function toggleFavorite(item) {
    const id = favoriteId(item);
    if (favorites.some(value => value.id === id)) favorites = favorites.filter(value => value.id !== id);
    else {
      if (favorites.length >= 24) { $('#market-status').textContent = '관심 아이템은 24개까지 담을 수 있습니다.'; return; }
      favorites.push({ id, name: item.name, kind: state.kind, query: item.name, category: state.category });
    }
    saveFavorites();
  }
  function renderFavorites() {
    $('#favorites-storage-note').textContent = favoritesPersistent ? '별표로 담은 아이템을 이 브라우저에 보관합니다.' : '브라우저 저장이 차단되어 이 페이지를 여는 동안만 보관합니다.';
    $('#favorites-count').textContent = String(favorites.length);
    const container = $('#market-favorites'); container.replaceChildren();
    if (!favorites.length) {
      const empty = el('p', 'market-empty'); empty.append(el('strong', '', '아직 담은 아이템이 없어요'), el('span', '', '검색 결과의 별표를 눌러 보세요.')); container.append(empty); return;
    }
    for (const item of favorites) {
      const row = el('div', 'favorite-row');
      const search = el('button', '', item.name); search.type = 'button'; search.append(el('small', '', item.kind === 'gems' ? '보석 경매장' : '거래소'));
      search.addEventListener('click', () => {
        setKind(item.kind); $('#market-query').value = item.query;
        if (![...$('#market-category').options].some(option => option.value === String(item.category))) { const option = el('option', '', '저장한 분류'); option.value = String(item.category); $('#market-category').append(option); }
        $('#market-category').value = String(item.category); searchItems(1);
      });
      const remove = el('button', '', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `${item.name} 관심 목록에서 삭제`);
      remove.addEventListener('click', () => { favorites = favorites.filter(value => value.id !== item.id); saveFavorites(); });
      row.append(search, remove); container.append(row);
    }
  }
  function setKind(kind) {
    state.kind = kind;
    all('[data-market-kind]').forEach(button => button.setAttribute('aria-pressed', String(view === 'market' && button.dataset.marketKind === kind)));
    const gem = kind === 'gems';
    $('#market-category').disabled = gem;
    $('#market-query').placeholder = gem ? '보석 검색 · 예: 10겁, 9작' : '아이템 이름 검색';
    $('#market-hint').textContent = gem ? '겁화·작열 1~10레벨을 검색합니다. 가격은 개별 매물의 즉시 구매가입니다.' : '거래소 가격은 묶음 단위로 표시합니다.';
    $('#market-results-title').textContent = gem ? '보석 경매장' : '거래소 시세';
    const sort = $('#market-sort'); sort.replaceChildren();
    const entries = gem ? [['BUY_PRICE:ASC', '즉시 구매가 낮은 순'], ['BUY_PRICE:DESC', '즉시 구매가 높은 순'], ['BIDSTART_PRICE:ASC', '입찰 시작가 낮은 순']]
      : [['CURRENT_MIN_PRICE:ASC', '최저가 낮은 순'], ['CURRENT_MIN_PRICE:DESC', '최저가 높은 순'], ['YDAY_AVG_PRICE:DESC', '전일 평균가 높은 순'], ['RECENT_PRICE:DESC', '최근 거래가 높은 순']];
    for (const [value, label] of entries) { const option = el('option', '', label); option.value = value; sort.append(option); }
    const shortcuts = $('#market-shortcuts'); shortcuts.replaceChildren();
    for (const [query, label, category] of (gem ? [['10겁', '10레벨 겁화', 50010], ['10작', '10레벨 작열', 50010], ['9겁', '9레벨 겁화', 50010], ['9작', '9레벨 작열', 50010]]
      : [['운명의', '재련 재료', 50010], ['각인서', '각인서', 40000], ['융화', '융화 재료', 50010], ['회복약', '회복약', 60200]])) {
      const button = el('button', '', label); button.type = 'button'; button.addEventListener('click', () => { $('#market-query').value = query; $('#market-category').value = String(category); searchItems(1); }); shortcuts.append(button);
    }
  }
  function addMetric(container, label, value) { const row = el('div'); row.append(el('dt', '', label), el('dd', '', value)); container.append(row); }
  function renderItems(result) {
    const container = $('#market-results'); container.replaceChildren(); container.dataset.view = state.view;
    if (!result.items.length) {
      const empty = el('p', 'market-empty'); empty.append(el('strong', '', '검색 결과가 없습니다'), el('span', '', '아이템 이름을 짧게 입력하거나 다른 분류로 검색해 보세요.')); container.append(empty); return;
    }
    for (const item of result.items) {
      const card = el('article', 'market-item');
      const star = el('button', 'market-star', favorites.some(value => value.id === favoriteId(item)) ? '★' : '☆');
      star.type = 'button'; star.setAttribute('aria-label', `${item.name} 관심 아이템`); star.setAttribute('aria-pressed', String(favorites.some(value => value.id === favoriteId(item))));
      star.addEventListener('click', () => { const label = star.getAttribute('aria-label'); toggleFavorite(item); all('.market-star').find(button => button.getAttribute('aria-label') === label)?.focus({ preventScroll: true }); });
      const head = el('div', 'market-item-head'), icon = el('div', 'market-item-icon', '◇');
      if (typeof item.icon === 'string' && /^https:\/\/cdn-lostark\.game\.onstove\.com\/efui_iconatlas\/[A-Za-z0-9_./-]+\.(?:png|jpg|webp)$/i.test(item.icon) && !item.icon.includes('..')) {
        const image = el('img'); image.src = item.icon; image.alt = ''; image.loading = 'lazy'; image.width = 56; image.height = 56;
        image.addEventListener('error', () => { icon.replaceChildren(document.createTextNode('◇')); }, { once: true }); icon.replaceChildren(image);
      }
      const heading = el('div', 'market-item-heading'); heading.append(el('h3', '', item.name), el('p', '', `${item.grade} · ${format(item.bundleCount)}개 묶음`)); head.append(icon, heading);
      const current = el('div', 'market-item-current'); current.append(el('strong', '', format(item.currentMinPrice)), el('small', '', 'G'));
      if (result.kind === 'market') {
        const change = item.changePercent;
        const delta = el('span', `market-change ${change > 0 ? 'up' : change < 0 ? 'down' : ''}`, change === null ? '비교 정보 없음' : `${change > 0 ? '▲ +' : change < 0 ? '▼ ' : ''}${format(change)}%`);
        delta.title = '전일 평균가 대비 현재 최저가'; current.append(delta);
      }
      const data = el('dl', 'market-item-data');
      if (result.kind === 'market') { addMetric(data, '전일 평균', `${format(item.yDayAvgPrice)} G`); addMetric(data, '최근 거래', `${format(item.recentPrice)} G`); }
      else { addMetric(data, '입찰 시작가', `${format(item.bidStartPrice)} G`); addMetric(data, '즉시 구매', item.currentMinPrice === null ? '등록 안 됨' : '가능'); }
      const actions = el('div', 'market-item-actions');
      if (result.kind === 'market') {
        const history = el('button', '', '가격 추이'); history.type = 'button'; history.addEventListener('click', () => { state.historyTrigger = history; showHistory(item); }); actions.append(history);
      }
      const calc = el('button', '', '분배금 계산'); calc.type = 'button'; calc.disabled = !(item.currentMinPrice > 0 && item.currentMinPrice <= 1000000000);
      calc.addEventListener('click', () => {
        $('#bid-price').value = String(Math.floor(item.currentMinPrice));
        $('#bid-source').textContent = `${item.name} · ${format(item.bundleCount)}개 묶음의 시세`;
        $('#bid-source').hidden = false;
        openTool('bid');
        $('#bid-price').focus({ preventScroll: true }); calculateBid();
      }); actions.append(calc);
      card.append(star, head, current, data, actions);
      if (item.options?.length) {
        const options = el('div', 'market-gem-options');
        for (const option of item.options) options.append(el('p', '', `${option.className ? `${option.className} · ` : ''}${option.name}${option.value !== null ? ` ${format(option.value)}${option.percent ? '%' : ''}` : ''}`));
        card.append(options);
      }
      container.append(card);
    }
  }
  async function searchItems(page = 1) {
    if (!accessApproved) return;
    const serial = ++state.request;
    state.controller?.abort(); state.controller = new AbortController();
    state.result = null; $('#market-results').replaceChildren(); $('#market-pagination').hidden = true;
    state.historyRequest++; state.historyController?.abort(); $('#market-history').hidden = true;
    const [sort, order] = $('#market-sort').value.split(':');
    const query = $('#market-query').value.normalize('NFC').trim().replace(/ +/g, ' ');
    const category = state.kind === 'gems' ? '0' : $('#market-category').value;
    const params = new URLSearchParams({ kind: state.kind, q: query, category, sort, order, page: String(page) });
    $('#market-status').textContent = '시세를 불러오고 있습니다…'; $('#market-results').setAttribute('aria-busy', 'true');
    $('#market-refresh').disabled = true; $('#market-search-form button[type=submit]').disabled = true;
    try {
      const result = await request(`/api/market/search?${params}`, state.controller);
      if (serial !== state.request) return;
      if (!Array.isArray(result?.items) || !Number.isInteger(result.totalCount)) throw new Error('invalid response');
      state.query = result.query; state.category = result.category; state.page = result.page; state.result = result;
      renderItems(result); $('#market-status').textContent = '';
      $('#market-result-count').textContent = `${result.query ? `“${result.query}” · ` : ''}${format(result.totalCount)}${result.kind === 'gems' ? '개 매물' : '개 아이템'}`;
      $('#market-pagination').hidden = result.pageCount <= 1;
      $('#market-page').textContent = `${result.page} / ${Math.min(result.pageCount, 100)}`;
      $('#market-prev').disabled = result.page <= 1; $('#market-next').disabled = result.page >= Math.min(result.pageCount, 100);
      $('#market-updated').textContent = `${new Date(result.updatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 기준 · 골드(G)`;
      const url = new URL(location.href); url.search = new URLSearchParams({ kind: result.kind, q: result.query, category: String(result.category) }); history.replaceState(null, '', url);
    } catch (error) {
      if (serial !== state.request) return;
      $('#market-status').textContent = error.name === 'AbortError' ? '조회 시간이 길어지고 있습니다. 다시 검색해 주세요.' : errorMessage(error);
      state.result = null; $('#market-results').replaceChildren(); $('#market-pagination').hidden = true; $('#market-result-count').textContent = ''; $('#market-updated').textContent = '';
    } finally {
      if (serial === state.request) { $('#market-results').removeAttribute('aria-busy'); $('#market-refresh').disabled = false; $('#market-search-form button[type=submit]').disabled = false; }
    }
  }
  function renderHistoryVariant(variant, container) {
    const rows = variant.history.slice(-14);
    container.replaceChildren();
    if (!rows.length) { container.append(el('p', 'market-empty', '표시할 거래 기록이 없습니다.')); return; }
    const traded = rows.filter(row => row.tradeCount > 0);
    const meta = el('div', 'history-meta');
    meta.append(el('span', '', `${format(variant.bundleCount)}개 묶음${variant.tradeRemainCount === null ? '' : ` · 거래 가능 ${variant.tradeRemainCount}회`}`),
      el('span', '', `표시 기간 거래량 ${format(rows.reduce((sum, row) => sum + row.tradeCount, 0))}`));
    container.append(meta);
    if (traded.length) {
      const low = Math.min(...traded.map(row => row.averagePrice)), high = Math.max(...traded.map(row => row.averagePrice));
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 700 175'); svg.setAttribute('preserveAspectRatio', 'none'); svg.classList.add('history-chart');
      svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `${variant.name} 평균가 추이. 최저 ${format(low)}골드, 최고 ${format(high)}골드. 날짜별 상세 값은 아래 거래 기록에서 확인할 수 있습니다.`);
      for (const y of [20, 87.5, 155]) { const line = document.createElementNS(svg.namespaceURI, 'line'); line.setAttribute('x1', '4'); line.setAttribute('x2', '696'); line.setAttribute('y1', y); line.setAttribute('y2', y); line.classList.add('history-grid'); svg.append(line); }
      const point = row => [rows.length < 2 ? 350 : 4 + rows.findIndex(value => value.date === row.date) / (rows.length - 1) * 692, high === low ? 87.5 : 155 - (row.averagePrice - low) / (high - low) * 135];
      const line = document.createElementNS(svg.namespaceURI, 'polyline'); line.setAttribute('points', traded.map(row => point(row).join(',')).join(' ')); line.classList.add('history-line'); svg.append(line);
      for (const row of traded) { const [x, y] = point(row); const dot = document.createElementNS(svg.namespaceURI, 'circle'); dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', '3'); dot.classList.add('history-dot'); svg.append(dot); }
      container.append(el('p', 'market-caption', `일별 평균가 · ${format(low)} ~ ${format(high)} G`), svg);
      const labels = el('div', 'history-labels'); labels.append(el('span', '', rows[0].date), el('span', '', rows.at(-1).date)); container.append(labels);
    } else container.append(el('p', 'market-caption', '표시 기간에 거래가 없어 가격 선을 표시하지 않습니다.'));
    const details = el('details', 'history-details'); details.append(el('summary', '', '날짜별 가격·거래량 보기'));
    const wrap = el('div', 'history-table-wrap'), table = el('table', 'history-table'), thead = el('thead'), head = el('tr'), tbody = el('tbody');
    for (const label of ['날짜', '평균가', '거래량']) { const th = el('th', '', label); th.scope = 'col'; head.append(th); } thead.append(head);
    for (const row of [...rows].reverse()) { const tr = el('tr'); tr.append(el('td', '', row.date), el('td', '', row.tradeCount > 0 ? `${format(row.averagePrice)} G` : '거래 없음'), el('td', '', format(row.tradeCount))); tbody.append(tr); }
    table.append(thead, tbody); wrap.append(table); details.append(wrap); container.append(details);
  }
  async function showHistory(item) {
    if (!accessApproved) return;
    const serial = ++state.historyRequest; state.historyController?.abort(); state.historyController = new AbortController();
    const panel = $('#market-history'), content = $('#market-history-content'); panel.hidden = false;
    $('#market-history-title').textContent = `${item.name} 가격 추이`; content.replaceChildren(el('p', 'market-status', '거래 기록을 불러오고 있습니다…'));
    panel.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    try {
      const data = await request(`/api/market/items/${item.id}/history`, state.historyController);
      if (serial !== state.historyRequest) return;
      content.replaceChildren();
      if (!Array.isArray(data?.variants) || !data.variants.length) throw new Error('invalid response');
      const body = el('div');
      const index = Math.max(0, data.variants.findIndex(value => value.bundleCount === item.bundleCount && value.tradeRemainCount === item.tradeRemainCount));
      if (data.variants.length > 1) {
        const select = el('select', 'history-variant'); select.setAttribute('aria-label', '거래 조건별 시세');
        data.variants.forEach((variant, i) => { const option = el('option', '', `${format(variant.bundleCount)}개 묶음${variant.tradeRemainCount === null ? '' : ` · 거래 가능 ${variant.tradeRemainCount}회`}`); option.value = String(i); select.append(option); }); select.value = String(index);
        select.addEventListener('change', () => renderHistoryVariant(data.variants[Number(select.value)], body)); content.append(select);
      }
      content.append(body); renderHistoryVariant(data.variants[index], body);
    } catch (error) { if (serial === state.historyRequest) content.replaceChildren(el('p', 'market-status', errorMessage(error))); }
  }
  async function calculateBid() {
    if (!accessApproved) return;
    if (!$('#bid-form').reportValidity()) return;
    const serial = ++state.bidRequest; state.bidController?.abort(); state.bidController = new AbortController();
    const params = new URLSearchParams({ price: $('#bid-price').value, partySize: $('#bid-party').value });
    $('#bid-status').textContent = '계산하고 있습니다…';
    try {
      const result = await request(`/api/market/bid?${params}`, state.bidController);
      if (serial !== state.bidRequest) return;
      const container = $('#bid-result'); container.replaceChildren(); container.hidden = false;
      for (const [label, value] of [['추천 입찰가', result.preempt], ['균등 분배가', result.evenShare], ['재판매 상한', result.resaleCap]]) {
        const row = el('div'); row.append(el('span', '', label), el('strong', '', `${format(value)} G`)); container.append(row);
      }
      $('#bid-status').textContent = '';
    } catch { if (serial === state.bidRequest) { $('#bid-status').textContent = '계산할 가격과 인원을 확인한 뒤 다시 시도해 주세요.'; $('#bid-result').hidden = true; } }
  }
  $('#market-search-form').addEventListener('submit', event => { event.preventDefault(); searchItems(1); });
  $('#market-sort').addEventListener('change', () => searchItems(1));
  $('#market-refresh').addEventListener('click', () => searchItems(state.page));
  $('#market-prev').addEventListener('click', () => searchItems(state.page - 1));
  $('#market-next').addEventListener('click', () => searchItems(state.page + 1));
  $('#market-history-close').addEventListener('click', () => { state.historyRequest++; state.historyController?.abort(); $('#market-history').hidden = true; if (state.historyTrigger?.isConnected) state.historyTrigger.focus({ preventScroll: true }); });
  $('#bid-form').addEventListener('submit', event => { event.preventDefault(); calculateBid(); });
  function clearBidResult() { state.bidRequest++; state.bidController?.abort(); $('#bid-result').hidden = true; $('#bid-status').textContent = ''; }
  $('#bid-price').addEventListener('input', () => { $('#bid-source').hidden = true; $('#bid-source').textContent = ''; clearBidResult(); });
  $('#bid-party').addEventListener('change', clearBidResult);
  all('[data-market-view]').forEach(button => button.addEventListener('click', () => { state.view = button.dataset.marketView; $('#market-results').dataset.view = state.view; all('[data-market-view]').forEach(value => value.setAttribute('aria-pressed', String(value === button))); }));
  all('[data-market-kind]').forEach(button => button.addEventListener('click', () => {
    if (view !== 'market') history.pushState(null, '', location.pathname + location.search);
    showView('market', false);
    setKind(button.dataset.marketKind); $('#market-query').value = state.kind === 'gems' ? '10겁' : '운명의'; $('#market-category').value = '50010'; searchItems(1);
  }));
  // 탭 줄: 거래소 시세·보석 경매장은 검색 화면이고, 분배금 계산기·장비 강화는 그 도구 하나만 넓게 보여 준다.
  // 두 도구는 같은 방식으로 주소 조각(#bid-calculator·#honing)으로 바로 열리고, 뒤로 가기로 돌아온다.
  const TOOL_HASHES = { bid: '#bid-calculator', honing: '#honing' };
  const viewOfHash = () => ({ '#bid-calculator': 'bid', '#honing': 'honing', '#honing-calculator': 'honing' })[location.hash] ?? 'market';
  let view = 'market';
  let marketDeferred = false;
  function showView(next, runDeferred = true) {
    view = next;
    $('#main-content').dataset.toolsView = next;
    all('[data-tools-tab]').forEach(link => { if (link.dataset.toolsTab === next) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
    if (next !== 'market') all('[data-market-kind]').forEach(button => button.setAttribute('aria-pressed', 'false'));
    else {
      all('[data-market-kind]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.marketKind === state.kind)));
      // 도구 화면으로 바로 열었을 때 미뤄 둔 첫 시세 검색을 이제 한다.
      if (runDeferred && marketDeferred && accessApproved) { marketDeferred = false; searchItems(1); }
    }
  }
  function openTool(next) {
    if (location.hash !== TOOL_HASHES[next]) history.pushState(null, '', TOOL_HASHES[next]);
    showView(next);
    // 시세 목록 아래에서 「분배금 계산」을 눌렀을 때처럼 탭 줄이 화면 위로 지나가 있으면 도구 머리까지 올린다.
    $('.tools-nav').scrollIntoView({ block: 'nearest' });
  }
  all('[data-tools-tab]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); openTool(link.dataset.toolsTab); }));
  addEventListener('hashchange', () => showView(viewOfHash()));
  addEventListener('popstate', () => showView(viewOfHash()));
  showView(viewOfHash());
  function startApproved() {
    const current = accessGeneration;
    loadFavorites(); setKind('market'); renderFavorites();
    const params = new URLSearchParams(location.search);
  if (params.get('kind') === 'gems') setKind('gems');
  $('#market-query').value = (params.get('q') ?? (state.kind === 'gems' ? '10겁' : '운명의')).slice(0, 60);
  if (/^[1-9]\d{0,5}$/.test(params.get('category') || '')) {
    const value = params.get('category');
    if (![...$('#market-category').options].some(option => option.value === value)) { const option = el('option', '', '선택한 분류'); option.value = value; $('#market-category').append(option); }
    $('#market-category').value = value;
  }
  if (view === 'market') searchItems(1); else marketDeferred = true;
    optionsController = new AbortController();
    const controller = optionsController;
    request('/api/market/options', controller).then(data => {
    if (!accessApproved || current !== accessGeneration || controller.signal.aborted) return;
    if (!Array.isArray(data?.categories)) return;
    const selected = $('#market-category').value;
    $('#market-category').replaceChildren();
    for (const category of data.categories) { const option = el('option', '', `${category.parent === null ? '' : '　'}${category.name}`); option.value = String(category.code); $('#market-category').append(option); }
    $('#market-category').value = data.categories.some(category => String(category.code) === selected) ? selected : '50010';
  }).catch(() => { /* Item-name search remains available without the optional category list. */ });
  }
  function clearProtected() {
    accessGeneration++; state.request++; state.historyRequest++; state.bidRequest++;
    state.controller?.abort(); state.historyController?.abort(); state.bidController?.abort(); optionsController?.abort();
    state.result = null; state.historyTrigger = null; favorites = [];
    for (const id of ['market-results', 'market-history-content', 'bid-result', 'market-favorites']) document.getElementById(id).replaceChildren();
    for (const id of ['market-status', 'market-result-count', 'market-updated', 'market-page', 'bid-status', 'bid-source', 'favorites-storage-note']) document.getElementById(id).textContent = '';
    $('#market-history-title').textContent = '가격 추이'; $('#favorites-count').textContent = '0';
    for (const id of ['market-pagination', 'market-history', 'bid-result', 'bid-source']) document.getElementById(id).hidden = true;
    $('#market-query').value = ''; $('#bid-price').value = '';
    $('#market-results').removeAttribute('aria-busy');
    $('#market-refresh').disabled = false; $('#market-search-form button[type=submit]').disabled = false;
  }
  function accessChanged(detail) {
    const wasApproved = accessApproved;
    accessApproved = detail?.approved === true;
    if (!accessApproved) clearProtected();
    else if (!wasApproved) startApproved();
  }
  document.addEventListener('site:access', event => accessChanged(event.detail));
  accessChanged(window.pogeunSiteAccess);
  addEventListener('pagehide', () => { state.request++; state.historyRequest++; state.bidRequest++; state.controller?.abort(); state.historyController?.abort(); state.bidController?.abort(); optionsController?.abort(); });
})();
