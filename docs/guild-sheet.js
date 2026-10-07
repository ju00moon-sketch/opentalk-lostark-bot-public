(() => {
  'use strict';
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const address = (row, column) => {
    let letters = '';
    while (column) { column--; letters = String.fromCharCode(65 + column % 26) + letters; column = Math.floor(column / 26); }
    return letters + row;
  };
  const position = value => {
    const match = /^([A-Z]+)([1-9]\d*)$/.exec(value);
    return match && [+match[2], [...match[1]].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0)];
  };
  const backgrounds = {
    '#FFFFFF': 'var(--guild-cell-surface)', '#000000': 'var(--guild-cell-muted)', '#666666': 'var(--guild-cell-muted)',
    '#FCE5CD': 'var(--guild-cell-gold)', '#D9EAD3': 'var(--guild-cell-accent)', '#D0CECE': 'var(--guild-cell-muted)',
    '#4A86E8': 'var(--guild-cell-accent)', '#FFFF00': 'var(--guild-cell-gold)', '#EAD1DC': 'var(--guild-cell-job)',
    '#F9CB9C': 'var(--guild-cell-gold)', '#C9DAF8': 'var(--guild-cell-accent)', '#9FC5E8': 'var(--guild-cell-accent)',
    '#8E7CC3': 'var(--guild-cell-job)', '#F3F3F3': 'var(--guild-cell-surface)', '#F6B26B': 'var(--guild-cell-gold)',
    '#E06666': 'var(--guild-cell-caution)', '#E69138': 'var(--guild-cell-gold)', '#93C47D': 'var(--guild-cell-accent)',
    '#46BDC6': 'var(--guild-cell-accent)', '#FF4C4C': 'var(--guild-cell-caution)', '#FF0000': 'var(--guild-cell-caution)',
    '#0B5394': 'var(--guild-cell-accent)', '#0000FF': 'var(--guild-cell-accent)', '#0C343D': 'var(--guild-cell-accent)',
    '#6FA8DC': 'var(--guild-cell-accent)', '#FFF2CC': 'var(--guild-cell-gold)', '#D9D9D9': 'var(--guild-cell-muted)',
    '#134F5C': 'var(--guild-cell-accent)', '#A4C2F4': 'var(--guild-cell-accent)'
  };
  // Presentation only: keep the imported workbook and saved values unchanged.
  function presentStyle(source) {
    const style = {...source};
    const background = source.backgroundColor?.toUpperCase();
    const color = source.color?.toUpperCase();
    if (background) style.backgroundColor = backgrounds[background] || 'var(--guild-cell-surface)';
    if (color && color === background) style.color = style.backgroundColor;
    else if (color === '#FF0000') style.color = 'var(--theme-danger)';
    else if (color === '#0000FF') style.color = 'var(--accent)';
    else if (color) style.color = 'var(--text)';
    if (source.fontFamily) style.fontFamily = 'var(--body)';
    if (source.fontSize) style.fontSize = source.fontSize >= 30 ? 24 : source.fontSize >= 20 ? 18 : Math.max(13, Math.min(source.fontSize, 17));
    if (source.fontWeight === 'bold' || source.fontWeight === 700) style.fontWeight = 600;
    for (const edge of ['borderTop', 'borderRight', 'borderBottom', 'borderLeft']) {
      if (source[edge]) style[edge] = source[edge].replace(/#[0-9A-F]{6}/gi, 'var(--guild-cell-border)');
    }
    return style;
  }

  class GuildSheet {
    constructor({root, request, csrf, accessError, onChange = () => {}}) {
      this.root = root;
      this.request = request;
      this.csrf = csrf;
      this.accessError = accessError;
      this.onChange = onChange;
      this.epoch = 0;
      this.selected = '';
      this.undo = null;
      this.busy = false;
      this.data = null;
      this.build();
    }

    build() {
      this.root.replaceChildren();
      const toolbar = element('div', 'schedule-toolbar');
      const searchLabel = element('label', 'schedule-search-label', '닉네임 찾기');
      this.search = element('input', 'schedule-search');
      this.search.type = 'search';
      this.search.placeholder = '현재 시트에서 찾기';
      this.search.maxLength = 100;
      searchLabel.append(this.search);
      const find = element('button', 'quiet-button', '다음 찾기');
      find.type = 'button';
      find.addEventListener('click', () => this.find());
      this.search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); this.find(); } });
      this.undoButton = element('button', 'quiet-button', '내 마지막 수정 되돌리기');
      this.undoButton.type = 'button';
      this.undoButton.disabled = true;
      this.undoButton.addEventListener('click', () => this.revert());
      this.hiddenLabel = element('label', 'schedule-hidden-label');
      this.hiddenToggle = element('input');
      this.hiddenToggle.type = 'checkbox';
      this.hiddenToggle.addEventListener('change', () => this.renderTabs());
      this.hiddenLabel.append(this.hiddenToggle, document.createTextNode('숨긴 시트 보기'));
      this.hiddenLabel.hidden = true;
      toolbar.append(searchLabel, find, this.undoButton, this.hiddenLabel);
      this.message = element('p', 'schedule-status');
      this.message.setAttribute('role', 'status');
      this.message.setAttribute('aria-live', 'polite');
      this.viewport = element('div', 'schedule-viewport');
      this.viewport.tabIndex = 0;
      this.viewport.setAttribute('role', 'region');
      this.viewport.setAttribute('aria-label', '길드 일정표. 가로와 세로로 스크롤할 수 있습니다.');
      this.tabs = element('div', 'schedule-tabs');
      this.tabs.setAttribute('role', 'tablist');
      this.tabs.setAttribute('aria-label', '일정 시트');
      const context = element('div', 'schedule-context');
      const current = element('div', 'schedule-current');
      current.append(element('span', 'schedule-current-label', '보고 있는 시트'));
      this.currentTitle = element('h3', 'schedule-current-title');
      current.append(this.currentTitle);
      const legend = element('div', 'schedule-legend');
      legend.setAttribute('aria-label', '일정표 색상 안내');
      for (const [kind, label] of [['first', '첫 번째 참여 칸'], ['job', '직업'], ['owned', '내가 작성한 칸']]) {
        const item = element('span', 'schedule-legend-item', label);
        const swatch = element('i', 'schedule-swatch schedule-swatch-' + kind);
        swatch.setAttribute('aria-hidden', 'true');
        item.prepend(swatch); legend.append(item);
      }
      context.append(current, legend);
      const footer = element('div', 'schedule-foot');
      footer.append(this.message, element('span', 'schedule-scroll-hint', '표 안에서 가로·세로로 이동할 수 있어요'));
      this.root.append(this.tabs, toolbar, context, this.viewport, footer);
      this.editor = element('dialog', 'schedule-editor');
      this.editor.setAttribute('aria-labelledby', 'schedule-editor-title');
      this.form = element('form');
      this.heading = element('h2', '', '일정 수정');
      this.heading.id = 'schedule-editor-title';
      this.description = element('p', 'schedule-editor-description');
      this.fields = element('div', 'schedule-fields');
      this.error = element('p', 'schedule-editor-error');
      this.error.setAttribute('role', 'alert');
      const actions = element('div', 'schedule-editor-actions');
      const cancel = element('button', 'quiet-button', '취소');
      cancel.type = 'button';
      cancel.addEventListener('click', () => { if (!this.busy) this.closeEditor(); });
      this.saveButton = element('button', 'home-button', '저장');
      this.saveButton.type = 'submit';
      actions.append(cancel, this.saveButton);
      this.form.append(this.heading, this.description, this.fields, this.error, actions);
      this.editor.append(this.form);
      this.root.append(this.editor);
      this.editor.addEventListener('cancel', event => { event.preventDefault(); if (!this.busy) this.closeEditor(); });
      this.form.addEventListener('submit', event => { event.preventDefault(); this.save(); });
      this.root.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey && !this.editor.open && !/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) && this.undo) {
          event.preventDefault(); this.revert();
        }
      });
    }

    get editing() { return this.busy || Boolean(this.pending); }

    suspend() { if (this.editor.open) this.editor.close(); }

    resume() { if (this.pending && !this.editor.open) this.editor.showModal(); }

    clear() {
      this.epoch++;
      this.busy = false;
      this.data = null;
      this.selected = '';
      this.undo = null;
      this.pending = null;
      this.closeEditor();
      this.viewport.replaceChildren();
      this.tabs.replaceChildren();
      this.search.value = '';
      this.message.textContent = '';
      this.currentTitle.textContent = '';
      this.undoButton.disabled = true;
      this.hiddenLabel.hidden = true;
      this.hiddenToggle.checked = false;
    }

    async load(isCurrent = () => true, selected = this.selected) {
      if (this.editing) return;
      const epoch = ++this.epoch;
      let data;
      try { data = await this.request('/api/auth/guild/sheet' + (selected ? '?sheet=' + encodeURIComponent(selected) : '')); }
      catch (error) {
        if (epoch !== this.epoch || !isCurrent() || (this.editing && ![401, 403].includes(error.status))) return;
        if (error.status !== 404 || !selected) throw error;
        data = await this.request('/api/auth/guild/sheet');
      }
      if (epoch !== this.epoch || !isCurrent() || this.editing) return;
      if (!Array.isArray(data.tabs) || typeof data.canManage !== 'boolean' || typeof data.title !== 'string') throw new Error('invalid sheet');
      this.data = data;
      this.selected = data.sheet?.id || '';
      this.currentTitle.textContent = data.sheet?.title || '길드 일정';
      this.hiddenLabel.hidden = !data.canManage;
      if (!data.canManage) this.hiddenToggle.checked = false;
      this.renderTabs();
      this.renderGrid();
      this.message.textContent = data.sheet ? '빈칸을 눌러 참여해 주세요. 저장한 일정은 길드원과 함께 볼 수 있어요.' : '아직 등록된 일정표가 없습니다.';
    }

    renderTabs() {
      this.tabs.replaceChildren();
      for (const tab of this.data?.tabs || []) {
        if (tab.hidden && !this.hiddenToggle.checked && tab.id !== this.selected) continue;
        const button = element('button', 'schedule-tab', tab.title + (tab.hidden ? ' · 숨김' : ''));
        button.type = 'button';
        button.id = 'schedule-tab-' + tab.id;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(tab.id === this.selected));
        button.setAttribute('aria-controls', 'schedule-grid');
        button.tabIndex = tab.id === this.selected ? 0 : -1;
        button.addEventListener('click', async () => {
          if (this.editing || tab.id === this.selected) return;
          try { await this.load(() => true, tab.id); this.viewport.scrollTo(0, 0); document.getElementById('schedule-tab-' + this.selected)?.focus(); }
          catch (error) { this.handleError(error); }
        });
        button.addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const buttons = [...this.tabs.children];
          const current = buttons.indexOf(button);
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[index].focus(); buttons[index].click();
        });
        this.tabs.append(button);
      }
    }

    values() {
      const values = Object.create(null);
      for (const [key, cell] of Object.entries(this.data.sheet.layout.cells)) values[key] = cell.v ?? '';
      for (const entry of Object.values(this.data.entries)) Object.assign(values, entry.values);
      return values;
    }

    formulaValue(formula, values) {
      const match = /^=?SUM\(([^)]+)\)$/i.exec(formula);
      if (!match) return '#수식 확인';
      let sum = 0;
      for (const part of match[1].split(',')) {
        const [from, to = from] = part.trim().split(':').map(value => position(value.trim().toUpperCase()));
        if (!from || !to) return '#수식 확인';
        for (let row = from[0]; row <= to[0]; row++) for (let col = from[1]; col <= to[1]; col++) {
          const value = values[address(row, col)];
          if (value !== '' && value !== undefined && value !== null && Number.isFinite(Number(value))) sum += Number(value);
        }
      }
      return String(Math.round((sum + Number.EPSILON) * 1e10) / 1e10);
    }

    renderGrid() {
      const oldScroll = {left: this.viewport.scrollLeft, top: this.viewport.scrollTop};
      const sheet = this.data?.sheet;
      this.viewport.replaceChildren();
      this.cellNodes = new Map();
      if (!sheet) { this.onChange(this.data); return; }
      const layout = sheet.layout;
      const styles = layout.styles.map(presentStyle);
      const values = this.values();
      const groups = new Map();
      for (const group of layout.groups) for (const cell of group.cells) groups.set(cell.address, group);
      const anchors = new Map(), covered = new Set();
      for (const [r1, c1, r2, c2] of layout.merges) {
        anchors.set(address(r1, c1), [r2 - r1 + 1, c2 - c1 + 1]);
        for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) covered.add(address(r, c));
      }
      const table = element('table', 'schedule-grid');
      table.id = 'schedule-grid';
      table.setAttribute('aria-label', sheet.title);
      const caption = element('caption', 'schedule-visually-hidden', sheet.title);
      table.append(caption);
      const colgroup = element('colgroup');
      for (let c = 1; c <= layout.columnCount; c++) {
        const column = element('col');
        column.style.width = layout.columnWidths[c - 1] + 'px';
        if (layout.hiddenColumns.includes(c)) column.style.visibility = 'collapse';
        colgroup.append(column);
      }
      table.style.width = layout.columnWidths.reduce((sum, width, index) => sum + (layout.hiddenColumns.includes(index + 1) ? 0 : width), 0) + 'px';
      table.append(colgroup);
      const body = element('tbody');
      for (let r = 1; r <= layout.rowCount; r++) {
        const row = element('tr');
        row.style.height = layout.rowHeights[r - 1] + 'px';
        if (layout.hiddenRows.includes(r)) row.hidden = true;
        for (let c = 1; c <= layout.columnCount; c++) {
          const key = address(r, c);
          if (covered.has(key)) continue;
          const cell = layout.cells[key] || {};
          const td = element('td');
          td.dataset.address = key;
          const merged = anchors.get(key);
          if (merged) { td.rowSpan = merged[0]; td.colSpan = merged[1]; }
          let style = styles[cell.s ?? 0] || {};
          const nonblank = String(values[key] ?? '').trim() !== '';
          for (const rule of cell.rules || []) if ((rule.when === 'nonblank') === nonblank) { style = styles[rule.s] || style; break; }
          for (const [property, value] of Object.entries(style)) td.style[property] = property === 'fontSize' ? value + 'px' : value;
          let value = cell.formula ? this.formulaValue(cell.formula, values) : String(values[key] ?? '');
          if (sheet.title === '안내말' && value === '하단 탭 원하는 레이드 선택') value = '탭에서 원하는 레이드 선택';
          const group = groups.get(key), entry = group && this.data.entries[group.id];
          const editable = Boolean(group && entry?.editable && !cell.formula);
          if (!cell.rules?.length && group?.kind === 'entry' && group.cells.some(field => field.address === key && field.options)) td.style.backgroundColor = 'var(--guild-cell-job)';
          const content = element(editable ? 'button' : 'span', 'schedule-cell' + (editable ? ' schedule-cell-editable' : ''), value);
          if (group) td.dataset.kind = group.kind;
          if (entry?.owned) td.dataset.owned = 'true';
          if (cell.runs?.map(run => run.t).join('') === value) {
            content.replaceChildren();
            for (const run of cell.runs) {
              const span = element('span', '', run.t);
              for (const [property, setting] of Object.entries(styles[run.s] || {})) span.style[property] = property === 'fontSize' ? setting + 'px' : setting;
              content.append(span);
            }
          }
          if (editable) {
            content.type = 'button';
            const field = group.cells.find(item => item.address === key);
            if (!value && group.kind !== 'admin') content.dataset.placeholder = field.options ? (group.kind === 'entry' ? '직업 선택' : field.label + ' 선택') : field.label;
            content.setAttribute('aria-label', `${key} ${field.label}${value ? ': ' + value : ' 빈칸'} 수정`);
            content.title = entry.owned ? '내 항목 수정' : value ? '항목 수정' : group.kind === 'entry' ? '캐릭터와 직업 입력' : '일정 입력';
            content.addEventListener('click', () => this.openEditor(group));
          }
          td.append(content); row.append(td);
          this.cellNodes.set(key, td);
        }
        body.append(row);
      }
      table.append(body); this.viewport.append(table);
      this.viewport.scrollTo(oldScroll.left, oldScroll.top);
      this.undoButton.disabled = !this.undo || this.busy || this.undo.sheetId !== this.selected;
      this.onChange(this.data);
    }

    openEditor(group) {
      if (this.busy || !this.data.entries[group.id]?.editable) return;
      const entry = this.data.entries[group.id];
      this.pending = {sheetId: this.selected, group, revision: entry.revision, previous: {...entry.values}};
      this.heading.textContent = group.kind === 'entry' ? '참여 캐릭터' : group.kind === 'header' ? '모집 일정' : '시트 내용 수정';
      this.description.textContent = `${this.data.sheet.title}에서 ${group.kind === 'entry' ? '함께할 캐릭터를 입력해 주세요.' : '변경할 내용을 입력해 주세요.'}`;
      this.fields.replaceChildren(); this.error.textContent = '';
      this.saveButton.disabled = false;
      for (const cell of group.cells) {
        const label = element('label', 'schedule-field', cell.label);
        const input = element(cell.options ? 'select' : 'input');
        input.name = cell.address;
        input.id = 'schedule-field-' + cell.address;
        label.htmlFor = input.id;
        input.setAttribute('aria-label', cell.label);
        if (cell.options) {
          input.append(new Option('선택 안 함', ''));
          for (const option of cell.options) if (option !== '') input.append(new Option(option, option));
          const current = entry.values[cell.address] || '';
          if (current && !cell.options.includes(current)) input.append(new Option(current, current));
        } else { input.type = 'text'; input.maxLength = 100; input.autocomplete = 'off'; }
        input.value = entry.values[cell.address] ?? '';
        label.append(input); this.fields.append(label);
      }
      this.editor.showModal();
      this.fields.querySelector('input,select')?.focus();
    }

    closeEditor() {
      const reload = this.pending?.conflict;
      if (this.editor.open) this.editor.close();
      this.pending = null; this.fields.replaceChildren(); this.error.textContent = '';
      if (reload && this.data) this.load().catch(error => this.handleError(error));
    }

    async edit(payload) {
      const token = this.csrf();
      if (!token) { const error = new Error('login required'); error.status = 401; throw error; }
      return this.request('/api/auth/guild/sheet/edit', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token}, body: JSON.stringify(payload)});
    }

    async save() {
      if (this.busy || !this.pending || this.pending.conflict) return;
      const pending = this.pending, epoch = this.epoch;
      const values = Object.fromEntries([...this.fields.querySelectorAll('input,select')].map(input => [input.name, input.value]));
      this.busy = true; this.saveButton.disabled = true; this.error.textContent = '';
      try {
        const result = await this.edit({sheetId: pending.sheetId, groupId: pending.group.id, revision: pending.revision, values});
        if (epoch !== this.epoch || !this.data) return;
        this.data.entries[pending.group.id] = result.entry;
        this.undo = {sheetId: pending.sheetId, groupId: pending.group.id, revision: result.entry.revision, values: pending.previous};
        this.closeEditor(); this.renderGrid();
        this.message.textContent = '저장했습니다. 다른 길드원도 새로 확인하면 같은 내용을 볼 수 있습니다.';
      } catch (error) {
        if (epoch !== this.epoch) return;
        if ([401, 403].includes(error.status)) this.accessError(error);
        else {
          if (error.status === 409) pending.conflict = true;
          this.error.textContent = error.status === 409 ? '다른 사람이 먼저 수정했습니다. 입력한 내용은 남겨 두었습니다. 취소하면 최신 내용을 불러옵니다.' : error.status === 429 ? '잠시 후 다시 저장해 주세요. 입력한 내용은 그대로 유지됩니다.' : error.status === 400 ? '입력 내용을 확인해 주세요. 각 칸은 100자 이내로 입력할 수 있습니다.' : '저장 결과를 확인하지 못했습니다. 다시 저장하면 중복 수정은 방지됩니다.';
        }
      } finally {
        if (epoch === this.epoch) { this.busy = false; this.saveButton.disabled = Boolean(this.pending?.conflict); this.undoButton.disabled = !this.undo || this.undo.sheetId !== this.selected; }
      }
    }

    async revert() {
      if (this.editing || !this.undo || this.undo.sheetId !== this.selected) return;
      const undo = this.undo, epoch = this.epoch;
      this.busy = true; this.undoButton.disabled = true;
      try {
        const result = await this.edit(undo);
        if (epoch !== this.epoch || !this.data) return;
        if (this.selected === undo.sheetId) this.data.entries[undo.groupId] = result.entry;
        this.undo = null; this.renderGrid(); this.message.textContent = '내 마지막 수정을 되돌렸습니다.';
      } catch (error) {
        if (epoch !== this.epoch) return;
        this.handleError(error, error.status === 409 ? '다른 수정이 있어 되돌리지 않았습니다. 최신 내용을 확인해 주세요.' : '되돌리기 결과를 확인하지 못했습니다. 최신 내용을 확인해 주세요.');
        if (error.status === 409) this.undo = null;
      } finally { if (epoch === this.epoch) { this.busy = false; this.undoButton.disabled = !this.undo || this.undo.sheetId !== this.selected; } }
    }

    find() {
      const query = this.search.value.trim().toLocaleLowerCase();
      if (!query || !this.data?.sheet) return;
      const matches = [...this.cellNodes.values()].filter(node => node.offsetParent !== null && node.textContent.toLocaleLowerCase().includes(query));
      this.viewport.querySelector('.schedule-found')?.classList.remove('schedule-found');
      if (!matches.length) { this.message.textContent = '현재 시트에 일치하는 내용이 없습니다.'; return; }
      this.findIndex = this.lastQuery === query ? ((this.findIndex || 0) + 1) % matches.length : 0;
      this.lastQuery = query;
      const cell = matches[this.findIndex];
      cell.classList.add('schedule-found');
      cell.scrollIntoView({block: 'center', inline: 'center', behavior: 'smooth'});
      this.message.textContent = `${matches.length}개 중 ${this.findIndex + 1}번째 · ${cell.dataset.address}`;
    }

    handleError(error, message = '일정을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.') {
      if ([401, 403].includes(error.status)) this.accessError(error);
      else this.message.textContent = message;
    }
  }
  window.PogeunGuildSheet = GuildSheet;
})();
