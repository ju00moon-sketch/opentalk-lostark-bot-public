(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const nameKey = value => typeof value === 'string' ? value.normalize('NFC').trim().toLowerCase() : '';
  const validName = value => typeof value === 'string' && /^[가-힣A-Za-z0-9]{2,12}$/.test(value);
  function validProfileUrl(value) {
    try {
      const url = new URL(value);
      return value.length <= 2048 && url.protocol === 'https:' && url.hostname === 'profile.onstove.com' && !url.username && !url.password && !url.port;
    } catch { return false; }
  }
  const messages = {
    character_not_found: '캐릭터를 찾지 못했어요. 이름을 확인해 주세요.',
    character_unavailable: '캐릭터 정보를 확인하지 못했어요. 잠시 후 다시 찾아 주세요.',
    character_rate_limited: '캐릭터 조회가 많아요. 잠시 후 다시 시도해 주세요.',
    invalid_request: '입력한 캐릭터명과 프로필 주소를 확인해 주세요.',
    ownership_state_changed: '인증 상태가 변경되었어요. 현재 상태를 확인한 뒤 다시 진행해 주세요.',
    ownership_required: '선택한 캐릭터의 소유 인증을 먼저 마쳐 주세요.',
    already_approved: '이미 이용 승인을 받은 계정입니다. 현재 상태를 확인해 주세요.',
    verification_required: '새 인증 코드를 발급해 주세요.',
    verification_expired: '인증 코드가 만료되었어요. 새 코드로 프로필 소개를 갱신해 주세요.',
    verification_locked: '인증 시도 횟수를 모두 사용했어요. 새 코드를 발급해 주세요.',
    verification_cooldown: '잠시 기다린 뒤 새 코드를 발급할 수 있어요.',
    verification_busy: '앞선 인증을 확인하고 있어요. 잠시 후 다시 시도해 주세요.',
    verification_unavailable: '소유 인증을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.',
    stove_profile_invalid: 'STOVE 프로필 주소를 확인해 주세요.',
    stove_code_missing: '프로필 소개에서 인증 코드를 찾지 못했어요. 코드를 그대로 저장했는지 확인해 주세요.',
    stove_character_mismatch: '선택한 캐릭터가 해당 STOVE 계정에 연결되어 있지 않아요.',
    stove_private: 'STOVE 프로필을 공개한 뒤 다시 확인해 주세요.',
    stove_unavailable: 'STOVE 정보를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.',
    character_already_verified: '이 캐릭터는 다른 계정에서 사용 중이에요. 운영진에게 계정을 확인해 주세요.',
    automatic_unavailable: '디스코드 소유 인증을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.',
    rate_limited: '요청이 잠시 많아요. 조금 기다린 뒤 다시 시도해 주세요.',
  };
  const text = (tag, value, className = '') => { const node = document.createElement(tag); node.textContent = value; node.className = className; return node; };
  function validateOwnership(value) {
    if (!value || !['none', 'pending', 'verified'].includes(value.state) || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      ![null, 'stove', 'discord'].includes(value.method) || !value.discord || typeof value.discord.enabled !== 'boolean' || typeof value.discord.eligible !== 'boolean') throw new Error('invalid ownership');
    if (value.state === 'none' && (value.revision !== 0 || value.character !== null || value.method !== null || value.verifiedAt !== null || value.challenge !== null)) throw new Error('invalid empty ownership');
    if (value.state !== 'none' && value.revision < 1) throw new Error('invalid revision');
    if (value.state === 'verified' && (!['stove', 'discord'].includes(value.method) || !Number.isSafeInteger(value.verifiedAt) || value.verifiedAt <= 0 || value.challenge !== null)) throw new Error('invalid verified ownership');
    if (value.state === 'pending' && (value.method !== null || value.verifiedAt !== null)) throw new Error('invalid pending ownership');
    const character = value.character;
    if (value.state !== 'none' && (!character || !validName(character.characterName) || typeof character.serverName !== 'string' || typeof character.characterClass !== 'string' ||
      typeof character.itemLevel !== 'number' || !Number.isFinite(character.itemLevel) || character.itemLevel < 0)) throw new Error('invalid character');
    const challenge = value.challenge;
    if (challenge !== null && (!challenge || !/^PG-[A-F0-9]{24}$/.test(challenge.code) || !Number.isFinite(challenge.expiresAt) || !Number.isFinite(challenge.reissueAt) ||
      !Number.isInteger(challenge.attemptsRemaining) || challenge.attemptsRemaining < 0 || challenge.attemptsRemaining > 5)) throw new Error('invalid challenge');
    return value;
  }
  function validateGuild(value) {
    if (!value || !['member', 'admin', 'owner'].includes(value.role) || typeof value.canViewSheet !== 'boolean' ||
      (value.membership !== null && (!value.membership || !['pending', 'approved', 'rejected', 'revoked'].includes(value.membership.status) ||
      !(validName(value.membership.characterName) || (value.membership.status === 'approved' && value.membership.characterName === ''))))) throw new Error('invalid membership');
    return value;
  }

  class Onboarding {
    constructor({ request, getSession, refreshAccess, onAuthenticationError }) {
      Object.assign(this, { request, getSession, refreshAccess, onAuthenticationError });
      this.generation = 0; this.ownership = null; this.guild = null; this.working = false; this.loading = false; this.guideStep = 0; this.draft = null;
      $('ownership-character-form').addEventListener('submit', event => {
        event.preventDefault();
        const characterName = $('ownership-character-name').value.normalize('NFC').trim();
        if (!validName(characterName)) { this.announce('캐릭터명은 한글·영문·숫자 2~12자로 입력해 주세요.', true); return; }
        if (this.guild?.membership?.status === 'pending' && nameKey(characterName) !== nameKey(this.guild.membership.characterName)) { this.announce('가입 신청에 등록된 캐릭터를 인증해 주세요.', true); return; }
        void this.run('/api/auth/ownership/character', { characterName }, '캐릭터를 찾았어요. 소유 인증을 진행해 주세요.');
      });
      $('ownership-character-name').addEventListener('input', () => this.updateControls());
      $('ownership-profile-url').addEventListener('input', () => this.captureDraft());
      $('ownership-guide-start').addEventListener('click', () => this.setGuideStep(1, true));
      $('ownership-guide-opened').addEventListener('click', () => this.setGuideStep(2, true));
      $('ownership-guide-address').addEventListener('click', () => this.setGuideStep(2, true));
      $('ownership-guide-back').addEventListener('click', () => this.setGuideStep(Math.max(0, this.guideStep - 1), true));
      $('ownership-url-form').addEventListener('submit', event => {
        event.preventDefault();
        if (this.busy || this.guideStep !== 2) return;
        const value = $('ownership-profile-url').value.trim();
        if (!validProfileUrl(value)) { this.announce(messages.stove_profile_invalid, true); return; }
        $('ownership-profile-url').value = value;
        this.setGuideStep(3, true); this.announce('프로필 소개에 코드를 저장한 뒤 인증을 확인해 주세요.');
      });
      $('ownership-verify-form').addEventListener('submit', event => {
        event.preventDefault();
        if (this.guideStep !== 3 || !this.codeValid() || !this.selectionMatches()) return;
        const profileUrl = $('ownership-profile-url').value.trim();
        if (!validProfileUrl(profileUrl)) {
          this.announce(messages.stove_profile_invalid, true); return;
        }
        void this.run('/api/auth/ownership/verify', { revision: this.ownership.revision, profileUrl }, '소유 인증을 마쳤어요. 가입 신청을 별도로 보내 주세요.');
      });
      $('ownership-renew').addEventListener('click', () => {
        if (this.ownership?.state !== 'pending' || this.ownership.challenge?.reissueAt > Date.now()) return;
        void this.run('/api/auth/ownership/renew', { revision: this.ownership.revision }, '새 코드를 발급했어요. 프로필 소개도 새 코드로 바꿔 주세요.');
      });
      $('ownership-discord-start').addEventListener('click', () => {
        if (!this.ownership?.discord.eligible || !this.selectionMatches()) return;
        void this.run('/api/auth/ownership/discord', { revision: this.ownership.revision });
      });
      $('guild-application').addEventListener('submit', event => {
        event.preventDefault();
        if (!this.canApply()) return;
        void this.run('/api/auth/guild/apply', { characterName: this.ownership.character.characterName }, '가입 신청을 보냈어요. 운영진의 최종 승인을 기다려 주세요.');
      });
      $('ownership-retry').addEventListener('click', () => { if (!this.busy) void this.refreshAccess(); });
      $('ownership-copy').addEventListener('click', async () => {
        if (!this.codeValid()) return;
        const current = this.generation;
        try {
          if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
          await navigator.clipboard.writeText(this.ownership.challenge.code);
          if (current === this.generation) this.announce('인증 코드를 복사했어요.');
        } catch { if (current === this.generation) { $('ownership-code').focus(); $('ownership-code').select(); this.announce('선택된 코드를 직접 복사해 주세요.'); } }
      });
      setInterval(() => { if (!document.hidden && this.getSession()?.authenticated) this.updateControls(); }, 1000);
    }
    get busy() { return this.working || this.loading; }
    captureDraft() {
      const accountId = this.getSession()?.user?.id;
      if (accountId && this.ownership?.state === 'pending') this.draft = {
        accountId, revision: this.ownership.revision, characterName: this.ownership.character.characterName,
        profileUrl: $('ownership-profile-url').value.slice(0, 2048), step: this.guideStep,
      };
    }
    restoreDraft() {
      const draft = this.draft;
      if (draft && draft.accountId === this.getSession()?.user?.id && this.ownership?.state === 'pending' &&
        draft.revision === this.ownership.revision && draft.characterName === this.ownership.character.characterName) {
        $('ownership-profile-url').value = draft.profileUrl; this.guideStep = draft.step;
      } else { this.draft = null; this.guideStep = 0; $('ownership-profile-url').value = ''; }
    }
    setGuideStep(step, focus = false) {
      if (this.busy || this.ownership?.state !== 'pending') return;
      this.guideStep = step; this.captureDraft(); this.renderGuide();
      if (focus) {
        const panel = document.querySelector(`[data-ownership-step="${step}"]`);
        const heading = panel.querySelector('h5') || panel;
        heading.tabIndex = -1; heading.focus();
      }
    }
    renderGuide() {
      document.querySelectorAll('[data-ownership-step]').forEach(panel => { panel.hidden = Number(panel.dataset.ownershipStep) !== this.guideStep; });
      $('ownership-guide-progress').textContent = `${this.guideStep + 1} / 4 · ${['인증 안내', '프로필 접속', '프로필 주소', '소개 코드 등록'][this.guideStep]}`;
      $('ownership-guide-back').hidden = this.guideStep === 0;
      $('ownership-selected-url').textContent = $('ownership-profile-url').value ? `확인할 프로필 · ${$('ownership-profile-url').value}` : '';
    }
    selectionMatches() { return !!this.ownership?.character && nameKey($('ownership-character-name').value) === nameKey(this.ownership.character.characterName); }
    codeValid() { const code = this.ownership?.challenge; return this.ownership?.state === 'pending' && !!code?.code && code.expiresAt > Date.now() && code.attemptsRemaining > 0; }
    canApply() { return this.ownership?.state === 'verified' && this.selectionMatches() && !['pending', 'approved'].includes(this.guild?.membership?.status) && !this.getSession()?.siteAccess?.approved; }
    announce(message, error = false) { $('application-status').textContent = message; $('application-status').classList.toggle('error', error); }
    clear({ preserveDraft = false } = {}) {
      if (preserveDraft) this.captureDraft(); else this.draft = null;
      this.generation++; this.ownership = null; this.guild = null; this.working = false; this.loading = false;
      $('account-guild').hidden = true;
      for (const id of ['membership-status', 'membership-description', 'ownership-character-profile', 'membership-character', 'application-status', 'ownership-expiry', 'ownership-selected-url', 'ownership-guide-progress']) $(id).replaceChildren();
      for (const id of ['ownership-character-name', 'ownership-code', 'ownership-profile-url']) $(id).value = '';
      $('ownership-proofs').hidden = $('guild-application').hidden = $('ownership-character-profile').hidden = true;
      $('ownership-retry').hidden = true;
      $('ownership-character-name').readOnly = false;
    }
    async load() {
      if (this.busy || !this.getSession()?.authenticated || document.hidden) return;
      const current = ++this.generation; this.loading = true;
      this.updateControls();
      try {
        const [ownership, guild] = await Promise.all([this.request('/api/auth/ownership'), this.request('/api/auth/guild')]);
        if (current !== this.generation) return;
        for (const result of [ownership, guild]) if (!result.response.ok) throw Object.assign(new Error('request failed'), { status: result.response.status, code: result.data?.error });
        this.captureDraft();
        this.ownership = validateOwnership(ownership.data); this.guild = validateGuild(guild.data);
        this.restoreDraft();
        if (!$('ownership-character-name').value && this.ownership.character) $('ownership-character-name').value = this.ownership.character.characterName;
        this.render(); $('ownership-retry').hidden = true;
      } catch (error) {
        if (current !== this.generation) return;
        if ([401, 403].includes(error.status)) { await this.onAuthenticationError(error); return; }
        this.ownership = null; this.guild = null; this.draft = null;
        $('ownership-proofs').hidden = $('guild-application').hidden = $('ownership-character-profile').hidden = $('ownership-character-form').hidden = true;
        for (const id of ['ownership-character-profile', 'membership-status', 'membership-description', 'membership-character', 'ownership-selected-url']) $(id).replaceChildren();
        $('ownership-code').value = $('ownership-profile-url').value = '';
        $('account-guild').hidden = false; $('ownership-retry').hidden = false;
        this.announce('가입 상태를 확인하지 못했어요. 다시 확인해 주세요.', true);
      } finally { if (current === this.generation) { this.loading = false; this.updateControls(); } }
    }
    render() {
      const ownership = this.ownership, membership = this.guild?.membership;
      if (!ownership || !this.guild) return;
      const approved = this.getSession()?.siteAccess?.approved === true;
      const pending = membership?.status === 'pending';
      const pendingVerified = pending && ownership.state === 'verified' && nameKey(ownership.character.characterName) === nameKey(membership.characterName);
      const state = approved ? 'approved' : membership?.status || (ownership.state === 'verified' ? 'application_required' : 'verification_required');
      const copy = {
        approved: ['이용 승인 완료', '캐릭터·시장·길드 기능을 이용할 수 있어요.'],
        pending: ['운영진 검토 중', '가입 신청을 보냈어요. 운영진의 최종 승인 후 모든 기능을 이용할 수 있습니다.'],
        rejected: ['신청 확인 필요', '신청이 승인되지 않았어요. 캐릭터와 인증 상태를 확인한 뒤 다시 신청할 수 있습니다.'],
        revoked: ['이용 승인 변경', '현재 이용 승인이 철회되어 있어요. 다시 신청하거나 운영진에게 문의해 주세요.'],
        application_required: ['소유 인증 완료', '인증된 캐릭터로 가입 신청을 보내 주세요.'],
        verification_required: ['캐릭터 소유 인증', ownership.state === 'none' ? '대표 캐릭터를 찾은 뒤 본인 계정에 연결된 캐릭터인지 확인해 주세요.' : '선택한 캐릭터의 소유 인증을 진행해 주세요.'],
      }[state];
      $('account-guild').hidden = false;
      $('membership-status').textContent = copy[0]; $('membership-description').textContent = copy[1];
      if (pending && !pendingVerified) { $('membership-status').textContent = '신청 캐릭터 인증 필요'; $('membership-description').textContent = '기존 가입 신청은 보관되어 있어요. 신청한 캐릭터의 소유 인증을 마치면 운영진이 검토할 수 있습니다.'; }
      const step = approved ? 4 : pendingVerified ? 3 : ownership.state === 'verified' ? 2 : ownership.state === 'pending' ? 1 : 0;
      [...$('onboarding-steps').children].forEach((item, index) => { item.dataset.complete = String(index < step); if (index === Math.min(step, 3)) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current'); });
      $('ownership-character-form').hidden = approved || pendingVerified;
      $('ownership-character-name').readOnly = pending;
      if (pending) $('ownership-character-name').value = membership.characterName;
      const box = $('ownership-character-profile'); box.replaceChildren(); box.hidden = !ownership.character;
      if (ownership.character) {
        const c = ownership.character;
        box.append(text('h4', c.characterName), text('p', [c.serverName, c.characterClass, c.guildName].filter(Boolean).join(' · ')), text('p', `아이템 레벨 ${c.itemLevel.toLocaleString('ko-KR')}`));
        if (ownership.state === 'verified') box.append(text('p', `소유 인증 완료 · ${ownership.method === 'discord' ? '디스코드' : 'STOVE'}`, 'ownership-verified'));
      } else if (approved && membership?.characterName) { box.hidden = false; box.append(text('h4', membership.characterName)); }
      $('ownership-proofs').hidden = approved || pendingVerified || ownership.state !== 'pending' || !this.selectionMatches();
      $('membership-character').textContent = ownership.character ? `신청할 대표 캐릭터 · ${ownership.character.characterName}` : '';
      $('ownership-discord').hidden = !ownership.discord.enabled || !ownership.discord.eligible;
      this.renderGuide();
      this.updateControls();
    }
    updateControls() {
      const pending = this.ownership?.state === 'pending';
      const valid = this.codeValid();
      const code = valid ? this.ownership.challenge.code : '';
      if ($('ownership-code').value !== code) $('ownership-code').value = code;
      const wait = Math.max(0, Math.ceil(((this.ownership?.challenge?.reissueAt || 0) - Date.now()) / 1000));
      $('ownership-expiry').textContent = !pending ? '' : valid
        ? `${new Date(this.ownership.challenge.expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}까지 · 한국 시간${wait ? ` · ${wait}초 후 재발급 가능` : ''}`
        : '사용할 수 있는 코드가 없어요. 새 코드를 발급해 주세요.';
      for (const id of ['ownership-search', 'ownership-character-name', 'ownership-profile-url', 'ownership-guide-start', 'ownership-guide-opened', 'ownership-guide-address', 'ownership-guide-back', 'ownership-url-next']) $(id).disabled = this.busy;
      $('ownership-copy').disabled = !valid;
      $('ownership-renew').disabled = this.busy || !pending || wait > 0;
      $('ownership-verify').disabled = this.busy || !valid || !this.selectionMatches();
      $('ownership-discord-start').disabled = this.busy || !this.ownership?.discord.eligible || !this.selectionMatches();
      $('guild-application').hidden = !this.canApply();
      $('apply-guild').disabled = this.busy || !this.canApply();
    }
    async run(path, body, message = '') {
      const session = this.getSession();
      if (this.busy || !session?.authenticated || document.hidden) return;
      const current = this.generation;
      this.working = true; this.updateControls(); this.announce('확인하고 있어요.');
      try {
        const { response, data } = await this.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify(body) }, 20000);
        if (current !== this.generation) return;
        if (!response.ok) throw Object.assign(new Error('request failed'), { status: response.status, code: data?.error });
        if (path.endsWith('/discord')) {
          const url = new URL(data?.authorizationUrl);
          if (url.origin !== 'https://discord.com' || url.pathname !== '/oauth2/authorize' || url.username || url.password || url.hash) throw new Error('invalid authorization URL');
          window.publishPogeunSiteAccess?.({ approved: false, authenticated: true, status: 'verification_required' });
          location.assign(url.href); return;
        }
        if (path.endsWith('/apply')) this.guild = validateGuild(data);
        else {
          this.ownership = validateOwnership(data); $('ownership-character-name').value = data.character?.characterName || '';
          if (path.endsWith('/character')) { this.draft = null; this.guideStep = 0; $('ownership-profile-url').value = ''; }
          else this.captureDraft();
        }
        if (this.ownership.state !== 'pending') { this.draft = null; $('ownership-profile-url').value = ''; }
        this.render(); this.announce(message);
        await this.refreshAccess();
      } catch (error) {
        if (current !== this.generation) return;
        if ([401, 403].includes(error.status)) { await this.onAuthenticationError(error); return; }
        if (['verification_expired', 'verification_locked', 'verification_required'].includes(error.code) && this.ownership) this.ownership.challenge = null;
        this.announce(messages[error.code] || '요청 결과를 확인하지 못했어요. 가입 상태를 다시 확인한 뒤 진행해 주세요.', true);
        $('ownership-retry').hidden = false;
      } finally { if (current === this.generation) { this.working = false; this.updateControls(); } }
    }
  }
  window.PogeunOnboarding = Onboarding;
})();
