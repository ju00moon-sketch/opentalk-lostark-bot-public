import { verifyOwnership } from './helpers/access.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.js';
import { createWebServer } from '../src/server.js';
import { validateScheduleSeed } from '../src/guild-schedule-store.js';
import { importSchedule, preserveSchedule } from '../src/schedule-import.js';

const origin = 'https://opentalk.example.invalid';
const digest = value => createHash('sha256').update(value).digest('hex');
const timestamp = Date.now();

function seed() {
  const layout = {
    rowCount: 6, columnCount: 4, columnWidths: [120, 100, 80, 90], rowHeights: [30, 25, 25, 25, 25, 25],
    styles: [{ backgroundColor: '#ffffff', color: '#000000', fontFamily: '돋움', fontSize: 11, whiteSpace: 'pre' }, { backgroundColor: '#ff0000' }],
    cells: {
      A1: { s: 0, v: '원본 안내' }, C1: { s: 0, v: '' }, D1: { s: 0, v: 1500, formula: '=sum(B3:B3)' },
      A2: { s: 0, v: '', rules: [{ when: 'blank', s: 0 }, { when: 'nonblank', s: 1 }] }, B2: { s: 0, v: '' },
      A3: { s: 0, v: '기존이름', runs: [{ t: '기존', s: 0 }, { t: '이름', s: 1 }] }, B3: { s: 0, v: 1500 }, A4: { s: 0, v: '' }, B4: { s: 0, v: '' },
      A5: { s: 0, v: '병합 안내' },
    },
    merges: [[5, 1, 5, 2]], hiddenRows: [6], hiddenColumns: [],
    groups: [
      { id: 'entry', kind: 'entry', cells: [{ address: 'A2', label: '이름' }, { address: 'B2', label: '직업', options: ['바드', '홀리나이트'] }] },
      { id: 'imported', kind: 'entry', cells: [{ address: 'A3', label: '이름' }, { address: 'B3', label: '레벨' }] },
      { id: 'header', kind: 'header', cells: [{ address: 'A4', label: '시간' }, { address: 'B4', label: '파티' }] },
      { id: 'admin', kind: 'admin', cells: [{ address: 'C1', label: '관리 안내' }] },
    ],
  };
  const hidden = structuredClone(layout);
  hidden.cells.A1.v = '숨긴 원본 안내';
  return { schema: 1, title: '길드 원본 일정', sheets: [
    { id: 'hidden-first', title: '숨긴 기록', hidden: true, layout: hidden },
    { id: 'weekly', title: '주간 일정', hidden: false, layout },
    { id: 'roster', title: '원정대', hidden: false, layout: structuredClone(layout) },
  ] };
}

async function setup(t, imported = true) {
  const directory = await mkdtemp(join(tmpdir(), 'schedule-test-'));
  const path = join(directory, 'auth.sqlite');
  const store = createStore(path);
  let service;
  t.after(async () => {
    if (service) await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const accounts = {};
  for (const [index, name] of ['owner', 'admin', 'alice', 'bob', 'pending', 'outsider'].entries()) {
    const token = randomBytes(32).toString('base64url');
    store.createSession({ provider: 'discord', providerId: String(10000 + index), displayName: name,
      tokenHash: digest(token), expiresAt: timestamp + 86400000, epoch: 0 }, timestamp);
    accounts[name] = { ...store.getSession(digest(token), timestamp), token };
  }
  store.guild.bootstrapOwner(accounts.owner.id, timestamp);
  for (const name of ['admin', 'alice', 'bob', 'pending']) {
    verifyOwnership(store, accounts[name], name, timestamp);
    store.guild.apply(accounts[name].id, name, timestamp);
    if (name !== 'pending') store.guild.review(accounts.owner.id, accounts[name].id, 'approved', 1, timestamp);
  }
  store.guild.setRole(accounts.owner.id, accounts.admin.id, 'admin', 2, timestamp);
  if (imported) store.schedule.import(seed(), timestamp);
  async function listen() {
    service = createWebServer({ config: { origin, host: '127.0.0.1', port: 0, dbPath: path }, now: () => timestamp });
    service.server.listen(0, '127.0.0.1');
    await once(service.server, 'listening');
  }
  async function request(route, user, body, options = {}) {
    const headers = user ? { Cookie: `__Host-web_session=${user.token}`, Origin: origin,
      'X-CSRF-Token': createHash('sha256').update(`web-csrf:${user.token}`).digest('base64url') } : {};
    const response = await fetch(`http://127.0.0.1:${service.server.address().port}/api/auth/guild/sheet${route}`, {
      method: body === undefined ? 'GET' : 'POST', ...options,
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  return { path, directory, store, accounts, listen, request };
}

const edit = (values = { A2: '새바드', B2: '바드' }, revision = 1, groupId = 'entry', sheetId = 'weekly') => ({ sheetId, groupId, revision, values });
const fails = (action, status, code) => assert.throws(action, error => error.status === status && (!code || error.code === code));

test('native book preserves layout and source values while disclosing only permitted tabs', async t => {
  const h = await setup(t); const { alice, admin, pending, outsider } = h.accounts;
  fails(() => h.store.schedule.read(pending.id), 403);
  fails(() => h.store.schedule.read(outsider.id), 403);
  const book = h.store.schedule.read(alice.id);
  assert.equal(book.title, seed().title);
  assert.deepEqual(book.tabs.map(tab => tab.id), ['weekly', 'roster']);
  assert.equal(book.sheet.id, 'weekly');
  assert.equal(book.canManage, false);
  assert.equal(book.sheet.layout.cells.A1.v, '원본 안내');
  assert.equal(book.sheet.layout.cells.A3.v, '');
  assert.equal(book.sheet.layout.cells.D1.formula, '=sum(B3:B3)');
  assert.deepEqual(book.sheet.layout.cells.A2.rules, seed().sheets[1].layout.cells.A2.rules);
  assert.deepEqual(book.entries.imported.values, { A3: '기존이름', B3: '1500' });
  assert.deepEqual(book.sheet.layout.cells.A3.runs, seed().sheets[1].layout.cells.A3.runs);
  assert.equal(book.entries.imported.editable, false);
  assert.equal(book.entries.entry.editable, true);
  assert.equal(book.entries.admin.editable, false);
  assert.equal(JSON.stringify(book).includes('숨긴'), false);
  assert.equal(JSON.stringify(book).includes(alice.id), false);
  fails(() => h.store.schedule.read(alice.id, 'hidden-first'), 404);
  assert.equal(h.store.schedule.read(admin.id).tabs.length, 3);
  assert.equal(h.store.schedule.read(admin.id).sheet.id, 'weekly');
  assert.equal(h.store.schedule.read(admin.id, 'hidden-first').sheet.layout.cells.A1.v, '숨긴 원본 안내');
  h.store.schedule.edit(admin.id, edit({ A3: '새이름', B3: '1700' }, 1, 'imported'));
  assert.equal(h.store.schedule.read(alice.id).sheet.layout.cells.A3.runs, undefined);
});

test('members claim empty entry and header groups, release ownership, and cannot modify another group', async t => {
  const h = await setup(t); const { alice, bob, admin } = h.accounts;
  let result = h.store.schedule.edit(alice.id, edit());
  assert.equal(result.entry.revision, 2);
  assert.equal(result.entry.owned, true);
  assert.equal(h.store.schedule.read(bob.id).entries.entry.editable, false);
  fails(() => h.store.schedule.edit(bob.id, edit(undefined, 2)), 403);
  fails(() => h.store.schedule.edit(alice.id, edit({ A3: '침범', B3: '1700' }, 1, 'imported')), 403);
  fails(() => h.store.schedule.edit(alice.id, edit({ C1: '침범' }, 1, 'admin')), 403);
  result = h.store.schedule.edit(alice.id, edit({ A4: '월요일', B4: '1파티' }, 1, 'header'));
  assert.equal(result.entry.owned, true);
  result = h.store.schedule.edit(admin.id, edit({ A2: '관리자수정', B2: '홀리나이트' }, 2));
  assert.equal(result.entry.owned, false);
  assert.equal(h.store.schedule.read(alice.id).entries.entry.owned, true);
  result = h.store.schedule.edit(alice.id, edit({ A2: '  ', B2: '' }, 3));
  assert.deepEqual(result.entry.values, { A2: '', B2: '' });
  assert.equal(result.entry.revision, 4);
  assert.equal(result.entry.owned, false);
  assert.equal(h.store.schedule.read(bob.id).entries.entry.editable, true);
  result = h.store.schedule.edit(bob.id, edit({ A2: '다음회원', B2: '바드' }, 4));
  assert.equal(result.entry.revision, 5);
  assert.equal(result.entry.owned, true);
  assert.equal(h.store.schedule.read(alice.id).entries.entry.owned, false);
});

test('two connections cannot overwrite a claimed group with the same revision', async t => {
  const h = await setup(t); const second = createStore(h.path);
  try {
    h.store.schedule.edit(h.accounts.alice.id, edit());
    fails(() => second.schedule.edit(h.accounts.bob.id, edit({ A2: '동시회원', B2: '바드' })), 409, 'state_changed');
    assert.equal(second.schedule.read(h.accounts.bob.id).entries.entry.values.A2, '새바드');
    second.schedule.edit(h.accounts.alice.id, edit({ A2: '수정회원', B2: '바드' }, 2));
    fails(() => h.store.schedule.edit(h.accounts.alice.id, edit(undefined, 2)), 409);
  } finally { second.close(); }
});

test('staff permissions and membership are rechecked on each write and deletion retains safe ownership', async t => {
  const h = await setup(t); const { owner, admin, alice, bob } = h.accounts;
  h.store.schedule.edit(alice.id, edit());
  h.store.guild.review(owner.id, alice.id, 'revoked', 2, timestamp);
  fails(() => h.store.schedule.edit(alice.id, edit(undefined, 2)), 403);
  fails(() => h.store.schedule.read(alice.id), 403);
  h.store.guild.setRole(owner.id, admin.id, 'member', 3, timestamp);
  fails(() => h.store.schedule.edit(admin.id, edit({ C1: '변경' }, 1, 'admin')), 403);
  h.store.deleteLocalAccount(alice.id);
  const row = h.store.schedule.read(bob.id).entries.entry;
  assert.equal(row.values.A2, '새바드');
  assert.equal(row.owned, false);
  assert.equal(row.editable, false);
  assert.equal(h.store.schedule.edit(owner.id, edit({ A2: '', B2: '' }, 2)).entry.revision, 3);
  assert.equal(h.store.schedule.read(bob.id).entries.entry.editable, true);
});

test('write validation rejects unknown cells, formulas, invalid choices and oversized values without changing data', async t => {
  const h = await setup(t); const user = h.accounts.alice;
  for (const input of [edit({ A2: '이름' }), edit({ A2: '이름', B2: '잘못된직업' }), edit({ A2: 'x'.repeat(101), B2: '바드' }),
    edit({ A2: '이름', B2: 3 }), edit({ A2: '이름', B2: '바드', D1: '=SUM(B3:B3)' }), edit({ D1: '33' }),
    edit(undefined, 0), edit(undefined, 1.5), edit(undefined, Number.MAX_SAFE_INTEGER), edit(undefined, 1, '__proto__')]) {
    fails(() => h.store.schedule.edit(user.id, input), 400);
  }
  fails(() => h.store.schedule.edit(user.id, edit(undefined, 1, 'missing')), 404);
  fails(() => h.store.schedule.edit(user.id, edit(undefined, 1, 'entry', 'missing')), 404);
  assert.equal(h.store.schedule.read(user.id).entries.entry.revision, 1);
  assert.deepEqual(h.store.schedule.read(user.id).entries.entry.values, { A2: '', B2: '' });
});

test('HTTP endpoints retain session, CSRF, body limits, methods, and exact query/JSON validation', async t => {
  const h = await setup(t); const { alice, pending } = h.accounts; await h.listen();
  assert.equal((await h.request('')).status, 401);
  assert.equal((await h.request('', pending)).status, 403);
  const book = await h.request('', alice);
  assert.equal(book.status, 200);
  assert.equal(book.headers.get('cache-control'), 'no-store');
  assert.equal((await h.request('?sheet=roster', alice)).body.sheet.id, 'roster');
  assert.equal((await h.request('?sheet=hidden-first', alice)).status, 404);
  for (const query of ['?sheet=', '?sheet=weekly&sheet=roster', '?x=weekly', '?sheet=../weekly']) {
    assert.equal((await h.request(query, alice)).status, 400);
  }
  for (const headers of [{ Origin: 'https://foreign.example' }, { 'X-CSRF-Token': 'wrong' }]) {
    assert.equal((await h.request('/edit', alice, edit(), { headers })).status, 403);
  }
  assert.equal((await h.request('/edit', alice)).status, 405);
  assert.equal((await h.request('', alice, edit())).status, 400);
  assert.equal((await h.request('/edit', alice, edit(), { method: 'PUT' })).status, 405);
  assert.equal((await h.request('/edit?sheet=weekly', alice, edit())).status, 400);
  assert.equal((await h.request('/edit', alice, { ...edit(), owner: alice.id })).status, 400);
  assert.equal((await h.request('/edit', alice, edit(), { headers: { 'Content-Type': 'text/plain' } })).status, 400);
  assert.equal((await h.request('/edit', alice, edit({ A2: 'x'.repeat(2000), B2: '바드' }))).status, 413);
  const written = await h.request('/edit', alice, edit());
  assert.equal(written.status, 200);
  assert.equal(written.body.entry.revision, 2);
  assert.equal((await h.request('/edit', alice, edit())).status, 409);
});

test('import validates all sheets before writing and cannot overwrite an existing book', async t => {
  const h = await setup(t, false);
  const bad = seed(); bad.sheets[2].layout.cells.D1.formula = '=IMPORTXML("https://example.com")';
  fails(() => h.store.schedule.import(bad), 400);
  assert.equal(h.store.schedule.read(h.accounts.alice.id).sheet, null);
  const original = seed();
  assert.deepEqual(h.store.schedule.import(original, timestamp), { imported: true, sheets: 3, groups: 12 });
  assert.equal(original.sheets[1].layout.cells.A3.v, '기존이름');
  h.store.schedule.edit(h.accounts.alice.id, edit());
  fails(() => h.store.schedule.import(seed()), 409, 'schedule_already_imported');
  assert.equal(h.store.schedule.read(h.accounts.alice.id).entries.entry.revision, 2);
});

test('an interrupted seed insertion rolls back the entire book', async t => {
  const h = await setup(t, false);
  const db = new DatabaseSync(h.path);
  try {
    db.exec("CREATE TRIGGER fail_schedule_import BEFORE INSERT ON guild_schedule_sheets WHEN NEW.id='roster' BEGIN SELECT RAISE(ABORT, 'import interrupted'); END;");
    assert.throws(() => h.store.schedule.import(seed()), /import interrupted/);
    for (const table of ['guild_schedule_metadata', 'guild_schedule_sheets', 'guild_schedule_entries']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    }
    db.exec('DROP TRIGGER fail_schedule_import;');
    assert.equal(h.store.schedule.import(seed()).sheets, 3);
  } finally { db.close(); }
});

test('seed validation rejects unsafe styles and overlapping, hidden, or formula entry cells', () => {
  const alterations = [
    source => { source.sheets[0].layout.styles[0].backgroundImage = 'url(https://example.com)'; },
    source => { source.sheets[0].layout.styles[0].color = 'red;display:none'; },
    source => { source.sheets[0].layout.styles[0].fontFamily = 'url(secret)'; },
    source => { source.sheets[0].layout.groups[0].cells[0].address = 'D1'; },
    source => { source.sheets[0].layout.groups[0].cells[0].address = 'B5'; source.sheets[0].layout.cells.B5 = { s: 0, v: '' }; },
    source => { source.sheets[0].layout.groups[0].cells[0].address = 'A6'; source.sheets[0].layout.cells.A6 = { s: 0, v: '' }; },
    source => { source.sheets[0].layout.groups[1].cells[0].address = 'A2'; },
    source => { source.sheets[0].layout.merges.push([5, 2, 5, 3]); },
    source => { source.sheets[0].layout.cells.D1.formula = '=SUM(B1:B9999)'; },
    source => { source.sheets[0].layout.cells.A2.rules.push({ when: 'blank', s: 1 }); },
    source => { source.sheets[0].layout.cells.A2.rules[0].when = 'javascript'; },
    source => { source.sheets[0].layout.cells.A2.s = 999; },
    source => { source.sheets[0].layout.cells.A3.runs[0].t = '숨긴 다른 값'; },
    source => { source.sheets[0].layout.cells.A3.runs[0].s = 999; },
    source => { source.sheets[0].layout.rowCount = 2001; },
    source => { source.sheets[0].id = '__proto__'; },
    source => { source.sheets.forEach(sheet => { sheet.hidden = true; }); },
  ];
  for (const alter of alterations) {
    const source = seed(); alter(source);
    fails(() => validateScheduleSeed(source), 400);
  }
});

test('migration and preserve-existing retain schedule edits, users and sessions through schema4 rollback', async t => {
  const h = await setup(t); const { alice } = h.accounts;
  h.store.schedule.edit(alice.id, edit());
  const db = new DatabaseSync(h.path);
  db.exec('PRAGMA user_version=4;');
  const before = db.prepare('SELECT * FROM guild_schedule_entries ORDER BY sheet_id,group_id').all();
  assert.deepEqual(preserveSchedule(h.path), { preserved: true, sheets: 3, groups: 12 });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
  assert.deepEqual(db.prepare('SELECT * FROM guild_schedule_entries ORDER BY sheet_id,group_id').all(), before);
  const reopened = createStore(h.path);
  try {
    assert.equal(reopened.schedule.read(alice.id).entries.entry.values.A2, '새바드');
    assert.equal(reopened.getSession(digest(alice.token), timestamp).id, alice.id);
  } finally { reopened.close(); db.close(); }
});

test('private import CLI accepts a source file or stdin, refuses missing stop flag and preserves revisions', async t => {
  const h = await setup(t, false);
  const source = join(h.directory, 'private-seed.json');
  const raw = JSON.stringify(seed());
  await writeFile(source, raw, { mode: 0o600 });
  const cli = new URL('../src/schedule-import.js', import.meta.url);
  const base = [cli.pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--database', h.path];
  const denied = spawnSync(process.execPath, [...base, '--source', source], { encoding: 'utf8' });
  assert.equal(denied.status, 1);
  assert.equal(h.store.schedule.read(h.accounts.alice.id).sheet, null);
  const result = spawnSync(process.execPath, [...base, '--source', '-', '--service-stopped'], { input: raw, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { imported: true, sheets: 3, groups: 12, sourceSha256: digest(raw) });
  assert.equal(result.stdout.includes('기존이름'), false);
  const repeat = spawnSync(process.execPath, [...base, '--source', source, '--service-stopped'], { encoding: 'utf8' });
  assert.equal(repeat.status, 1);
  assert.match(repeat.stderr, /schedule_already_imported/);
  const preserved = spawnSync(process.execPath, [...base, '--preserve-existing', '--service-stopped'], { encoding: 'utf8' });
  assert.equal(preserved.status, 0, preserved.stderr);
  assert.deepEqual(JSON.parse(preserved.stdout), { preserved: true, sheets: 3, groups: 12 });
  assert.equal((await readFile(source, 'utf8')), raw);
});

test('programmatic importer rejects invalid source before upgrading a database', async t => {
  const h = await setup(t, false);
  const db = new DatabaseSync(h.path); db.exec('PRAGMA user_version=4;');
  try {
    assert.throws(() => importSchedule(h.path, '{}'));
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.throws(() => preserveSchedule(h.path), /previously imported/);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
  } finally { db.close(); }
});
