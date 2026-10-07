(() => {
  'use strict';
  const base = new URL('.', document.currentScript.src);
  const accessStates = new Set(['anonymous', 'verification_required', 'application_required', 'pending', 'rejected', 'revoked', 'approved', 'unavailable']);
  let settleAccess;
  let accessResolved = false;
  window.pogeunSiteAccess = Object.freeze({ approved: false, authenticated: false, status: 'unavailable' });
  window.pogeunSiteAccessReady = new Promise(resolve => { settleAccess = resolve; });
  const feature = document.querySelector('main[data-site-feature]');
  let accessCard = null;
  if (feature) {
    accessCard = document.createElement('section');
    accessCard.className = 'site-access-gate';
    accessCard.setAttribute('role', 'status');
    accessCard.setAttribute('aria-live', 'polite');
    feature.prepend(accessCard);
  }
  function renderAccess(detail, initial = false) {
    if (!feature) return;
    const wasInGate = accessCard.contains(document.activeElement);
    const wasInside = feature.contains(document.activeElement) && !accessCard.contains(document.activeElement);
    feature.dataset.siteAccess = detail.approved ? 'approved' : 'locked';
    accessCard.hidden = detail.approved;
    if (detail.approved) {
      if (wasInGate) { if (!feature.hasAttribute('tabindex')) feature.tabIndex = -1; feature.focus({ preventScroll: true }); }
      return;
    }
    const stateKey = `${initial ? 'checking' : detail.status}:${detail.authenticated}`;
    if (accessCard.dataset.accessState === stateKey) return;
    accessCard.dataset.accessState = stateKey;
    const copy = initial ? ['확인 중', '이용 권한을 확인하고 있어요.', '잠시만 기다려 주세요.'] : {
      anonymous: ['로그인 필요', '포근해용에 함께해 주세요.', '로그인 후 가입 절차를 진행할 수 있어요. 운영진의 최종 승인 후 모든 기능을 이용하실 수 있습니다.'],
      verification_required: ['본인 확인', '가입 확인을 이어서 진행해 주세요.', '내 계정에서 필요한 확인 절차를 마친 뒤 가입을 신청해 주세요.'],
      application_required: ['가입 신청', '이용 신청을 보내 주세요.', '내 계정에서 가입을 신청하면 운영진이 확인합니다. 승인 후 캐릭터·시장·길드 기능을 이용할 수 있어요.'],
      pending: ['승인 검토 중', '운영진의 승인을 기다리고 있어요.', '가입 신청을 확인하고 있습니다. 내 계정에서 현재 진행 상태를 확인해 주세요.'],
      rejected: ['신청 확인 필요', '가입 신청이 승인되지 않았어요.', '내 계정에서 신청 상태를 확인해 주세요. 필요한 내용을 보완한 뒤 다시 신청할 수 있습니다.'],
      revoked: ['이용 승인 확인 필요', '이용 승인이 변경되었어요.', '내 계정에서 현재 상태를 확인하거나 운영진에게 문의해 주세요.'],
      unavailable: ['상태 확인 필요', '이용 권한을 확인하지 못했어요.', '내 계정에서 로그인과 가입 상태를 다시 확인해 주세요.'],
    }[detail.status] || ['상태 확인 필요', '이용 권한을 확인해 주세요.', '내 계정에서 현재 가입 상태를 확인해 주세요.'];
    const badge = document.createElement('p'); badge.className = 'site-access-stage'; badge.textContent = copy[0];
    const title = document.createElement('h1'); title.textContent = copy[1]; title.tabIndex = -1;
    const description = document.createElement('p'); description.textContent = copy[2];
    const actions = document.createElement('div'); actions.className = 'site-access-actions';
    const account = document.createElement('a'); account.className = 'realm-action primary'; account.href = new URL('account.html', base).href;
    account.textContent = detail.authenticated ? '내 가입 상태 확인' : '로그인·가입';
    const home = document.createElement('a'); home.className = 'realm-action'; home.href = new URL('index.html', base).href; home.textContent = '홈으로';
    actions.append(account, home);
    accessCard.replaceChildren(badge, title, description, actions);
    if (wasInside) title.focus({ preventScroll: true });
  }
  window.publishPogeunSiteAccess = value => {
    const authenticated = value?.authenticated === true;
    let status = accessStates.has(value?.status) ? value.status : 'unavailable';
    const approved = authenticated && value?.approved === true && status === 'approved';
    if (status === 'approved' && !approved) status = 'unavailable';
    const detail = Object.freeze({ approved, authenticated, status });
    window.pogeunSiteAccess = detail;
    renderAccess(detail);
    renderAccountLinks(detail);
    if (!accessResolved) { accessResolved = true; settleAccess(detail); }
    document.dispatchEvent(new CustomEvent('site:access', { detail }));
    return detail;
  };
  renderAccess(window.pogeunSiteAccess, true);
  const root = document.querySelector('[data-site-header]');
  if (!root) return;
  const path = name => new URL(name, base).href;
  const icon = document.querySelector('link[rel="icon"]') || document.head.appendChild(document.createElement('link'));
  icon.rel = 'icon'; icon.type = 'image/png'; icon.href = path('assets/pogeun-sprout-logo.png');
  const mark = `<img class="realm-logo" src="${path('assets/pogeun-sprout-logo.png')}" width="32" height="32" alt="" decoding="async">`;
  const searchIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m16 16 5 5"></path></svg>';
  const updateIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3Z"></path><path d="M10 20h4M12 2v2"></path></svg>';
  root.classList.add('realm-header');
  root.innerHTML = `<div class="realm-header-inner"><a class="realm-brand" href="${path('index.html')}" aria-label="포근해용 홈">${mark}<span>포근해용</span></a><nav id="realm-navigation" class="realm-nav" aria-label="주요 메뉴"></nav><div class="realm-header-tools"><a class="realm-icon-link" href="${path('spec.html')}" aria-label="캐릭터 검색" title="캐릭터 검색">${searchIcon}</a><a class="realm-icon-link realm-update-link" href="${path('updates.html')}" aria-label="업데이트 내역" title="업데이트 내역">${updateIcon}</a><div class="realm-account"><a href="${path('account.html')}" data-account-link>로그인</a><a href="${path('account.html')}" data-registration-link>회원가입</a></div><button class="realm-menu-toggle" type="button" aria-expanded="false" aria-controls="realm-navigation realm-menu-panel" aria-label="메뉴 열기"><span></span><span></span><span></span></button></div><div id="realm-menu-panel" class="realm-menu-panel" hidden><a href="${path('account.html')}">내 계정·가입 상태</a><a href="${path('guild.html')}" data-guild-link hidden>우리 길드</a><div data-theme-mount></div></div></div>`;
  const nav = root.querySelector('nav');
  const items = [['home','홈','index.html#intro'],['spec','캐릭터','spec.html'],['todo','숙제','todo.html'],['tools','시장·도구','tools.html'],['guild','길드','guild.html'],['commands','명령어','index.html#commands'],['updates','업데이트','index.html#updates']];
  for (const [key,label,url] of items) {
    const a = document.createElement('a'); a.href = path(url); a.textContent = label; a.dataset.nav = key; nav.append(a);
  }
  const button = root.querySelector('.realm-menu-toggle');
  const menuPanel = root.querySelector('.realm-menu-panel');
  button.addEventListener('click', () => { const open = button.getAttribute('aria-expanded') !== 'true'; button.setAttribute('aria-expanded', String(open)); button.setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기'); root.classList.toggle('menu-open', open); menuPanel.hidden = !open; });
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && root.classList.contains('menu-open')) { button.click(); button.focus(); } });
  nav.addEventListener('click', event => { if (event.target.closest('a') && root.classList.contains('menu-open')) button.click(); });
  document.addEventListener('click', event => { if (!root.contains(event.target) && root.classList.contains('menu-open')) button.click(); });
  function renderAccountLinks(detail) {
    const account = document.querySelector('[data-site-header] [data-account-link]');
    const registration = document.querySelector('[data-site-header] [data-registration-link]');
    if (account) account.textContent = detail.authenticated ? '내 계정' : '로그인';
    if (registration) { registration.textContent = detail.authenticated ? '가입 상태' : '회원가입'; registration.hidden = detail.approved; }
  }
  renderAccountLinks(window.pogeunSiteAccess);
  const memberProfileLink = document.createElement('a');
  memberProfileLink.className = 'realm-member-profile'; memberProfileLink.href = path('account.html');
  memberProfileLink.hidden = true; memberProfileLink.setAttribute('aria-label', '내 대표 캐릭터 · 내 계정');
  root.querySelector('.realm-account').prepend(memberProfileLink);
  let profileGeneration = 0, profileController = null, profileTask = null, profileData = null, profileFetchedAt = 0;
  const characterName = value => typeof value === 'string' && /^[가-힣A-Za-z0-9]{2,12}$/.test(value);
  const profileImage = value => typeof value === 'string' && value.length <= 2048 && /^https:\/\/cdn-lostark\.game\.onstove\.com\/armory\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:jpg|png|webp)(?:\?v=[A-Za-z0-9_-]{1,64})?$/.test(value);
  const profileNode = (tag, name, text) => { const e = document.createElement(tag); e.className = name; if (text !== undefined) e.textContent = text; return e; };
  function paintMemberProfile(data) {
    const profile = data?.representative;
    memberProfileLink.replaceChildren();
    const available = window.pogeunSiteAccess?.approved === true && characterName(profile?.characterName);
    memberProfileLink.hidden = !available;
    root.querySelector('[data-account-link]').hidden = available;
    if (!available) return;
    const avatar = profileNode('span', 'realm-member-avatar', profile.characterName.slice(0, 1)); avatar.setAttribute('aria-hidden', 'true');
    if (profileImage(profile.characterImage)) {
      const img = document.createElement('img'); img.src = profile.characterImage; img.alt = ''; img.decoding = 'async';
      img.addEventListener('error', () => img.remove(), { once: true }); avatar.append(img);
    }
    const info = profileNode('span', 'realm-member-info'), name = profileNode('strong', 'realm-member-name', profile.characterName);
    const level = Number.isFinite(profile.itemLevel) ? profile.itemLevel.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '—';
    const stats = profileNode('span', 'realm-member-stats', `Lv.${level}`);
    const score = data.score;
    if (score?.status === 'ok' && Number.isFinite(score.score) && typeof score.tier?.name === 'string' && score.tier.name.length <= 30) {
      stats.append(profileNode('span', 'realm-member-score', `환산 ${score.score.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}`));
      const tier = profileNode('span', 'realm-member-tier', score.tier.name);
      const percentile = score.tier.status === 'ok' && Number.isFinite(score.tier.percentile) && typeof score.tier.source === 'string' && score.tier.source.length <= 20 ? score.tier.percentile : null;
      const topPercent = value => value < 0.005 ? '0.01% 미만' : value.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) + '%';
      const ref = score.tier.reason === 'lopec_record_mismatch' ? score.tier.reference : null;
      const reference = ref && typeof ref === 'object' && Number.isFinite(ref.score) && ref.score > 0 && Number.isFinite(ref.percentile) && ref.percentile > 0 && ref.percentile <= 100
        && typeof ref.source === 'string' && ref.source.length > 0 && ref.source.length <= 20 ? ref : null;
      tier.title = percentile !== null ? `${score.tier.source} 기준 상위 ${topPercent(percentile)}`
        : reference ? `현재 장착 점수 구간 기준 · ${reference.source} 최고 기록 ${Math.round(reference.score).toLocaleString('ko-KR')}점 기준 상위 ${topPercent(reference.percentile)}`
        : '사이트 자체 환산 점수 · 점수 구간 기준';
      if (typeof score.tier.key === 'string' && /^[a-z]{3,12}$/.test(score.tier.key)) {
        // 전용 그림 대상(tier.art)은 배지 파일만 바뀐다; 파일이 없으면 기존 onerror가 배지를 뗀다.
        const badgeKey = score.tier.art && typeof score.tier.art.key === 'string' && /^[a-z]{3,12}$/.test(score.tier.art.key) ? score.tier.art.key : score.tier.key;
        const badge = document.createElement('img'); badge.className = 'realm-member-tier-badge'; badge.src = path(`assets/tiers/${badgeKey}-sm.png`);
        badge.alt = ''; badge.width = 18; badge.height = 18; badge.decoding = 'async'; badge.addEventListener('error', () => badge.remove(), { once: true }); tier.prepend(badge);
      }
      info.append(name, stats, tier);
    } else info.append(name, stats, profileNode('span', 'realm-member-tier realm-member-unavailable', '환산 점수 확인 필요'));
    memberProfileLink.append(avatar, info);
    memberProfileLink.title = `${profile.characterName} · ${profile.serverName || ''} · ${profile.characterClass || ''} · 내 계정에서 대표 변경`;
    memberProfileLink.setAttribute('aria-label', [profile.characterName, `아이템 레벨 ${level}`,
      score?.status === 'ok' && Number.isFinite(score.score) ? `환산 점수 ${score.score.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}` : '환산 점수 확인 필요',
      score?.tier?.name, '내 계정'].filter(Boolean).join(' · '));
  }
  function clearMemberProfile() {
    profileGeneration++; profileController?.abort(); profileController = null; profileTask = null; profileData = null; profileFetchedAt = 0;
    paintMemberProfile(null);
    document.dispatchEvent(new CustomEvent('site:member-profile', { detail: null }));
  }
  window.getPogeunMemberProfile = function(force = false) {
    if (!window.pogeunSiteAccess?.approved || document.hidden) return Promise.resolve(null);
    if (!force && profileTask) return profileTask;
    if (!force && profileData && Date.now() - profileFetchedAt < 300000) return Promise.resolve(profileData);
    profileController?.abort();
    const controller = new AbortController(), current = ++profileGeneration; profileController = controller;
    const timer = setTimeout(() => controller.abort(), 15000);
    const task = (async () => {
      try {
        const response = await fetch('/api/auth/characters/profile', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } });
        const data = await response.json();
        if (current !== profileGeneration || controller.signal.aborted || !window.pogeunSiteAccess?.approved) return null;
        if (!response.ok) {
          if ([401, 403].includes(response.status)) window.publishPogeunSiteAccess({ approved: false, authenticated: response.status !== 401, status: response.status === 401 ? 'anonymous' : 'revoked' });
          throw new Error('Representative profile unavailable');
        }
        if (data?.representative !== null && (!characterName(data?.representative?.characterName) || !Number.isFinite(data.representative.itemLevel))) throw new Error('Invalid representative profile');
        profileData = data; profileFetchedAt = Date.now(); paintMemberProfile(data);
        document.dispatchEvent(new CustomEvent('site:member-profile', { detail: data })); return data;
      } catch {
        if (current === profileGeneration) { profileData = null; paintMemberProfile(null); document.dispatchEvent(new CustomEvent('site:member-profile', { detail: null })); }
        return null;
      } finally { clearTimeout(timer); if (profileTask === task) profileTask = null; if (profileController === controller) profileController = null; }
    })();
    profileTask = task; return task;
  };
  document.addEventListener('site:access', event => { if (event.detail.approved) { if (profileData) paintMemberProfile(profileData); void window.getPogeunMemberProfile(); } else clearMemberProfile(); });
  document.addEventListener('site:representative', () => { clearMemberProfile(); if (window.pogeunSiteAccess?.approved) void window.getPogeunMemberProfile(true); });
  window.addEventListener('pagehide', clearMemberProfile);
  function active(tab) {
    const section = tab || location.hash.slice(1);
    const key = root.dataset.active === 'home' ? (['commands','emoticons','link','updates'].includes(section) ? section === 'updates' ? 'updates' : 'commands' : 'home') : root.dataset.active;
    for (const link of nav.querySelectorAll('a')) { if (link.dataset.nav === key) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); }
  }
  active(); addEventListener('hashchange', () => active());
  document.addEventListener('site:navigate', event => active(event.detail));
  for (const footer of document.querySelectorAll('body > footer')) {
    footer.className = 'realm-footer'; footer.setAttribute('data-site-footer', '');
    footer.innerHTML = `<div class="realm-footer-inner"><a class="realm-footer-brand" href="${path('index.html')}">${mark}<span>포근해용</span><small>루페온 · 포근해</small></a><nav aria-label="사이트 안내"><a href="${path('terms.html')}">이용약관</a><a href="${path('privacy.html')}">개인정보처리방침</a><a href="${path('updates.html')}">업데이트</a><a href="mailto:maintainer@example.com">문의하기</a></nav><div class="realm-footer-source"><span>로스트아크 오픈 API · 로펙 · 비공식 팬 서비스</span><small>게임·이미지 © 각 권리자 · MIT License</small></div></div><p class="realm-footer-attribution">데이터 출처: 로스트아크 오픈 API — 본 사이트는 Smilegate RPG와 무관한 팬 프로젝트입니다. 이모티콘 이미지는 원작자에게 저작권이 있습니다.</p>`;
  }
})();
