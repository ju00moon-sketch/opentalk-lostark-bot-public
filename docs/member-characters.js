(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const key = value => typeof value === 'string' ? value.normalize('NFC').toLowerCase() : '';
  const validName = value => typeof value === 'string' && /^[가-힣A-Za-z0-9]{2,12}$/.test(value);
  const shortText = value => typeof value === 'string' && value.length > 0 && value.length <= 80;
  const node = (tag, text, className = '') => { const element = document.createElement(tag); element.textContent = text; element.className = className; return element; };
  const messages = {
    member_character_changed: '다른 창에서 캐릭터 설정이 변경됐어요. 최신 목록을 확인한 뒤 다시 선택해 주세요.',
    member_anchor_required: '캐릭터 인증 정보를 확인할 수 없어요. 운영진에게 계정 상태를 확인해 주세요.',
    anchor_required: '캐릭터 인증 정보를 확인할 수 없어요. 운영진에게 계정 상태를 확인해 주세요.',
    member_character_unavailable: '캐릭터 목록을 불러오지 못했어요. 잠시 후 다시 확인해 주세요.',
    member_roster_unavailable: '캐릭터 목록을 불러오지 못했어요. 잠시 후 다시 확인해 주세요.',
    member_roster_not_found: '연결된 캐릭터를 찾지 못했어요. 잠시 후 목록을 새로고침해 주세요.',
    member_roster_selection_invalid: '선택한 캐릭터가 목록에서 변경됐어요. 최신 목록에서 다시 선택해 주세요.',
    character_unavailable: '캐릭터 목록을 불러오지 못했어요. 잠시 후 다시 확인해 주세요.',
    member_character_rate_limited: '캐릭터 조회가 많아요. 잠시 후 다시 확인해 주세요.',
    member_roster_rate_limited: '캐릭터 조회가 많아요. 잠시 후 다시 확인해 주세요.',
    character_rate_limited: '캐릭터 조회가 많아요. 잠시 후 다시 확인해 주세요.',
    rate_limited: '요청이 많아요. 잠시 후 다시 확인해 주세요.',
  };
  function validateProfile(profile) {
    return profile && validName(profile.characterName) && shortText(profile.serverName) && shortText(profile.characterClass) &&
      typeof profile.itemLevel === 'number' && Number.isFinite(profile.itemLevel) && profile.itemLevel >= 0 && profile.itemLevel <= 10000;
  }
  function validateRoster(data) {
    if (!data || !data.anchor || !shortText(data.anchor.source) || !validName(data.anchor.characterName) ||
      (data.anchor.serverName !== undefined && !shortText(data.anchor.serverName)) || !/^[a-f0-9]{64}$/.test(data.anchorFingerprint || '') ||
      !Number.isSafeInteger(data.revision) || data.revision < 0 || !Number.isFinite(data.updatedAt) || data.updatedAt <= 0 ||
      typeof data.csrfToken !== 'string' || data.csrfToken.length < 16 || data.csrfToken.length > 512 ||
      !Array.isArray(data.characters) || data.characters.length > 512 || !Array.isArray(data.groups) || data.groups.length > 512) throw new Error('Invalid roster');
    const characters = new Map();
    for (const profile of data.characters) {
      if (!validateProfile(profile) || characters.has(key(profile.characterName))) throw new Error('Invalid character');
      characters.set(key(profile.characterName), profile);
    }
    const matches = profile => {
      const original = characters.get(key(profile?.characterName));
      return validateProfile(profile) && !!original && ['serverName', 'characterClass', 'itemLevel'].every(field => original[field] === profile[field]);
    };
    if ((data.selected !== null && !matches(data.selected)) || (data.representative !== null && !matches(data.representative))) throw new Error('Invalid representative');
    if (data.selected && key(data.selected.characterName) !== key(data.representative?.characterName)) throw new Error('Mismatched representative');
    if (!data.selected && data.representative && key(data.representative.characterName) !== key(data.anchor.characterName)) throw new Error('Invalid default representative');
    const seen = new Set(), servers = new Set();
    for (const group of data.groups) {
      if (!shortText(group?.serverName) || servers.has(group.serverName) || !Array.isArray(group.characters) || !group.characters.length) throw new Error('Invalid group');
      servers.add(group.serverName);
      for (const profile of group.characters) {
        const id = key(profile?.characterName);
        if (!matches(profile) || profile.serverName !== group.serverName || seen.has(id)) throw new Error('Invalid grouped character');
        seen.add(id);
      }
    }
    if (seen.size !== characters.size) throw new Error('Incomplete roster');
    return data;
  }
  class MemberCharacters {
    constructor({ request, getSession, onAuthenticationError }) {
      Object.assign(this, { request, getSession, onAuthenticationError });
      this.generation = 0; this.accountId = null; this.data = null; this.choice = ''; this.loading = false; this.saving = false; this.controller = null;
      $('member-characters-form').addEventListener('submit', event => { event.preventDefault(); void this.save(); });
      $('member-characters-groups').addEventListener('change', event => {
        if (this.busy || event.target.name !== 'representative-character') return;
        const profile = this.data?.characters.find(row => key(row.characterName) === key(event.target.value));
        if (!profile) return;
        this.choice = profile.characterName; this.updateControls();
      });
      $('member-characters-reload').addEventListener('click', () => { if (!this.busy) void this.load(); });
      document.addEventListener('site:access', event => { if (event.detail?.approved !== true) this.clear(); });
    }
    get busy() { return this.loading || this.saving; }
    approved() { const session = this.getSession(); return !!(window.pogeunSiteAccess?.approved && session?.authenticated && session.siteAccess?.approved && session.user?.id); }
    current(generation, accountId) { return generation === this.generation && this.approved() && this.accountId === accountId && this.getSession().user.id === accountId; }
    announce(message, error = false) { const status = $('member-characters-status'); status.textContent = message; status.classList.toggle('error', error); }
    clear() {
      this.generation++; this.controller?.abort(); this.controller = null; this.accountId = null; this.data = null; this.choice = ''; this.loading = this.saving = false;
      $('member-characters').hidden = true; $('member-characters-form').hidden = true; $('member-characters-groups').replaceChildren();
      $('representative-character').textContent = ''; $('representative-character').hidden = true; this.announce(''); this.updateControls();
    }
    render() {
      if (!this.approved()) { this.clear(); return; }
      const accountId = this.getSession().user.id;
      if (this.accountId && this.accountId !== accountId) this.clear();
      this.accountId = accountId; $('member-characters').hidden = false;
      if (!this.data) { this.updateControls(); return; }
      const representative = this.data.representative;
      $('representative-character').textContent = representative ? `현재 대표 · ${representative.characterName} · ${representative.serverName}` : '대표 캐릭터를 선택해 주세요.';
      $('representative-character').hidden = false;
      const fragment = document.createDocumentFragment();
      for (const group of this.data.groups) {
        const fieldset = document.createElement('fieldset'); fieldset.className = 'member-character-server';
        fieldset.append(node('legend', group.serverName));
        for (const profile of group.characters) {
          const label = document.createElement('label'); label.className = 'member-character-option';
          const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'representative-character'; radio.value = profile.characterName;
          radio.checked = key(profile.characterName) === key(this.choice);
          const glyph = node('span', profile.characterClass.slice(0, 1), 'member-character-glyph'); glyph.setAttribute('aria-hidden', 'true');
          const content = node('span', '', 'member-character-info'); content.append(node('strong', profile.characterName), node('span', profile.characterClass));
          const level = node('span', `Lv. ${profile.itemLevel.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}`, 'member-character-level');
          level.setAttribute('aria-label', `아이템 레벨 ${profile.itemLevel}`); label.append(radio, glyph, content, level); fieldset.append(label);
        }
        fragment.append(fieldset);
      }
      $('member-characters-groups').replaceChildren(fragment); $('member-characters-form').hidden = !this.data.characters.length; this.updateControls();
    }
    updateControls() {
      const blocked = !this.approved() || this.busy;
      $('member-characters-reload').disabled = blocked;
      for (const radio of $('member-characters-groups').querySelectorAll('input')) radio.disabled = blocked;
      $('member-characters-save').disabled = blocked || !this.choice || key(this.choice) === key(this.data?.representative?.characterName);
      $('member-characters-save').textContent = this.saving ? '설정하고 있어요…' : '대표 캐릭터로 설정';
      $('member-characters').setAttribute('aria-busy', String(this.busy));
    }
    apply(data, { preserveChoice = false } = {}) {
      const previous = this.data;
      const retain = preserveChoice && previous?.revision === data.revision && previous.anchorFingerprint === data.anchorFingerprint &&
        data.characters.some(row => key(row.characterName) === key(this.choice));
      this.data = data;
      if (!retain) this.choice = data.representative?.characterName || data.selected?.characterName || '';
      this.render();
    }
    async load({ message = '', resetChoice = false } = {}) {
      if (!this.approved()) { this.clear(); return; }
      if (this.busy) return;
      this.render(); const accountId = this.accountId, generation = ++this.generation;
      const controller = new AbortController(); this.controller = controller; this.loading = true;
      this.announce('인증된 계정의 캐릭터 목록을 확인하고 있어요.'); this.updateControls();
      try {
        const { response, data } = await this.request('/api/auth/characters', { headers: { Accept: 'application/json' }, signal: controller.signal });
        if (!this.current(generation, accountId) || controller.signal.aborted) return;
        if ([401, 403].includes(response.status)) { this.clear(); await this.onAuthenticationError({ status: response.status }); return; }
        if (!response.ok) throw Object.assign(new Error('Roster unavailable'), { code: data?.error });
        this.apply(validateRoster(data), { preserveChoice: !resetChoice });
        this.announce(message || (data.characters.length ? '대표 캐릭터는 홈의 바로 조회와 캐릭터 검색 기본값에 사용됩니다.' : '연결된 캐릭터를 찾지 못했어요. 잠시 후 목록을 새로고침해 주세요.'));
      } catch (error) {
        if (!this.current(generation, accountId)) return;
        this.data = null; this.choice = ''; $('member-characters-groups').replaceChildren(); $('member-characters-form').hidden = true;
        $('representative-character').hidden = true; $('representative-character').textContent = '';
        this.announce(messages[error.code] || '캐릭터 목록을 불러오지 못했어요. 잠시 후 다시 확인해 주세요.', true);
      } finally {
        if (generation === this.generation) { this.loading = false; this.controller = null; this.updateControls(); }
      }
    }
    async save() {
      if (this.accountId !== this.getSession()?.user?.id) { this.clear(); this.render(); return; }
      if (!this.approved() || this.busy || !this.data || !this.data.characters.some(row => key(row.characterName) === key(this.choice)) ||
        key(this.choice) === key(this.data.representative?.characterName)) return;
      const accountId = this.accountId, generation = ++this.generation, characterName = this.choice, previous = this.data;
      const controller = new AbortController(); this.controller = controller; this.saving = true; this.updateControls();
      this.announce('대표 캐릭터를 설정하고 있어요.');
      try {
        const { response, data } = await this.request('/api/auth/characters/representative', { method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': this.data.csrfToken },
          body: JSON.stringify({ characterName, revision: this.data.revision, anchorFingerprint: this.data.anchorFingerprint }) });
        if (!this.current(generation, accountId) || controller.signal.aborted) return;
        if ([401, 403].includes(response.status)) { this.clear(); await this.onAuthenticationError({ status: response.status }); return; }
        if (!response.ok) {
          if ((response.status === 409 && data?.error === 'member_character_changed') || (response.status === 422 && data?.error === 'member_roster_selection_invalid')) {
            this.saving = false; this.controller = null; await this.load({ message: messages[data.error], resetChoice: true }); return;
          }
          throw Object.assign(new Error('Save failed'), { code: data?.error });
        }
        const verified = validateRoster(data);
        if (verified.anchorFingerprint !== previous.anchorFingerprint || verified.revision <= previous.revision ||
          key(verified.selected?.characterName) !== key(characterName) || key(verified.representative?.characterName) !== key(characterName)) throw new Error('Selection changed');
        this.apply(verified); this.announce(`${characterName} 캐릭터를 대표로 설정했어요.`);
        document.dispatchEvent(new CustomEvent('site:representative', { detail: { representative: verified.representative } }));
      } catch (error) {
        if (this.current(generation, accountId)) {
          if (['member_anchor_required', 'anchor_required'].includes(error.code)) {
            this.data = null; this.choice = ''; $('member-characters-groups').replaceChildren(); $('member-characters-form').hidden = true;
            $('representative-character').hidden = true; $('representative-character').textContent = '';
          }
          this.announce(messages[error.code] || '대표 캐릭터를 설정하지 못했어요. 잠시 후 다시 시도해 주세요.', true);
        }
      } finally {
        if (generation === this.generation) { this.saving = false; this.controller = null; this.updateControls(); }
      }
    }
  }
  window.PogeunMemberCharacters = MemberCharacters;
})();
