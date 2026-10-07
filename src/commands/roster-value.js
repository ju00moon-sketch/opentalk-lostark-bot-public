import { SlashCommandBuilder } from 'discord.js';
import { rankLabel, num, runBoard } from '../ranking.js';
import { commandButtons } from '../buttons.js';
import { getLinkedCharacter } from '../user-store.js';
import { getSiteRosterValues, requestRosterValueRefresh, compactGoldText } from '../site-valuation.js';

// 원정대 환산 가치 랭킹: 이 서버 멤버 중 /등록한 사람들의 1720 이상 캐릭터 전부를 골드로 환산한 합
// (재련·보석·악세서리·각인서·팔찌·아크그리드 젬, 각인서는 서버별 1회). 기준은 원정대 단위 최고 기록이다 —
// 한 시점의 1720↑ 원정대 합을 기록으로 두고 더 높을 때만 갈아치우며, 기록 시점의 장비를 매일 오늘 시세로 다시
// 값을 매긴다. 그래서 보석을 창고에 두거나 부캐에 끼운 채 새벽 갱신을 맞아도 합이 떨어지지 않는다.
// 명령 시점에 계산하면 수십 분이 걸리므로 홈페이지가 저장해 둔 값만 읽는다
// (README.md). 로펙 점수 합은 /체급, 개인 스펙은 /랭킹.
export const data = new SlashCommandBuilder()
  .setName('환산가치')
  .setDescription('길드 내 원정대 환산 가치 랭킹 — 등록된 길드원의 1720↑ 캐릭터 골드 환산 가치 최고 기록')
  .addIntegerOption((option) =>
    option.setName('페이지').setDescription('몇 쪽 (한 쪽에 25명)').setMinValue(1).setMaxValue(20),
  )
  .addStringOption((option) =>
    option.setName('갱신').setDescription('내 등록 캐릭터의 원정대를 지금 장비로 다시 계산')
      .addChoices({ name: '지금', value: '지금' }),
  );

const RAID_LEVEL = 1720; // 원정대 체급에 넣는 최소 레벨
const REFRESH_LIMIT = 64; // 홈페이지가 한 번에 받는 앵커 수
// 아직 저장된 값이 없는 사람은 새벽 갱신까지 기다리지 않고 그 이름들만 바로 계산을 요청한다.
export const REFRESH_NOTE = '계산을 시작했어요. 1~3분 뒤 다시 확인해 주세요';
const WAIT_NOTE = '새벽 갱신 뒤 다시 확인해 주세요';
// 기록이 무엇을 재는지 한 줄로 — 오늘 장비가 기록보다 낮아 보일 때 어디를 눌러야 하는지까지 적는다.
export const RECORD_NOTE = '원정대 최고 기록 기준(장비는 기록 시점, 시세는 매일 갱신) · 지금 장비로 다시 계산하려면 /환산가치 갱신';
export const REGISTER_HINT = '캐릭터를 먼저 등록해 주세요. 등록한 원정대만 다시 계산할 수 있어요.';
export const RUNNING_NOTE = '지금 계산 중이에요. 잠시 뒤 다시 확인해 주세요.';
export const SITE_DOWN_NOTE = '홈페이지가 답하지 않아요. 잠시 뒤 다시 시도해 주세요.';
const KST_OFFSET = 9 * 60 * 60 * 1000;
const level = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const pad = (value) => String(value).padStart(2, '0');

// 저장된 계산 시각을 한국 시간 MM/DD HH:MM으로 — 얼마나 오래된 값인지 판 아래에서 바로 보이게 한다.
export function kstStamp(at) {
  const date = new Date(at + KST_OFFSET);
  return `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

// 기록을 세운 날짜만 — 줄 끝에 「기록 09/19」로 붙는다.
export function kstDate(at) {
  const date = new Date(at + KST_OFFSET);
  return `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`;
}

export async function expeditionBoard(entries, { requestRefresh = requestRosterValueRefresh } = {}) {
  const values = await getSiteRosterValues(entries.map((e) => e.character));
  const ranked = [];
  const failed = [];
  const pending = [];
  for (const e of entries) {
    const anchor = values?.get(e.character.toLowerCase());
    const characters = Array.isArray(anchor?.roster?.characters) ? anchor.roster.characters : null;
    if (anchor?.status === 'missing' || (values && !anchor)) pending.push(e.character);
    if (!anchor || !characters) {
      failed.push(e.character);
      continue;
    }
    const raid = characters.filter((c) => level(c.itemLevel) >= RAID_LEVEL);
    // 기록이 있으면 순위도 줄도 기록 기준이다. 기록이 아직 없는 첫 실행 전에만 지금 장비의 값을 쓴다.
    const record = anchor.record?.status === 'ok' && Number.isSafeInteger(anchor.record?.recordedAt) ? anchor.record : null;
    const counts = record?.counts;
    const known = record
      ? (Number.isSafeInteger(counts?.knownCharacters) ? counts.knownCharacters : 0)
      : (Number.isSafeInteger(anchor.aggregate?.counts?.knownCharacters) ? anchor.aggregate.counts.knownCharacters : 0);
    const raidCount = record ? (Number.isSafeInteger(counts?.characters) ? counts.characters : 0) : raid.length;
    ranked.push({
      ...e,
      gold: level(record ? record.knownGold : anchor.aggregate?.knownGold),
      known,
      raidCount,
      dealers: record ? (Number.isSafeInteger(counts?.dealers) ? counts.dealers : 0) : raid.filter((c) => c.role === 'dealer').length,
      supports: record ? (Number.isSafeInteger(counts?.supports) ? counts.supports : 0) : raid.filter((c) => c.role === 'support').length,
      unknown: Math.max(0, raidCount - known),
      best: Math.max(0, ...characters.map((c) => level(c.itemLevel))),
      total: characters.length,
      recordedAt: record ? record.recordedAt : null,
      computedAt: Number.isSafeInteger(anchor.computedAt?.oldest) ? anchor.computedAt.oldest : null,
    });
  }
  // 아직 값이 없는 사람은 금액이 0이라 위로 올라오면 안 된다 — 판 맨 아래에서 「계산 대기」로 적는다.
  ranked.sort((a, b) => (b.gold > 0) - (a.gold > 0) || b.gold - a.gold || b.raidCount - a.raidCount);

  // 사이트가 아예 답하지 못했으면 요청해도 소용없다. 실패는 조용히 넘기고 안내 문구만 원래대로 둔다.
  let started = false;
  if (values && pending.length > 0) {
    try { started = Boolean(await requestRefresh(pending.slice(0, REFRESH_LIMIT))); } catch { started = false; }
  }
  const waitNote = started ? REFRESH_NOTE : WAIT_NOTE;

  const lines = ranked.map((e, i) => {
    if (e.raidCount === 0) {
      return `${rankLabel(i)} **${e.character}**\n└ ${RAID_LEVEL}↑ 캐릭 없음 · 총 ${e.total}캐`;
    }
    if (e.gold <= 0) {
      return `${rankLabel(i)} **${e.character}** · 최고 ${num(e.best)}\n└ 계산 대기 · ${RAID_LEVEL}↑ **${e.raidCount}캐** · ${waitNote}`;
    }
    const roles = ` (딜 ${e.dealers} · 폿 ${e.supports})`;
    // 대체 매물 기준으로 값을 매긴 캐릭터는 합계에 들어가므로 여기서는 진짜로 값이 없는 캐릭터만 센다.
    const unknown = e.unknown ? ` · 일부 시세 없음 ${e.unknown}캐` : '';
    const stamp = e.recordedAt === null ? '' : ` · 기록 ${kstDate(e.recordedAt)}`;
    return `${rankLabel(i)} **${e.character}** · 최고 ${num(e.best)}\n`
      + `└ 환산 가치 **${compactGoldText(e.gold)}** · ${RAID_LEVEL}↑ **${e.raidCount}캐**${roles}`
      + ` · 평균 ${compactGoldText(e.gold / e.raidCount)}${unknown}${stamp}`;
  });

  const computed = ranked.map((e) => e.computedAt).filter((at) => Number.isSafeInteger(at));
  const stamp = computed.length > 0 ? ` · 가장 오래된 계산 ${kstStamp(Math.min(...computed))}` : '';
  return {
    title: `🏆 길드 내 원정대 환산 가치 랭킹 — ${RAID_LEVEL}↑ 골드 환산`,
    footer: `${RAID_LEVEL} 이상 캐릭터의 원정대 환산 가치 합(재련·보석·악세서리·각인서·팔찌·아크그리드 젬, 각인서는 서버별 1회)`
      + ` · 홈페이지 캐릭터 화면과 같은 기준${stamp}`,
    note: RECORD_NOTE,
    sections: [{ name: null, ranked, lines }],
    failed,
    failedHint: `아직 계산 전이에요. ${waitNote}`,
  };
}

// `/체급 갱신` — 판을 만들지 않고 호출자의 등록 원정대 하나만 지금 장비로 다시 계산해 달라고 홈페이지에 청한다.
export async function refreshMyRoster(interaction, { requestRefresh = requestRosterValueRefresh, linked = getLinkedCharacter } = {}) {
  const kakao = interaction.platform === 'kakao';
  const name = linked(interaction.user?.id);
  if (!name) {
    await interaction.reply(`${kakao ? '/등록으로' : '`/등록`으로'} ${REGISTER_HINT}`);
    return;
  }
  await interaction.deferReply();
  let result = null;
  try { result = await requestRefresh([name]); } catch { result = null; }
  const status = typeof result?.status === 'string' ? result.status : null;
  await interaction.editReply(
    status === 'started' ? `${kakao ? name : `**${name}**`} 원정대 ${REFRESH_NOTE}.`
      : status === 'running' ? RUNNING_NOTE
        : SITE_DOWN_NOTE,
  );
}

export async function execute(interaction) {
  // 쪽 넘김과 같이 써도 갱신이 우선이다 — 계산을 청한 사람에게 판부터 내밀 이유가 없다.
  if (interaction.options.getString?.('갱신') === '지금') {
    await refreshMyRoster(interaction);
    return;
  }
  await runBoard(interaction, expeditionBoard, commandButtons([{ cmd: '체급', label: '로펙 점수 합 보기' }]), { command: '환산가치' });
}
