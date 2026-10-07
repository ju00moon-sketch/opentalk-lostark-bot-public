import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getFullArmory } from '../lostark.js';
import { trunc, EMBED_COLOR, NOT_FOUND_HINT } from '../format.js';
import { resolveCharacter, NO_CHARACTER_HINT } from '../user-store.js';
import { analyzeCrit } from '../crit-analysis.js';

export const data = new SlashCommandBuilder()
  .setName('치적')
  .setDescription('치명타 적중률을 출처별로 합산합니다')
  .addStringOption((option) =>
    option.setName('닉네임').setDescription('캐릭터 닉네임 (비우면 /등록한 내 캐릭터)'),
  );

const pct = (n) => `${n.toFixed(2)}%`;

function bluntThornLines(node) {
  if (!node) return [];
  const warning = `⚠️ 뭉툭한 가시 Lv.${node.level} 채용중`;
  const skipped = [warning + ' (효과 수치를 읽지 못해 계산 생략)'];
  if (!node.effect || !node.calculation) return skipped;
  const { base, cap, rate, max } = node.effect;
  const { excess, converted, evolutionDamage: evo, capped } = node.calculation;
  const calculation = `기본 ${pct(base)} + 초과 치적 ${pct(excess)} × ${rate}% = ${pct(converted)}`;
  const detail = capped ? `상한 도달 — ${calculation}`
    : excess === 0 ? '기본, 초과 치적 없음'
      : `${calculation}, 노드 상한 ${pct(max)}`;
  return [
    `${warning} — 치적은 ${pct(cap)}까지만 적용`,
    `진화형 피해 +${pct(evo)} (${detail})`,
  ];
}

function groupedSourceLines(sources) {
  return sources.map(({ source, value, details }) => {
    const labels = details.map((row) => {
      const suffix = row.stacks > 1 ? ` (${row.baseValue}% ×${row.stacks}중첩)` : '';
      const detail = row.detail + suffix;
      return details.length > 1 ? `${detail} ${pct(row.value)}` : detail;
    });
    return `• ${source}: ${pct(value)}${labels.length ? ` (${labels.join(' · ')})` : ''}`;
  });
}

export function critFooter() {
  return '파티 시너지는 제외';
}

export async function execute(interaction) {
  const name = resolveCharacter(interaction);
  if (!name) {
    await interaction.reply(NO_CHARACTER_HINT);
    return;
  }
  await interaction.deferReply();

  const armory = await getFullArmory(name);
  if (!armory?.ArmoryProfile) {
    await interaction.editReply(`\`${name}\` — ${NOT_FOUND_HINT}`);
    return;
  }

  const { total, sources, conditional, bluntThorn } = analyzeCrit(armory);
  const lines = [
    `**총합: ${pct(total)}**`,
    '',
    ...groupedSourceLines(sources),
  ];
  const bluntLines = bluntThornLines(bluntThorn);
  if (bluntLines.length) lines.push('', ...bluntLines);

  // 조건부 노드 — 합계 줄과 같은 표기(계열 이름·풀스택 환산)를 유지하되 여기에만 싣는다.
  const conditionalLines = conditional.nodes.map((h) => {
    if (!h.additive) return ` •${h.source} ${h.detail}: ${trunc(h.clause, 60)}`;
    const suffix = h.stacks > 1 ? ` (${h.value}% ×${h.stacks}중첩)` : '';
    return ` •${h.source} ${h.detail}${suffix}: ${pct(h.totalValue)}`;
  });

  const extraLines = [
    ...conditional.identities.map((i) => ` •${i.label}: ${pct(i.crit)}`),
    ...conditionalLines,
    ...conditional.derived.map((d) => ` •${d.detail}: ${pct(d.value)}`),
    ...conditional.synergies.map((s) => ` •${s.detail} (치적 시너지): ${pct(s.value)}`),
    ...conditional.replacements.map((h) => ` •${h.detail}: ${trunc(h.clause, 60)}`),
    ...conditional.skills.map((h) => ` •${h.detail}: ${trunc(h.clause, 60)}`),
  ];
  if (extraLines.length > 0) {
    lines.push('', ' ※ 추가 치명타 확률 (위에 합산되지 않음)', ...extraLines);
  }

  const profile = armory.ArmoryProfile;
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`❙ ${profile.CharacterName}님의 치적 정보`)
    .setThumbnail(interaction.platform === 'kakao' ? null : profile.CharacterImage ?? null)
    .setDescription(
      `${profile.CharacterClassName} (${profile.ItemAvgLevel})\n\n${trunc(lines.join('\n'), 3900)}`,
    )
    .setFooter({ text: critFooter() });

  await interaction.editReply({ embeds: [embed] });
}
