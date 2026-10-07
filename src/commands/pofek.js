import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { EMBED_COLOR } from '../format.js';
import { resolveCharacter, NO_CHARACTER_HINT } from '../user-store.js';
import { TITLE, NOTE, row, blocks } from '../kakao/layout.js';
import { getSiteSpec } from '../site-valuation.js';
import { TIERS } from '../score-tier.js';
import { isCustomTierArt } from '../tier-art.js';

// /포펙 — 포근해용 홈페이지가 계산한 환산 점수·티어·최고 기록. 첫 메시지는 티어 카드(이미지), 둘째 메시지가 스펙 요약이다.
export const SITE_URL = 'https://opentalk.example.invalid';
export const TIER_KEYS = ['iron', 'bronze', 'silver', 'gold', 'platinum', 'diamond', 'master', 'grandmaster', 'challenger', 'esther'];

export const data = new SlashCommandBuilder()
  .setName('포펙')
  .setDescription('포근해용 환산 점수 · 티어 · 최고 기록 (홈페이지 계산)')
  .addStringOption((option) =>
    option.setName('닉네임').setDescription('캐릭터 닉네임 (비우면 /등록한 내 캐릭터)'),
  );

const UNAVAILABLE = '홈페이지에서 환산 점수를 가져오지 못했어요. 잠시 후 다시 시도해 주세요.';
const RUNNING = '계산 중 · 잠시 후 다시 조회해 주세요.';
const NOT_COMPUTED = '홈페이지에서 환산 점수를 계산하지 못했어요. 홈페이지 캐릭터 화면의 「계산할 수 없는 항목」을 확인해 주세요.';

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const num = (value, digits = 2) => Number(value).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (value) => (value < 0.005 ? '0.01% 미만' : `${num(value)}%`);
// Record dates read in Korean time regardless of the server clock.
const kstDate = (ms) => { const d = new Date(ms + 9 * 3600 * 1000); return `${d.getUTCFullYear()}.${d.getUTCMonth() + 1}.${d.getUTCDate()}`; };
export const tierCardUrl = (key) => `${SITE_URL}/assets/tiers/${key}-card.png`;

// The same three-way wording the character page uses under its tier emblem.
export function tierBasisText(tier) {
  if (!tier) return '점수 구간 기준 · 순위 자료 없음';
  if (tier.status === 'ok' && finite(tier.percentile) && typeof tier.source === 'string') return `${tier.source} 기준 상위 ${pct(tier.percentile)}`;
  const ref = tier.reason === 'lopec_record_mismatch' ? tier.reference : null;
  if (ref && finite(ref.score) && finite(ref.percentile)) return `현재 장착 점수 구간 기준 · 로펙 최고 기록 ${num(ref.score, 0)}점 기준 상위 ${pct(ref.percentile)}`;
  return '점수 구간 기준 · 순위 자료 없음';
}

// 환산 점수 줄: 최고 기록 점수를 앞세우고, 현재 점수가 다르면 괄호로 덧붙인다.
export function scoreText(score, record) {
  const best = record && finite(record.score) ? record.score : score;
  const differs = Math.abs(best - score) > 0.005;
  return `${num(best)}점${differs ? ` (현재 ${num(score)}점)` : ''}`;
}
// 다음 티어 줄: 필요한 상위 %와 이름. 에스더는 다음이 없다.
export function nextTierText(tier) {
  const next = tier?.next;
  if (!next || typeof next.name !== 'string') return '최고 티어';
  return finite(next.percentile) ? `${next.name} · 상위 ${pct(next.percentile)} 이내` : next.name;
}
// 맨 아래 한 줄: 티어별 상위 % 컷(score-tier.js와 같은 표).
export const TIER_DISTRIBUTION = [...TIERS].reverse().map((row) => (finite(row.percentCut) ? `${row.name} ${num(row.percentCut, Number.isInteger(row.percentCut) ? 0 : 1)}%` : `${row.name} 그 외`)).join(' · ');
export function recordText(record) {
  if (!record || !finite(record.score) || !Number.isSafeInteger(record.recordedAt)) return null;
  return `${num(record.score)}점 · ${kstDate(record.recordedAt)}${record.current ? ' · 현재 점수' : ''}`;
}

const efficiencyText = (entry) => (entry?.status === 'ok' && finite(entry.efficiency) ? `${num(entry.efficiency)}%` : '계산 불가');

function validSpec(spec) {
  return spec && typeof spec === 'object' && spec.status === 'ok' && finite(spec.score?.score) && spec.tier && TIER_KEYS.includes(spec.tier.key)
    && typeof spec.tier.name === 'string' && spec.tier.name.length <= 12;
}

// 조회 함수는 주입할 수 있다 — 테스트는 홈페이지 없이 출력만 확인한다.
export function createExecute({ siteSpec = getSiteSpec } = {}) {
  return async function execute(interaction) {
    const name = resolveCharacter(interaction);
    if (!name) {
      await interaction.reply(NO_CHARACTER_HINT);
      return;
    }
    await interaction.deferReply();

    const spec = await siteSpec(name);
    if (!spec) { await interaction.editReply(`\`${name}\` — ${UNAVAILABLE}`); return; }
    if (spec.status === 'running') { await interaction.editReply(`\`${name}\` — ${RUNNING}`); return; }
    if (!validSpec(spec)) { await interaction.editReply(`\`${name}\` — ${NOT_COMPUTED}`); return; }

    const profile = spec.profile ?? {};
    const displayName = typeof profile.characterName === 'string' && profile.characterName ? profile.characterName : name;
    // 전용 그림 대상(합성원정대 원정대)은 카드 그림만 바뀌고 티어 이름·기준·순위는 실제 티어 그대로다.
    const artKey = isCustomTierArt(spec.tier.art) ? spec.tier.art.key : spec.tier.key;
    const role = spec.score.role === 'support' ? '서포터' : '딜러';
    const basis = tierBasisText(spec.tier);
    const scoreLine = scoreText(spec.score.score, spec.record);
    const nextLine = nextTierText(spec.tier);
    const identity = [profile.characterClass, profile.serverName, finite(profile.itemLevel) ? `Lv.${num(profile.itemLevel)}` : null].filter(Boolean).join(' · ');
    const power = finite(profile.combatPower) ? num(profile.combatPower) : null;

    if (interaction.platform === 'kakao') {
      await interaction.editReply({
        content: blocks(
          TITLE(`${displayName} · 포근해용 스펙`),
          [row('환산 점수', scoreLine), row('티어', `${spec.tier.name} · ${role}`), row('기준', basis), row('다음 티어', nextLine)].join('\n'),
          [row('팔찌 효율', efficiencyText(spec.bracelet)), row('젬 효율', efficiencyText(spec.gem)),
            power ? row('공식 전투력', power) : null, identity ? row('캐릭터', identity) : null].filter(Boolean).join('\n'),
          NOTE(`티어 기준(상위 %) ${TIER_DISTRIBUTION}`),
          NOTE('포근해용 계산 기준 · 홈페이지 캐릭터 화면과 같은 값이에요'),
        ),
        tierCard: { key: artKey, name: displayName }, // 방에 먼저 보낼 티어 카드 (이미지)
      });
      return;
    }

    // First message: the tier emblem only; every number follows in the second message.
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setImage(tierCardUrl(artKey))] });

    const lines = [
      `환산 점수 **${scoreLine}** · ${spec.tier.name} · ${role}`,
      basis,
      `다음 티어 ${nextLine}`,
      `팔찌 효율 ${efficiencyText(spec.bracelet)} · 젬 효율 ${efficiencyText(spec.gem)}`,
      [power ? `공식 전투력 ${power}` : null, identity].filter(Boolean).join(' · ') || null,
    ].filter(Boolean);
    const specEmbed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`📊 ${displayName} — 포근해용 환산 점수`)
      .setThumbnail(typeof profile.characterImage === 'string' && profile.characterImage.startsWith('https://') ? profile.characterImage : null)
      .setDescription(lines.join('\n'))
      .addFields({ name: '티어 기준 (상위 %)', value: TIER_DISTRIBUTION })
      .setFooter({ text: '포근해용 계산 기준 · 홈페이지 캐릭터 화면과 같은 값이에요' });
    await interaction.followUp({ embeds: [specEmbed] });
  };
}

export const execute = createExecute();
