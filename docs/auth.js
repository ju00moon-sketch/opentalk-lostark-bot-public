(() => {
  'use strict';
  if (location.origin === 'https://opentalk.example.invalid' && location.pathname.startsWith('/opentalk-lostark-bot/')) {
    if (location.pathname === '/opentalk-lostark-bot/account.html') { location.replace('https://opentalk.example.invalid/account.html'); return; }
    for (const [selector, page] of [['[data-account-link]', 'account.html'], ['[data-guild-link]', 'guild.html']]) {
      const link = document.querySelector(selector); if (link) link.href = `https://opentalk.example.invalid/${page}`;
    }
    return;
  }
  const $ = id => document.getElementById(id);
  const isAccountPage = document.body.hasAttribute('data-account-page');
  const accountLink = document.querySelector('[data-account-link]');
  const guildLink = document.querySelector('[data-guild-link]');
  const status = $('auth-status'), signedIn = $('signed-in'), signedOut = $('signed-out'), retry = $('auth-retry');
  const logout = $('logout'), deleteDialog = $('delete-dialog'), confirmDelete = $('confirm-delete');
  const reauthentication = $('reauthentication');
  const accessStates = new Set(['anonymous', 'verification_required', 'application_required', 'pending', 'rejected', 'revoked', 'approved']);
  const errorMessages = {
    provider_unavailable: '이 로그인 방법은 아직 준비 중입니다. 다른 방법을 이용해 주세요.',
    invalid_request: '로그인 요청이 만료되었거나 확인되지 않았어요. 다시 로그인해 주세요.',
    access_denied: '로그인을 취소하셨어요. 원하실 때 다시 시작할 수 있습니다.',
    provider_error: '계정 정보를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.',
    rate_limited: '요청이 잠시 많아졌어요. 조금 기다린 뒤 다시 시도해 주세요.',
    server_error: '지금은 로그인할 수 없어요. 잠시 후 다시 시도해 주세요.',
    deletion_pending: '회원 탈퇴를 처리하고 있어요. 완료될 때까지 잠시 기다려 주세요.',
    storage_unavailable: '지금은 계정 정보를 처리할 수 없어요. 잠시 후 다시 시도해 주세요.',
    automatic_cancelled: '디스코드 추가 동의를 취소하셨어요. STOVE 프로필로 인증하거나 다시 시도할 수 있습니다.',
    automatic_identity_mismatch: '로그인한 계정과 다른 디스코드 계정이에요. 같은 계정으로 다시 시도해 주세요.',
    automatic_character_mismatch: '선택한 캐릭터와 디스코드에서 인증한 대표 캐릭터가 일치하지 않아요.',
    automatic_role_missing: '디스코드 인증 서버의 인증 역할을 확인하지 못했어요.',
    automatic_guild_mismatch: '선택한 캐릭터가 루페온 서버인지 확인해 주세요.',
    automatic_permission_denied: '디스코드 추가 동의를 확인하지 못했어요. 다시 시도해 주세요.',
    automatic_membership_missing: '디스코드 인증 서버 또는 게임 캐릭터 정보를 확인하지 못했어요.',
    automatic_manual_required: '디스코드 소유 인증을 사용할 수 없어요. STOVE 프로필로 인증해 주세요.',
    automatic_discord_required: '디스코드로 로그인한 계정에서 이용할 수 있어요. 카카오 계정은 STOVE 프로필로 인증해 주세요.',
    automatic_state_changed: '로그인 또는 인증 상태가 변경되었어요. 현재 상태를 확인해 주세요.',
    automatic_not_pending: '소유 인증할 캐릭터를 먼저 선택해 주세요.',
    automatic_rate_limited: '디스코드 인증 요청이 많아요. 잠시 후 다시 시도해 주세요.',
    automatic_unavailable: '디스코드 소유 인증을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.',
    character_already_verified: '이 캐릭터는 다른 홈페이지 계정에서 사용 중이에요. 운영진에게 계정을 확인해 주세요.',
    ownership_state_changed: '캐릭터 인증 상태가 변경되었어요. 현재 상태를 확인해 주세요.',
  };
  let session = null, generation = 0, actionSerial = 0, busy = false, refreshTask = null, expiredNotice = '';
  const controllers = new Set();
  const query = new URLSearchParams(location.search);
  const initialError = errorMessages[query.get('error')] || '';
  const ownershipSuccess = query.get('ownership') === 'verified';
  if (isAccountPage && (query.has('error') || query.has('ownership') || query.has('guild_auto'))) {
    for (const key of ['error', 'ownership', 'guild_auto']) query.delete(key);
    history.replaceState(null, '', `${location.pathname}${query.size ? `?${query}` : ''}${location.hash}`);
  }
  const publish = (detail) => window.publishPogeunSiteAccess?.(detail);
  function announce(message, error = false) { if (status) { status.textContent = message; status.classList.toggle('error', error); } }
  async function request(path, options = {}, timeoutMs = 10000) {
    const controller = new AbortController(); controllers.add(controller);
    const externalSignal = options.signal;
    const abort = () => controller.abort();
    externalSignal?.addEventListener('abort', abort, { once: true });
    if (externalSignal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal });
      const data = response.status !== 204 && response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
      return { response, data };
    } finally { clearTimeout(timer); controllers.delete(controller); externalSignal?.removeEventListener('abort', abort); }
  }
  async function onAuthenticationError(error) {
    const authenticated = error.status !== 401;
    invalidate(); clearPrivate(); publish({ approved: false, authenticated, status: authenticated ? 'unavailable' : 'anonymous' });
    await refresh(error.status === 401 ? '로그인이 만료되었어요. 다시 로그인해 주세요.' : '로그인과 가입 상태를 다시 확인해 주세요.', false);
    if (retry && !document.hidden) retry.hidden = false;
  }
  const onboarding = isAccountPage && typeof window.PogeunOnboarding === 'function' ? new window.PogeunOnboarding({
    request, getSession: () => session, refreshAccess: () => refresh(), onAuthenticationError,
  }) : null;
  const memberCharacters = isAccountPage && typeof window.PogeunMemberCharacters === 'function' ? new window.PogeunMemberCharacters({
    request, getSession: () => session, onAuthenticationError,
  }) : null;
  function invalidate() { generation++; for (const controller of controllers) controller.abort(); controllers.clear(); refreshTask = null; }
  function clearPrivate({ preserveDraft = false } = {}) {
    onboarding?.clear({ preserveDraft }); memberCharacters?.clear(); session = null;
    if (accountLink) accountLink.textContent = '로그인';
    if (guildLink) guildLink.hidden = true;
    if (!isAccountPage) return;
    signedIn.hidden = true; $('account-guild').hidden = true;
    for (const id of ['member-name', 'member-provider', 'member-character', 'delete-provider-note']) $(id).textContent = '';
    $('account-guild-link').hidden = true;
    if (deleteDialog.open) deleteDialog.close();
  }
  function validSession(data) {
    if (!data || typeof data.authenticated !== 'boolean' || !data.providers || typeof data.providers.discord !== 'boolean' || typeof data.providers.kakao !== 'boolean') return false;
    if (data.authenticated && (!data.user || typeof data.user.id !== 'string' || typeof data.user.displayName !== 'string' || !['discord', 'kakao'].includes(data.user.provider) || typeof data.csrfToken !== 'string')) return false;
    const access = data.siteAccess;
    return !!access && typeof access.approved === 'boolean' && access.authenticated === data.authenticated && accessStates.has(access.status) &&
      (access.approved === (data.authenticated && access.status === 'approved')) && (data.authenticated ? access.status !== 'anonymous' : access.status === 'anonymous');
  }
  function render(data, message = '') {
    session = data;
    if (accountLink) accountLink.textContent = data.authenticated ? '내 계정' : '로그인';
    if (guildLink) guildLink.hidden = !data.siteAccess.approved;
    publish(data.siteAccess);
    if (!isAccountPage) return;
    memberCharacters?.render();
    signedIn.hidden = !data.authenticated; signedOut.hidden = data.authenticated; retry.hidden = true; reauthentication.hidden = true;
    if (data.authenticated) {
      $('account-title').textContent = '내 계정'; $('member-name').textContent = data.user.displayName;
      $('member-provider').textContent = `${data.user.provider === 'discord' ? '디스코드' : '카카오'}로 로그인한 계정`;
      const character = data.registration?.character;
      $('member-character').textContent = character?.characterName ? `등록 캐릭터 · ${character.characterName}` : '';
      $('member-character').hidden = !character?.characterName;
      $('member-name-help').textContent = data.registration?.state === 'complete' ? '기존에 설정한 홈페이지 닉네임을 사용해요.' : '로그인한 계정의 표시 이름을 사용해요.';
      $('account-guild-link').hidden = !data.siteAccess.approved;
      announce(message || (data.siteAccess.approved ? '포근해용에 오신 것을 환영해요.' : '대표 캐릭터 인증과 가입 신청을 이어서 진행해 주세요.'));
      if (!onboarding) { $('account-guild').hidden = true; retry.hidden = false; announce('가입 화면을 불러오지 못했어요. 페이지를 새로 열어 주세요.', true); }
    } else {
      $('account-title').textContent = '로그인';
      for (const provider of ['discord', 'kakao']) $('login-' + provider).disabled = data.providers[provider] !== true;
      $('kakao-readiness').hidden = data.providers.kakao === true;
      announce(message || '익숙한 계정으로 시작해 보세요.', !!message && message === initialError);
    }
  }
  function refresh(message = '', loadOnboarding = true) {
    if (document.hidden) return Promise.resolve();
    if (refreshTask) return refreshTask;
    const current = ++generation;
    const task = (async () => {
      try {
        const { response, data } = await request('/api/auth/session');
        if (current !== generation) return;
        if (!response.ok || !validSession(data)) throw new Error('invalid session');
        const changedAccount = session?.authenticated && data.authenticated && session.user.id !== data.user.id;
        if (changedAccount || !data.authenticated) {
          if (changedAccount) { actionSerial++; busy = false; for (const controller of controllers) controller.abort(); }
          if (session?.authenticated && !data.authenticated) expiredNotice = '로그인이 만료되었어요. 다시 로그인해 주세요.';
          publish({ approved: false, authenticated: data.authenticated, status: data.authenticated ? 'unavailable' : 'anonymous' });
          clearPrivate();
        }
        if (data.authenticated) expiredNotice = '';
        render(data, message || expiredNotice);
        if (isAccountPage && data.authenticated && loadOnboarding) await Promise.all([onboarding?.load(), memberCharacters?.load()]);
      } catch {
        if (current !== generation) return;
        const authenticated = session?.authenticated === true;
        clearPrivate(); publish({ approved: false, authenticated, status: 'unavailable' });
        if (isAccountPage) { signedIn.hidden = signedOut.hidden = true; retry.hidden = false; announce('로그인 상태를 확인하지 못했어요. 잠시 후 다시 확인해 주세요.', true); }
      }
    })();
    refreshTask = task;
    void task.finally(() => { if (refreshTask === task) refreshTask = null; });
    return task;
  }
  window.refreshPogeunSiteAccess = refresh;
  for (const provider of ['discord', 'kakao']) $('login-' + provider)?.addEventListener('click', () => {
    if (busy || session?.providers?.[provider] !== true) return;
    busy = true; invalidate(); publish({ approved: false, authenticated: false, status: 'anonymous' });
    announce('로그인 화면으로 이동하고 있어요.'); location.assign(`/auth/${provider}/start`);
  });
  logout?.addEventListener('click', async () => {
    if (busy || !session?.authenticated) return;
    const csrfToken = session.csrfToken;
    const action = ++actionSerial;
    busy = true; logout.disabled = true; invalidate(); clearPrivate(); publish({ approved: false, authenticated: false, status: 'anonymous' });
    announce('로그아웃하고 있어요.');
    try {
      const { response } = await request('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } });
      if (action !== actionSerial) return;
      if (response.status !== 204) throw new Error('logout failed');
      await refresh('로그아웃했어요. 다음에 또 만나요.');
    } catch { if (action === actionSerial) { await refresh(); if (action === actionSerial) announce('로그아웃 결과를 확인하지 못했어요. 현재 상태를 확인하고 다시 시도해 주세요.', true); } }
    finally { if (action === actionSerial) { busy = false; logout.disabled = false; } }
  });
  $('delete-account')?.addEventListener('click', () => {
    if (busy || !session?.authenticated) return;
    $('delete-provider-note').textContent = session.user.provider === 'kakao' ? '카카오 계정과 포근해용의 연결도 함께 해제합니다.' : '디스코드 계정과 디스코드 서버 가입 상태는 그대로 유지됩니다.';
    deleteDialog.showModal(); $('cancel-delete').focus();
  });
  $('cancel-delete')?.addEventListener('click', () => { if (!busy) deleteDialog.close(); });
  deleteDialog?.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  confirmDelete?.addEventListener('click', async () => {
    if (busy || !session?.authenticated) return;
    const csrfToken = session.csrfToken;
    const action = ++actionSerial;
    busy = true; confirmDelete.disabled = true; $('cancel-delete').disabled = true; confirmDelete.textContent = '삭제 처리 중…';
    invalidate(); onboarding?.clear(); memberCharacters?.clear(); publish({ approved: false, authenticated: true, status: 'unavailable' });
    try {
      const { response, data } = await request('/api/auth/account', { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken } });
      if (action !== actionSerial) return;
      deleteDialog.close();
      if (response.status === 204) { clearPrivate(); await refresh('회원 탈퇴를 완료했어요. 계정·가입 신청·승인·관리자 권한과 로그인 세션을 삭제했습니다.'); }
      else if (response.status === 401 && data?.error === 'reauthentication_required') {
        await refresh();
        if (action === actionSerial && session?.authenticated) { reauthentication.hidden = false; announce('최근 로그인 확인이 필요해요. 다시 로그인한 뒤 탈퇴해 주세요.', true); $('reauthenticate').focus(); }
      } else { await refresh(); if (action === actionSerial) announce('회원 탈퇴를 완료하지 못했어요. 잠시 후 현재 상태를 다시 확인해 주세요.', true); }
    } catch { if (action === actionSerial) { deleteDialog.close(); await refresh(); if (action === actionSerial) announce('탈퇴 결과를 확인하지 못했어요. 잠시 후 다시 확인해 주세요.', true); } }
    finally { if (action === actionSerial) { busy = false; confirmDelete.disabled = false; $('cancel-delete').disabled = false; confirmDelete.textContent = '탈퇴하고 정보 삭제'; } }
  });
  $('reauthenticate')?.addEventListener('click', () => {
    if (busy || !session?.authenticated || !['discord', 'kakao'].includes(session.user.provider)) return;
    const provider = session.user.provider;
    busy = true; invalidate(); clearPrivate(); publish({ approved: false, authenticated: false, status: 'anonymous' });
    location.assign(`/auth/${provider}/start`);
  });
  retry?.addEventListener('click', () => { if (!busy) void refresh(); });
  function suspend() {
    const authenticated = session?.authenticated === true;
    actionSerial++; busy = false; invalidate(); clearPrivate({ preserveDraft: true }); publish({ approved: false, authenticated, status: 'unavailable' });
    if (isAccountPage) { logout.disabled = confirmDelete.disabled = $('cancel-delete').disabled = false; confirmDelete.textContent = '탈퇴하고 정보 삭제'; }
  }
  window.addEventListener('pagehide', suspend);
  window.addEventListener('pageshow', event => { if (event.persisted) { busy = false; void refresh(); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); else { busy = false; void refresh(); } });
  window.addEventListener('focus', () => { if (!document.hidden && !busy && !onboarding?.busy && !memberCharacters?.busy && !deleteDialog?.open) void refresh(); });
  setInterval(() => { if (!document.hidden && !busy && !onboarding?.busy && !memberCharacters?.busy && !deleteDialog?.open) void refresh(); }, 60000);
  void refresh(initialError || (ownershipSuccess ? '소유 인증 결과를 확인하고 있어요. 가입 신청은 별도로 진행해 주세요.' : ''));
})();
