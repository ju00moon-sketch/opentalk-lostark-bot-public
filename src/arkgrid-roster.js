import { getArmoryPart, getSiblings } from './lostark.js';

const GRADES = ['고대', '유물', '전설'];
const VALID_GRADES = new Set([...GRADES, '영웅', '희귀', '고급', '일반']);
const keyOf = (name) => name.normalize('NFC').trim().toLowerCase();
const emptyTotals = () => ({ cores: { 고대: 0, 유물: 0, 전설: 0 }, points: 0 });

function itemLevel(value) {
  const text = String(value ?? '').trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return null;
  const level = Number(text.replaceAll(',', ''));
  return Number.isFinite(level) && level >= 0 ? level : null;
}

export function summarizeGrid(grid) {
  if (grid === null || (grid && grid.Slots === null)) return null;
  if (!Array.isArray(grid?.Slots)) throw new Error('코어 정보를 확인할 수 없습니다.');
  if (!grid.Slots.length) return null;
  const totals = emptyTotals();
  const indices = new Set();
  for (const slot of grid.Slots) {
    if (!VALID_GRADES.has(slot?.Grade) || !Number.isSafeInteger(slot.Point) || slot.Point < 0) {
      throw new Error('코어 등급 또는 포인트를 확인할 수 없습니다.');
    }
    if (slot.Index != null) {
      if (indices.has(slot.Index)) throw new Error('코어 정보가 중복되었습니다.');
      indices.add(slot.Index);
    }
    // 표시할 세 등급만 세되, 영웅 등 하위 코어의 포인트도 합산한다.
    if (GRADES.includes(slot.Grade)) totals.cores[slot.Grade] += 1;
    totals.points += slot.Point;
    if (!Number.isSafeInteger(totals.points)) throw new Error('포인트를 확인할 수 없습니다.');
  }
  return totals;
}

// 진행 중인 같은 조회만 공유한다. 완료된 결과는 저장하지 않아 다음 요청에 최신 정보를 조회한다.
export function createArkgridRosterService({
  readSiblings = getSiblings,
  readGrid = (name, options) => getArmoryPart(name, 'arkgrid', options),
  requestTimeoutMs = 4000,
  totalTimeoutMs = 18000,
} = {}) {
  const pending = new Map();

  async function collect(name) {
    const deadline = AbortSignal.timeout(totalTimeoutMs);
    const requestOptions = () => ({ signal: AbortSignal.any([deadline, AbortSignal.timeout(requestTimeoutMs)]) });
    const siblings = await readSiblings(name, requestOptions());
    if (!Array.isArray(siblings) || !siblings.length) {
      throw new Error('캐릭터의 원정대를 찾을 수 없어요. 닉네임을 확인해 주세요.');
    }
    const anchor = siblings.find((row) => typeof row?.CharacterName === 'string' && keyOf(row.CharacterName) === keyOf(name));
    if (!anchor || typeof anchor.ServerName !== 'string' || !anchor.ServerName.trim()) {
      throw new Error('조회한 캐릭터의 서버를 확인할 수 없어요. 잠시 후 다시 시도해 주세요.');
    }
    const unique = new Map();
    for (const row of siblings) {
      if (!row || typeof row.ServerName !== 'string') throw new Error('원정대 목록을 확인할 수 없어요. 잠시 후 다시 시도해 주세요.');
      if (row.ServerName !== anchor.ServerName) continue;
      const level = itemLevel(row.ItemAvgLevel);
      if (typeof row.CharacterName !== 'string' || !row.CharacterName.trim() || level === null) {
        throw new Error('원정대 목록을 확인할 수 없어요. 잠시 후 다시 시도해 주세요.');
      }
      // Characters without gear (0.00) have no ark grid; they are simply left out of the roster board.
      if (level === 0) continue;
      const key = keyOf(row.CharacterName);
      if (!unique.has(key)) unique.set(key, { name: row.CharacterName, level, state: 'unavailable' });
    }
    const characters = [...unique.values()].sort((a, b) => b.level - a.level || a.name.localeCompare(b.name, 'ko'));
    let next = 0;
    let rateLimited = false;
    async function worker() {
      while (next < characters.length && !deadline.aborted && !rateLimited) {
        const row = characters[next++];
        try {
          const totals = summarizeGrid(await readGrid(row.name, requestOptions()));
          Object.assign(row, totals ? { state: 'ok', ...totals } : { state: 'empty' });
        } catch (error) {
          if (error?.status === 429) rateLimited = true;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, characters.length) }, worker));
    const totals = emptyTotals();
    for (const row of characters.filter((character) => character.state === 'ok')) {
      for (const grade of GRADES) totals.cores[grade] += row.cores[grade];
      totals.points += row.points;
      if (!Number.isSafeInteger(totals.points)) throw new Error('원정대 포인트를 확인할 수 없어요.');
    }
    return {
      name: anchor.CharacterName,
      serverName: anchor.ServerName,
      characters: characters.filter((row) => row.state !== 'empty'),
      totals,
      partial: characters.some((row) => row.state === 'unavailable'),
    };
  }

  return function getRoster(characterName) {
    const name = characterName.normalize('NFC').trim();
    const key = keyOf(name);
    if (!pending.has(key)) {
      const task = collect(name).finally(() => pending.delete(key));
      pending.set(key, task);
    }
    return pending.get(key);
  };
}

export const getArkgridRoster = createArkgridRosterService();

const coreText = (cores) => GRADES.map((grade) => `${grade} ${cores[grade]}`).join(', ');
const levelText = (level) => level.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatArkgridRoster(report) {
  const header = `❙ ${report.name}님의 원정대 아크그리드 현황`;
  if (!report.characters.length) return `${header}\n\n장착한 아크그리드 코어가 없어요.`;
  const known = report.characters.some((row) => row.state === 'ok');
  const totals = known
    ? `${report.partial ? '조회된 코어' : '총 코어'}: ${coreText(report.totals.cores)}\n${report.partial ? '조회된 포인트' : '총 포인트'}: ${report.totals.points}`
    : '코어 정보를 조회하지 못했어요. 잠시 후 다시 시도해 주세요.';
  const notice = report.partial ? '\n※ 일부 캐릭터 조회에 실패했어요. 합계에는 조회된 캐릭터만 포함됩니다.' : '';
  const rows = report.characters.map((row) => `❙ ${row.name} (${levelText(row.level)})\n${row.state === 'ok'
    ? `  코어: ${coreText(row.cores)}\n  포인트: ${row.points}`
    : '  조회 실패: 잠시 후 다시 시도해 주세요.'}`);
  return `${header}\n\n${totals}${notice}\n━━━━━━━━━━━\n\n${rows.join('\n\n')}`;
}

// 캐릭터 한 명의 세 줄을 같은 메시지에 유지한다.
export function splitArkgridReport(text, limit = 1900) {
  const chunks = [];
  for (const block of text.split('\n\n')) {
    const last = chunks.at(-1);
    if (last && last.length + block.length + 2 <= limit) chunks[chunks.length - 1] += `\n\n${block}`;
    else chunks.push(block);
  }
  return chunks;
}
