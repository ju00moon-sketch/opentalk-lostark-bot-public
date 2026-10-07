import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

// 숙제표 화면 스크립트를 실제로 실행해 저장 순서를 본다. 전에는 저장 요청이 서로를 기다리지 않아 늦게 온 첫 응답이
// 방금 누른 체크를 화면에서 되돌렸고, 자동 선정이 도는 동안 예약된 체크는 보내지 않고 버려졌다(2026-09-23 교차 검토
// F-P2-1·F-P2-2). 응답은 시험이 원하는 순서로 하나씩 돌려준다.
const source = fs.readFileSync(new URL('../docs/todo.js', import.meta.url), 'utf8');

const board = chaos => ({
  characters: [{ characterName: '합성캐릭터', characterClass: '바드', itemLevel: 1770, raids: [], daily: { chaos }, weekly: {} }],
  daily: [{ id: 'chaos', name: '카오스 던전', short: '카던', max: 2 }], weekly: [], raids: [],
  periods: { daily: '2026-09-23', weekly: '2026-09-23' }, resets: {}, limits: { raids: 3, characters: 24, auto: 6 }, roster: [],
  csrfToken: 'synthetic-csrf', dataDate: '2026-09-23',
});

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {};
    this.className = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.style = {};
    this.classList = { add: () => {}, remove: () => {}, toggle: () => {} };
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  // 처리기가 돌려주는 약속은 기다리지 않는다 — 응답은 시험이 따로 돌려준다.
  fire(name) { for (const fn of this.listeners[name] ?? []) fn({ preventDefault() {} }); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  // 캐릭터 고르기 저장이 읽는 선택 상자만 흉내 낸다.
  querySelectorAll(selector) { return selector === 'input:checked' ? this.all().filter(node => node.tagName === 'input' && node.checked) : []; }
  focus() {}
  all() { return this.children.flatMap(child => [child, ...child.all()]); }
}

function run() {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Element('div')); return nodes.get(id); };
  const calls = [];
  const fetch = (path, options = {}) => new Promise((resolve, reject) => calls.push({ path, method: options.method ?? 'GET',
    body: options.body ? JSON.parse(options.body) : null,
    reply: body => resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body }),
    fail: (status, code = 'failed') => resolve({ ok: false, status, headers: { get: () => 'application/json' }, json: async () => ({ error: code }) }),
    drop: () => reject(new TypeError('Failed to fetch')) }));
  const timers = new Map();
  let serial = 0;
  const context = {
    document: { hidden: false, getElementById: get, createElement: tag => new Element(tag), addEventListener: () => {} },
    window: { pogeunSiteAccess: { approved: true }, addEventListener: () => {}, publishPogeunSiteAccess: () => {} },
    location: { origin: 'https://opentalk.example.invalid', pathname: '/todo.html', replace: () => {} },
    console, fetch, setTimeout: (fn, ms) => { timers.set(++serial, { fn, ms }); return serial; }, clearTimeout: id => timers.delete(id),
    JSON, Math, Number, Date, Intl, Object, Array, String, Boolean, Promise, Error, Map, Set, AbortController, AbortSignal,
  };
  context.globalThis = context;
  vm.createContext(context);
  new vm.Script(source).runInContext(context);
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  // 클릭 뒤 0.5초 모으기를 지금 끝낸다.
  const debounce = () => { for (const [id, timer] of timers) if (timer.ms === 500) { timers.delete(id); timer.fn(); } };
  const chaos = () => get('todo-board').all().find(node => node.tagName === 'button' && node.className.startsWith('todo-item'));
  const shown = () => chaos().children.find(child => child.className === 'todo-item-count').textContent;
  return { get, calls, settle, debounce, chaos, shown };
}

test('두 번 누른 체크는 차례로 보내고, 늦게 온 첫 응답이 방금 누른 값을 되돌리지 않는다', async () => {
  const { calls, settle, debounce, chaos, shown } = run();
  await settle();
  calls[0].reply(board(0));
  await settle();
  assert.equal(shown(), '0/2');
  chaos().fire('click');
  debounce();
  await settle();
  assert.deepEqual(calls.slice(1).map(call => call.body.changes[0].value), [1]);
  chaos().fire('click');
  debounce();
  await settle();
  assert.equal(calls.length, 2, '첫 저장 응답을 받기 전에는 둘째 요청을 보내지 않는다');
  assert.equal(shown(), '2/2');
  calls[1].reply(board(1));
  await settle();
  assert.equal(shown(), '2/2', '첫 응답(1/2)이 아직 보내지 않은 2/2를 덮지 않는다');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].body.changes[0].value, 2);
  calls[2].reply(board(2));
  await settle();
  assert.equal(shown(), '2/2');
});

test('체크를 누르고 바로 자동 선정을 눌러도 체크를 먼저 보낸 뒤 표를 바꾼다', async () => {
  const { get, calls, settle, chaos, shown } = run();
  await settle();
  calls[0].reply(board(0));
  await settle();
  chaos().fire('click'); // 0.5초가 지나기 전에 자동 선정을 누른다.
  get('todo-auto').fire('click');
  await settle();
  assert.deepEqual(calls.slice(1).map(call => call.path), ['/api/auth/homework/check']);
  calls[1].reply(board(1));
  await settle();
  assert.deepEqual(calls.slice(1).map(call => call.path), ['/api/auth/homework/check', '/api/auth/homework/auto']);
  calls[2].reply(board(1));
  await settle();
  assert.equal(shown(), '1/2', '방금 누른 체크가 저장된 채로 남는다');
});

// 저장이 실패한 뒤에 줄 선 요청은 그 실패를 덮지 않는다(2026-09-23 교차 검토 F-R1).
test('새로고침은 저장하지 못한 체크를 덮지 않고, 다시 보내 저장된 뒤에야 판을 새로 읽는다', async () => {
  const { get, calls, settle, chaos, shown } = run();
  await settle();
  calls[0].reply(board(0));
  await settle();
  chaos().fire('click');
  get('todo-refresh').fire('click');
  await settle();
  assert.equal(calls[1].path, '/api/auth/homework/check');
  calls[1].fail(503);
  await settle();
  assert.equal(calls.length, 2, '체크를 저장하지 못했으면 판을 새로 읽지 않는다');
  assert.equal(shown(), '1/2', '누른 체크는 화면에 남는다');
  assert.match(get('todo-status').textContent, /저장하지 못했어요/);
  get('todo-refresh').fire('click');
  await settle();
  assert.equal(calls[2].path, '/api/auth/homework/check', '새로고침이 남은 체크를 먼저 다시 보낸다');
  assert.equal(calls[2].body.changes[0].value, 1);
  calls[2].reply(board(1));
  await settle();
  assert.equal(calls[3].path, '/api/auth/homework');
  calls[3].reply(board(1));
  await settle();
  assert.equal(shown(), '1/2');
});

test('앞선 체크 저장이 실패하면 뒤에 줄 선 자동 선정은 다시 보내 본 뒤에만 진행한다', async () => {
  const { get, calls, settle, debounce, chaos, shown } = run();
  await settle();
  calls[0].reply(board(0));
  await settle();
  chaos().fire('click');
  debounce();
  await settle();
  get('todo-auto').fire('click');
  calls[1].fail(503);
  await settle();
  assert.equal(calls[2].path, '/api/auth/homework/check', '자동 선정 전에 저장하지 못한 체크를 다시 보낸다');
  calls[2].fail(503);
  await settle();
  assert.equal(calls.length, 3, '다시 보내도 안 되면 자동 선정을 하지 않는다');
  assert.equal(shown(), '1/2');
  assert.match(get('todo-status').textContent, /저장하지 못했어요/);
  get('todo-auto').fire('click');
  await settle();
  calls[3].reply(board(1));
  await settle();
  assert.deepEqual(calls.slice(3).map(call => call.path), ['/api/auth/homework/check', '/api/auth/homework/auto']);
  calls[4].reply(board(1));
  await settle();
  assert.equal(shown(), '1/2');
});

test('다시 보내도 안 될 실패는 표 바꾸기를 멈추고, 새로고침이 저장된 상태로 되돌린다', async () => {
  const { get, calls, settle, debounce, chaos, shown } = run();
  await settle();
  calls[0].reply(board(0));
  await settle();
  chaos().fire('click');
  debounce();
  await settle();
  calls[1].fail(409);
  await settle();
  assert.match(get('todo-status').textContent, /「새로고침」을 누르면 저장된 상태로 돌아가요/);
  get('todo-auto').fire('click');
  await settle();
  assert.equal(calls.length, 2, '저장하지 못한 체크를 되돌리기 전에는 표를 바꾸지 않는다');
  get('todo-refresh').fire('click');
  await settle();
  assert.equal(calls[2].path, '/api/auth/homework', '다시 보내도 안 될 체크는 다시 보내지 않는다');
  calls[2].reply(board(0));
  await settle();
  assert.equal(shown(), '0/2', '저장된 상태로 돌아간다');
  assert.match(get('todo-status').textContent, /저장하지 못한 체크는 빼고/);
});

// 체크 저장 응답에는 원정대 목록(roster)이 없다(GET·캐릭터 저장·자동 선정 응답에만 있다). 전에는 그 응답이 판을 통째로
// 바꿔 「캐릭터 고르기」가 비었고, 그 상태로 저장하면 빈 명단이 저장된 뒤 자동 선정이 기본 6명으로 다시 채웠다.
const ROSTER = ['합성캐릭터4', '합성캐릭터3', '합성캐릭터2', '포근한도화가', '상돈창술', '상돈서머너', '카마인부캐']
  .map((characterName, index) => ({ characterName, characterClass: '바드', itemLevel: 1775 - index * 20 }));
// withoutRoster: 체크 저장 응답처럼 roster 키 자체가 없는 판.
const memberBoard = ({ names = ROSTER.map(entry => entry.characterName), roster = ROSTER, withoutRoster = false, chaos = 0 } = {}) => {
  const value = { ...board(chaos), roster };
  if (withoutRoster) delete value.roster;
  value.characters = names.map(name => ({ ...ROSTER.find(entry => entry.characterName === name), raids: [], daily: { chaos }, weekly: {} }));
  return value;
};
const rosterRows = get => get('todo-roster').children.filter(child => child.className === 'todo-roster-row');

test('체크 저장 응답에 원정대 목록이 없어도 「캐릭터 고르기」는 직전 목록을 이어 쓴다', async () => {
  const { get, calls, settle, debounce, chaos } = run();
  await settle();
  calls[0].reply(memberBoard());
  await settle();
  get('todo-pick').fire('click');
  assert.equal(rosterRows(get).length, 7);
  chaos().fire('click');
  debounce();
  await settle();
  assert.equal(calls[1].path, '/api/auth/homework/check');
  calls[1].reply(memberBoard({ withoutRoster: true, chaos: 1 }));
  await settle();
  assert.equal(rosterRows(get).length, 7, '체크 뒤에도 원정대 7명이 선택지로 남는다');
  assert.equal(get('todo-save').disabled, false);
});

test('직접 고른 명단은 체크 뒤 저장해도 빈 목록으로 바뀌지 않는다', async () => {
  const { get, calls, settle, debounce, chaos } = run();
  await settle();
  calls[0].reply(memberBoard());
  await settle();
  chaos().fire('click');
  debounce();
  await settle();
  calls[1].reply(memberBoard({ withoutRoster: true, chaos: 1 }));
  await settle();
  get('todo-pick').fire('click');
  get('todo-save').fire('click');
  await settle();
  assert.equal(calls[2].path, '/api/auth/homework/characters');
  assert.deepEqual(calls[2].body.characters.map(entry => entry.characterName), ROSTER.map(entry => entry.characterName),
    '고른 7명(카마인부캐 포함)을 그대로 보낸다');
});

test('원정대 목록을 한 번도 받지 못했으면 캐릭터 고르기를 저장하지 않고 안내한다', async () => {
  const { get, calls, settle } = run();
  await settle();
  calls[0].reply(memberBoard({ roster: null }));
  await settle();
  get('todo-pick').fire('click');
  assert.equal(rosterRows(get).length, 0);
  assert.equal(get('todo-save').disabled, true, '고를 목록이 없으면 저장 단추를 끈다');
  get('todo-save').fire('click');
  await settle();
  assert.equal(calls.length, 1, '빈 명단을 저장하지 않는다');
  assert.match(get('todo-status').textContent, /원정대 목록/);
});

// 캐릭터 저장이 실패하면 자동 선정으로 넘어가지 않는다. 전에는 저장 실패(422·503·연결 끊김) 뒤에도 /auto를 보내
// 서버가 기본 인원으로 다시 채웠고, 실패 안내가 「저장했어요」로 덮였다(2026-09-23 P1 교차 검토에서 재현).
const RAIDS = [{ id: '합성레이드|노말', name: '합성레이드', diff: '노말', ilvl: 1600, gates: [{ g: 100, bonus: 0 }] }];
const paths = calls => calls.map(call => call.path);
async function saveAllSeven(outcome) {
  const h = run();
  await h.settle();
  h.calls[0].reply({ ...memberBoard(), raids: RAIDS });
  await h.settle();
  h.get('todo-pick').fire('click');
  h.get('todo-save').fire('click');
  await h.settle();
  assert.equal(h.calls[1].path, '/api/auth/homework/characters');
  assert.equal(h.calls[1].body.characters.length, 7);
  outcome(h.calls[1]);
  await h.settle();
  return h;
}

for (const [label, outcome, notice] of [
  ['원정대에 없는 캐릭터(422)로', call => call.fail(422, 'member_roster_selection_invalid'), '내 원정대에 없는 캐릭터는 표에 올릴 수 없어요.'],
  ['서버 오류(503)로', call => call.fail(503), '캐릭터를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.'],
  ['연결 끊김으로', call => call.drop(), '캐릭터를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.'],
]) {
  test(`캐릭터 저장이 ${label} 실패하면 자동 선정을 보내지 않고 실패 안내를 남긴다`, async () => {
    const h = await saveAllSeven(outcome);
    assert.deepEqual(paths(h.calls), ['/api/auth/homework', '/api/auth/homework/characters'], '실패 뒤 /auto를 보내지 않는다');
    assert.equal(h.get('todo-status').textContent, notice);
  });
}

test('캐릭터 저장이 성공하면 채울 것이 남았을 때 지금처럼 자동 선정을 이어 보낸다', async () => {
  const h = await saveAllSeven(call => call.reply({ ...memberBoard(), raids: RAIDS }));
  assert.deepEqual(paths(h.calls).slice(1), ['/api/auth/homework/characters', '/api/auth/homework/auto']);
  h.calls[2].reply({ ...memberBoard(), raids: RAIDS });
  await h.settle();
  assert.equal(h.get('todo-status').textContent, '표에 올린 캐릭터와 레벨에 맞는 주간 레이드를 저장했어요.');
});

test('모두 해제하고 저장하면 지금처럼 빈 명단을 저장한 뒤 자동 선정이 기본 인원을 채운다', async () => {
  const h = run();
  await h.settle();
  h.calls[0].reply(memberBoard());
  await h.settle();
  h.get('todo-pick').fire('click');
  for (const box of h.get('todo-roster').all().filter(node => node.tagName === 'input')) { box.checked = false; box.fire('change'); }
  h.get('todo-save').fire('click');
  await h.settle();
  assert.deepEqual(h.calls[1].body.characters, []);
  h.calls[1].reply(memberBoard({ names: [] }));
  await h.settle();
  assert.equal(h.calls[2].path, '/api/auth/homework/auto');
});

// 선택창을 연 채 카드의 숙제 칸을 체크하면 체크 응답 뒤 다시 그리면서 아직 저장하지 않은 선택이 표 기준으로 되돌아갔다.
test('선택창을 연 동안에는 체크 응답 뒤에도 저장 전 선택을 유지하고, 닫으면 표 기준으로 돌아간다', async () => {
  const h = run();
  await h.settle();
  h.calls[0].reply(memberBoard());
  await h.settle();
  h.get('todo-pick').fire('click');
  const boxes = () => h.get('todo-roster').all().filter(node => node.tagName === 'input');
  for (const box of boxes().slice(5)) { box.checked = false; box.fire('change'); }
  assert.equal(h.get('todo-picker-count').textContent, '5 / 24명 선택');
  h.chaos().fire('click');
  h.debounce();
  await h.settle();
  assert.equal(h.calls[1].path, '/api/auth/homework/check');
  h.calls[1].reply(memberBoard({ withoutRoster: true, chaos: 1 }));
  await h.settle();
  assert.deepEqual(boxes().map(box => box.checked), [true, true, true, true, true, false, false], '다시 그려도 저장 전 선택이 남는다');
  assert.equal(h.get('todo-picker-count').textContent, '5 / 24명 선택');
  h.get('todo-cancel').fire('click');
  h.get('todo-pick').fire('click');
  assert.equal(boxes().filter(box => box.checked).length, 7, '닫았다 열면 저장된 표 기준');
  h.get('todo-pick').fire('click');
  h.get('todo-pick').fire('click');
  for (const box of boxes().slice(5)) { box.checked = false; box.fire('change'); }
  h.get('todo-save').fire('click');
  await h.settle();
  assert.equal(h.calls.at(-1).path, '/api/auth/homework/characters');
  assert.equal(h.calls.at(-1).body.characters.length, 5);
});

test('선택창은 기준 인원보다 적게 고르면 레벨 높은 순으로 채운다는 것을 미리 알려 준다', async () => {
  const h = run();
  await h.settle();
  h.calls[0].reply(memberBoard());
  await h.settle();
  h.get('todo-pick').fire('click');
  const hint = h.get('todo-roster').children.find(child => child.className === 'todo-picker-hint');
  assert.ok(hint, '선택창에 안내가 있다');
  assert.match(hint.textContent, /6명보다 적게 고르면/);
  assert.match(hint.textContent, /아이템 레벨이 높은 순/);
});
