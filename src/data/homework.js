// 숙제표가 다루는 콘텐츠 목록과 초기화 주기 (README.md).
// 공식 API는 클리어 여부를 주지 않으므로 체크는 사람이 직접 한다. 여기 목록만 고치면 화면·계산이 함께 바뀐다.
// 출처: 인게임 콘텐츠 기준 2026-09-20 확인. 패치로 항목이나 횟수가 바뀌면 이 파일을 고친다.
import { RAIDS, totalGold } from './raids.js';

export const DATA_DATE = '2026-09-20';
const KST_OFFSET = 9 * 60 * 60 * 1000;

// 하루 한 번 06:00(한국 시간)에 초기화된다. max는 하루 최대 횟수.
export const DAILY = [
  { id: 'chaos', name: '카오스 던전', short: '카던', max: 2 },
  { id: 'guardian', name: '가디언 토벌', short: '가토', max: 2 },
  { id: 'epona', name: '에포나 의뢰', short: '에포나', max: 3 },
];

// 수요일 06:00(한국 시간)에 초기화된다. 레이드는 따로 고르므로 여기에는 그 밖의 주간 콘텐츠만 둔다.
export const WEEKLY = [
  { id: 'weekly-epona', name: '주간 에포나', short: '주간 에포나', max: 3 },
  { id: 'cube', name: '큐브', short: '큐브', max: 1 },
  { id: 'challenge-guardian', name: '도전 가디언 토벌', short: '도가토', max: 1 },
  { id: 'field-boss', name: '필드 보스', short: '필보', max: 1 },
  { id: 'chaos-gate', name: '카오스게이트', short: '카게', max: 1 },
];

// 골드를 받는 주간 레이드는 원정대에서 세 개까지 고를 수 있다(인게임 규칙).
export const RAID_LIMIT = 3;
// 표에 올릴 수 있는 캐릭터 수. 원정대가 더 많아도 이만큼만 고른다.
export const CHARACTER_LIMIT = 24;
// 처음 표를 만들 때 자동으로 올리는 캐릭터 수(아이템 레벨이 높은 순).
export const AUTO_CHARACTERS = 6;

export const raidId = (raid) => `${raid.name}|${raid.diff}`;
export const findRaid = (id) => RAIDS.find((raid) => raidId(raid) === id) ?? null;
// 그 캐릭터가 입장할 수 있는 레이드만, 높은 레벨부터.
export const raidsFor = (itemLevel) => RAIDS.filter((raid) => itemLevel >= raid.ilvl);

// 골드를 많이 주는 레이드부터. 고르는 목록과 저장·표시 순서가 모두 이 기준을 쓴다.
const byGold = (a, b) => totalGold(b) - totalGold(a) || b.ilvl - a.ilvl || a.name.localeCompare(b.name, 'ko');
export const RAID_CATALOGUE = [...RAIDS].sort(byGold);

// 고른 레이드를 골드가 큰 순서로. 지금 자료에 없는 것은 버린다.
export function sortRaids(ids) {
  return (Array.isArray(ids) ? ids : [])
    .map((id) => (typeof id === 'string' ? findRaid(id) : null))
    .filter((raid) => raid !== null)
    .sort(byGold)
    .map(raidId);
}

// 그 레벨에서 고를 만한 주간 레이드를 좋은 순서로. 같은 레이드는 난이도를 바꿔도 주간 골드를 한 번만 주므로
// 레이드마다 들어갈 수 있는 가장 높은 난이도만 후보로 두고, 클리어 골드가 큰 순서로 세운다.
export function rankedRaids(itemLevel) {
  const best = new Map();
  for (const raid of raidsFor(itemLevel)) {
    const found = best.get(raid.name);
    if (!found || raid.ilvl > found.ilvl) best.set(raid.name, raid);
  }
  return [...best.values()].sort(byGold);
}

// 이미 고른 레이드는 그대로 두고 세 개가 될 때까지 채운다. 같은 레이드의 다른 난이도는 더하지 않고,
// 그 레벨로 못 가는 레이드는 뺀다. 돌려주는 목록은 골드가 큰 순서다.
export function fillRaids(itemLevel, chosen = [], limit = RAID_LIMIT) {
  const room = Math.max(0, limit);
  const picked = [];
  const names = new Set();
  for (const id of Array.isArray(chosen) ? chosen : []) {
    const raid = typeof id === 'string' ? findRaid(id) : null;
    if (!raid || names.has(raid.name) || picked.length >= room || itemLevel < raid.ilvl) continue;
    names.add(raid.name);
    picked.push(id);
  }
  for (const raid of rankedRaids(itemLevel)) {
    if (picked.length >= room) break;
    if (names.has(raid.name)) continue;
    names.add(raid.name);
    picked.push(raidId(raid));
  }
  return sortRaids(picked);
}

// 그 레벨에서 고를 만한 주간 레이드 세 개.
export const autoRaids = (itemLevel, limit = RAID_LIMIT) => fillRaids(itemLevel, [], limit);

// 표를 자동으로 채운다. 이미 올라가 있는 캐릭터는 그대로 두고 저마다 레이드를 세 개까지 채우며,
// 주간 골드를 받을 수 있는 여섯 캐릭터가 되도록 아이템 레벨이 높은 순으로 더 올린다. 아무도 빼지 않는다.
// 돌려주는 값은 저장에 그대로 넘길 수 있는 { characterName, raids } 목록이다.
export function autoSelection(roster, existing = [], { count = AUTO_CHARACTERS } = {}) {
  const members = (Array.isArray(roster) ? roster : []).filter((entry) =>
    typeof entry?.characterName === 'string' && entry.characterName && Number.isFinite(entry?.itemLevel));
  const byName = new Map(members.map((entry) => [entry.characterName.toLowerCase(), entry]));
  const chosen = [];
  const seen = new Set();
  const add = (member, raids) => {
    const key = member.characterName.toLowerCase();
    if (seen.has(key) || chosen.length >= CHARACTER_LIMIT) return;
    seen.add(key);
    chosen.push({ characterName: member.characterName, raids: fillRaids(member.itemLevel, raids) });
  };
  for (const entry of Array.isArray(existing) ? existing : []) {
    const member = byName.get(String(entry?.characterName ?? '').toLowerCase());
    if (member) add(member, entry?.raids);
  }
  const target = Math.min(Math.max(0, count), CHARACTER_LIMIT);
  for (const member of [...members].sort((a, b) => b.itemLevel - a.itemLevel || a.characterName.localeCompare(b.characterName, 'ko'))) {
    if (chosen.length >= target) break;
    add(member, []);
  }
  return chosen;
}

// 관문 하나와 그 더보기를 가리키는 항목 이름. 저장과 화면이 같은 이름을 쓴다.
export const gateItem = (id, gate) => `${id}|${gate}`;
export const bonusItem = (id, gate) => `${id}|${gate}|bonus`;

const kst = (ms) => new Date(ms + KST_OFFSET);
const pad = (value) => String(value).padStart(2, '0');
const stamp = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

// 06:00 이전은 아직 어제 숙제다. 하루를 6시간 당겨 날짜만 본다.
export function dailyPeriod(ms) {
  return stamp(kst(ms - 6 * 60 * 60 * 1000));
}

// 주간은 수요일 06:00에 새로 시작한다. 그 주가 시작한 날짜를 주기 이름으로 쓴다.
export function weeklyPeriod(ms) {
  const shifted = kst(ms - 6 * 60 * 60 * 1000);
  const back = (shifted.getUTCDay() + 4) % 7; // 수요일(3)부터 며칠 지났나
  shifted.setUTCDate(shifted.getUTCDate() - back);
  return stamp(shifted);
}

// 다음 초기화까지 남은 시각(epoch ms). 화면의 안내 문구에 쓴다.
export function nextReset(ms, scope) {
  const shifted = kst(ms - 6 * 60 * 60 * 1000);
  shifted.setUTCHours(0, 0, 0, 0);
  const days = scope === 'weekly' ? 7 - ((shifted.getUTCDay() + 4) % 7) : 1;
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.getTime() - KST_OFFSET + 6 * 60 * 60 * 1000;
}
