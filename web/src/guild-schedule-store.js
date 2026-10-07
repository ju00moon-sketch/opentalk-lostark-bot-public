import { GuildError } from './guild-store.js';

export const GUILD_SCHEDULE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS guild_schedule_metadata (
    id INTEGER PRIMARY KEY CHECK (id=1),
    title TEXT NOT NULL,
    imported_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS guild_schedule_sheets (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    position INTEGER NOT NULL UNIQUE,
    hidden INTEGER NOT NULL CHECK (hidden IN (0, 1)),
    layout_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS guild_schedule_entries (
    sheet_id TEXT NOT NULL REFERENCES guild_schedule_sheets(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL,
    values_json TEXT NOT NULL,
    owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    PRIMARY KEY (sheet_id, group_id)
  ) STRICT;
`;

const invalid = () => { throw new GuildError(400, 'invalid_request'); };
const forbidden = () => { throw new GuildError(403, 'forbidden'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const string = (value, max, empty = false) => typeof value === 'string' && value.length <= max &&
  (empty || value.trim().length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const identifier = (value, max) => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
export const validSheetId = value => identifier(value, 64);

function keys(value, required, optional = []) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}

function coordinate(address, rows, columns) {
  if (typeof address !== 'string') invalid();
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,3})$/.exec(address);
  if (!match) invalid();
  const column = [...match[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const row = Number(match[2]);
  if (row > rows || column > columns) invalid();
  return [row, column];
}

function validStyle(style) {
  const colors = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  const border = value => typeof value === 'string' && /^(?:none|(?:[0-4](?:\.\d)?px) (?:solid|dashed|dotted|double) #[0-9a-f]{6})$/i.test(value);
  const allowed = {
    backgroundColor: colors, color: colors,
    fontSize: value => typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 96,
    fontFamily: value => ['Arial', 'Calibri', 'Noto Sans KR', '맑은 고딕', 'sans-serif', 'Roboto', 'Google Sans', '"Google Sans", Roboto, sans-serif', '돋움'].includes(value),
    fontWeight: value => ['normal', 'bold', 400, 700].includes(value),
    fontStyle: value => ['normal', 'italic'].includes(value),
    textDecoration: value => ['none', 'underline', 'line-through', 'underline line-through'].includes(value),
    textAlign: value => ['left', 'center', 'right', 'justify'].includes(value),
    verticalAlign: value => ['top', 'middle', 'bottom'].includes(value),
    whiteSpace: value => ['normal', 'pre', 'pre-wrap', 'nowrap', 'pre-line'].includes(value),
    borderTop: border, borderRight: border, borderBottom: border, borderLeft: border,
  };
  if (!object(style) || Object.entries(style).some(([key, value]) => !Object.hasOwn(allowed, key) || !allowed[key](value))) invalid();
}

function validFormula(formula, rows, columns) {
  if (typeof formula !== 'string' || formula.length > 500) invalid();
  const match = /^=?SUM\(([^()]+)\)$/i.exec(formula.trim());
  if (!match) invalid();
  for (const range of match[1].split(',')) {
    const references = range.trim().split(':');
    if (references.length > 2) invalid();
    const coordinates = references.map(value => coordinate(value.trim().toUpperCase(), rows, columns));
    if (coordinates.length === 2 && (coordinates[0][0] > coordinates[1][0] || coordinates[0][1] > coordinates[1][1])) invalid();
  }
}

// Import only an explicit, bounded document format. No CSS, formula, or URL is executed.
export function validateScheduleSeed(seed) {
  keys(seed, ['schema', 'title', 'sheets']);
  if (seed.schema !== 1 || !string(seed.title, 200) || !Array.isArray(seed.sheets) ||
    seed.sheets.length < 1 || seed.sheets.length > 30 || !seed.sheets.some(sheet => sheet?.hidden === false)) invalid();
  const sheetIds = new Set();
  let totalCells = 0;
  let totalGroups = 0;
  for (const sheet of seed.sheets) {
    keys(sheet, ['id', 'title', 'hidden', 'layout']);
    if (!validSheetId(sheet.id) || sheetIds.has(sheet.id) || !string(sheet.title, 100) || typeof sheet.hidden !== 'boolean') invalid();
    sheetIds.add(sheet.id);
    const layout = sheet.layout;
    keys(layout, ['rowCount', 'columnCount', 'columnWidths', 'rowHeights', 'styles', 'cells', 'merges', 'hiddenRows', 'hiddenColumns', 'groups'],
      ['originalRowCount', 'originalColumnCount']);
    const { rowCount: rows, columnCount: columns, styles } = layout;
    if (!integer(rows, 1, 2000) || !integer(columns, 1, 100) ||
      (Object.hasOwn(layout, 'originalRowCount') && !integer(layout.originalRowCount, rows, 100000)) ||
      (Object.hasOwn(layout, 'originalColumnCount') && !integer(layout.originalColumnCount, columns, 10000))) invalid();
    for (const [sizes, count] of [[layout.columnWidths, columns], [layout.rowHeights, rows]]) {
      if (!Array.isArray(sizes) || sizes.length !== count || sizes.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2000)) invalid();
    }
    if (!Array.isArray(styles) || styles.length < 1 || styles.length > 1000) invalid();
    styles.forEach(validStyle);
    if (!object(layout.cells) || (totalCells += Object.keys(layout.cells).length) > 300000) invalid();
    for (const [address, cell] of Object.entries(layout.cells)) {
      coordinate(address, rows, columns);
      keys(cell, ['s', 'v'], ['formula', 'rules', 'runs']);
      if (!integer(cell.s, 0, styles.length - 1) || !(string(cell.v, 5000, true) || typeof cell.v === 'boolean' ||
        (typeof cell.v === 'number' && Number.isFinite(cell.v) && Math.abs(cell.v) <= 1e15))) invalid();
      if (Object.hasOwn(cell, 'formula')) validFormula(cell.formula, rows, columns);
      if (Object.hasOwn(cell, 'runs')) {
        if (!Array.isArray(cell.runs) || cell.runs.length > 100 || typeof cell.v !== 'string') invalid();
        for (const run of cell.runs) {
          keys(run, ['t', 's']);
          if (!string(run.t, 5000, true) || !integer(run.s, 0, styles.length - 1)) invalid();
        }
        if (cell.runs.map(run => run.t).join('') !== cell.v) invalid();
      }
      if (Object.hasOwn(cell, 'rules')) {
        if (!Array.isArray(cell.rules) || cell.rules.length > 2) invalid();
        const conditions = new Set();
        for (const rule of cell.rules) {
          keys(rule, ['when', 's']);
          if (!['blank', 'nonblank'].includes(rule.when) || conditions.has(rule.when) || !integer(rule.s, 0, styles.length - 1)) invalid();
          conditions.add(rule.when);
        }
      }
    }
    for (const [hidden, max] of [[layout.hiddenRows, rows], [layout.hiddenColumns, columns]]) {
      if (!Array.isArray(hidden) || hidden.some(value => !integer(value, 1, max)) || new Set(hidden).size !== hidden.length) invalid();
    }
    if (!Array.isArray(layout.merges) || layout.merges.length > 10000) invalid();
    const merged = new Set();
    const covered = new Set();
    for (const range of layout.merges) {
      if (!Array.isArray(range) || range.length !== 4 || !integer(range[0], 1, rows) || !integer(range[1], 1, columns) ||
        !integer(range[2], range[0], rows) || !integer(range[3], range[1], columns)) invalid();
      for (let row = range[0]; row <= range[2]; row++) for (let column = range[1]; column <= range[3]; column++) {
        const key = row * 101 + column;
        if (merged.has(key)) invalid();
        merged.add(key);
        if (row !== range[0] || column !== range[1]) covered.add(key);
      }
    }
    if (!Array.isArray(layout.groups) || (totalGroups += layout.groups.length) > 50000) invalid();
    const groupIds = new Set();
    const addresses = new Set();
    for (const group of layout.groups) {
      keys(group, ['id', 'kind', 'cells']);
      if (!identifier(group.id, 80) || groupIds.has(group.id) || !['entry', 'header', 'admin'].includes(group.kind) ||
        !Array.isArray(group.cells) || group.cells.length < 1 || group.cells.length > 2) invalid();
      groupIds.add(group.id);
      for (const cell of group.cells) {
        keys(cell, ['address', 'label'], ['options']);
        const [row, column] = coordinate(cell.address, rows, columns);
        const original = layout.cells[cell.address];
        if (addresses.has(cell.address) || covered.has(row * 101 + column) || layout.hiddenRows.includes(row) || layout.hiddenColumns.includes(column) ||
          !original || Object.hasOwn(original, 'formula') || !string(cell.label, 100) || String(original.v).length > 100) invalid();
        addresses.add(cell.address);
        if (Object.hasOwn(cell, 'options') && (!Array.isArray(cell.options) || cell.options.length > 100 ||
          cell.options.some(option => !string(option, 100)) || new Set(cell.options).size !== cell.options.length)) invalid();
      }
    }
  }
  return seed;
}

export function createGuildScheduleStore(db, transaction) {
  function requireMember(userId) {
    const user = db.prepare(`SELECT COALESCE(r.role, 'member') AS role FROM users u
      JOIN guild_memberships m ON m.user_id=u.id LEFT JOIN guild_roles r ON r.user_id=u.id
      WHERE u.id=? AND m.status='approved' AND NOT EXISTS (SELECT 1 FROM deletion_intents WHERE user_id=u.id)`).get(userId);
    if (!user) forbidden();
    return ['admin', 'owner'].includes(user.role);
  }
  function entryResult(row, group, userId, canManage) {
    const values = JSON.parse(row.values_json);
    const empty = Object.values(values).every(value => value.trim() === '');
    const owned = row.owner_user_id === userId;
    return { values, revision: row.revision, editable: canManage || (group.kind !== 'admin' && (owned || empty)), owned };
  }
  return {
    import(seed, timestamp = Date.now()) {
      validateScheduleSeed(seed);
      return transaction(() => {
        if (['guild_schedule_metadata', 'guild_schedule_sheets', 'guild_schedule_entries'].some(table => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) {
          throw new GuildError(409, 'schedule_already_imported');
        }
        let groups = 0;
        db.prepare('INSERT INTO guild_schedule_metadata VALUES (1, ?, ?)').run(seed.title, timestamp);
        for (const [position, sheet] of seed.sheets.entries()) {
          const layout = structuredClone(sheet.layout);
          const entries = layout.groups.map(group => {
            const values = Object.fromEntries(group.cells.map(cell => [cell.address, String(layout.cells[cell.address].v)]));
            for (const cell of group.cells) layout.cells[cell.address].v = '';
            return [group.id, JSON.stringify(values)];
          });
          db.prepare('INSERT INTO guild_schedule_sheets VALUES (?, ?, ?, ?, ?)').run(sheet.id, sheet.title, position, Number(sheet.hidden), JSON.stringify(layout));
          for (const [groupId, values] of entries) {
            db.prepare('INSERT INTO guild_schedule_entries VALUES (?, ?, ?, NULL, 1)').run(sheet.id, groupId, values);
            groups++;
          }
        }
        return { imported: true, sheets: seed.sheets.length, groups };
      });
    },
    read(userId, sheetId = '') {
      if (sheetId !== '' && !validSheetId(sheetId)) invalid();
      return transaction(() => {
        const canManage = requireMember(userId);
        const tabs = db.prepare('SELECT id, title, hidden FROM guild_schedule_sheets WHERE hidden=0 OR ?=1 ORDER BY position').all(Number(canManage))
          .map(tab => ({ ...tab, hidden: Boolean(tab.hidden) }));
        const title = db.prepare('SELECT title FROM guild_schedule_metadata WHERE id=1').get()?.title || '길드 일정 조율';
        const selectedId = sheetId || tabs.find(tab => !tab.hidden)?.id;
        if (!selectedId) return { title, tabs, sheet: null, entries: {}, canManage };
        const sheet = db.prepare('SELECT id, title, hidden, layout_json FROM guild_schedule_sheets WHERE id=?').get(selectedId);
        if (!sheet || (sheet.hidden && !canManage)) throw new GuildError(404, 'sheet_not_found');
        const layout = JSON.parse(sheet.layout_json);
        const groups = new Map(layout.groups.map(group => [group.id, group]));
        const entries = Object.fromEntries(db.prepare('SELECT * FROM guild_schedule_entries WHERE sheet_id=?').all(sheet.id)
          .map(row => [row.group_id, entryResult(row, groups.get(row.group_id), userId, canManage)]));
        for (const group of layout.groups) for (const cell of group.cells) {
          const definition = layout.cells[cell.address];
          if (definition.runs && definition.runs.map(run => run.t).join('') !== entries[group.id].values[cell.address]) delete definition.runs;
        }
        return { title, tabs, sheet: { id: sheet.id, title: sheet.title, layout }, entries, canManage };
      });
    },
    edit(userId, { sheetId, groupId, revision, values }) {
      if (!validSheetId(sheetId) || !identifier(groupId, 80) || !integer(revision, 1, Number.MAX_SAFE_INTEGER - 1) || !object(values)) invalid();
      return transaction(() => {
        const canManage = requireMember(userId);
        const sheet = db.prepare('SELECT hidden, layout_json FROM guild_schedule_sheets WHERE id=?').get(sheetId);
        if (!sheet || (sheet.hidden && !canManage)) throw new GuildError(404, 'sheet_not_found');
        const group = JSON.parse(sheet.layout_json).groups.find(candidate => candidate.id === groupId);
        if (!group) throw new GuildError(404, 'entry_not_found');
        keys(values, group.cells.map(cell => cell.address));
        for (const cell of group.cells) {
          const value = values[cell.address];
          if (!string(value, 100, true) || (value.trim() && cell.options && !cell.options.includes(value))) invalid();
        }
        const row = db.prepare('SELECT * FROM guild_schedule_entries WHERE sheet_id=? AND group_id=?').get(sheetId, groupId);
        if (row.revision !== revision) throw new GuildError(409, 'state_changed');
        if (!entryResult(row, group, userId, canManage).editable) forbidden();
        const nextValues = Object.fromEntries(group.cells.map(cell => [cell.address, values[cell.address].trim() ? values[cell.address] : '']));
        const empty = Object.values(nextValues).every(value => value === '');
        const owner = empty ? null : row.owner_user_id || (canManage ? null : userId);
        db.prepare('UPDATE guild_schedule_entries SET values_json=?, owner_user_id=?, revision=revision+1 WHERE sheet_id=? AND group_id=?')
          .run(JSON.stringify(nextValues), owner, sheetId, groupId);
        const updated = { values_json: JSON.stringify(nextValues), owner_user_id: owner, revision: revision + 1 };
        return { ok: true, entry: entryResult(updated, group, userId, canManage) };
      });
    },
  };
}
