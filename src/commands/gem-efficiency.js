import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getLopecScore } from '../lopec.js';
import { getArkgridEfficiency } from '../lopec-sim.js';
import { trunc, EMBED_COLOR } from '../format.js';
import { resolveCharacter, NO_CHARACTER_HINT } from '../user-store.js';
import { getSiteEfficiency, getSiteValuation, followSiteValuation, expectationText, DEVELOPMENT_NOTE } from '../site-valuation.js';

export const data = new SlashCommandBuilder()
  .setName('젬효율')
  .setDescription('아크 그리드 젬 효율과 젬 뽑기 기댓값')
  .addStringOption((option) =>
    option.setName('닉네임').setDescription('캐릭터 닉네임 (비우면 /등록한 내 캐릭터)'),
  );

const pct = (n) => `${Number(n).toFixed(2)}%`;

// 서포터도 사이트 계산(지원 점수 기준)으로 값이 나온다. 조회 실패나 아크 그리드 젬이 없을 때만 이 안내를 쓴다.
const NOT_AVAILABLE =
  '젬 효율을 계산하지 못했어요. 조회되지 않는 캐릭터거나 아크 그리드 젬이 없으면 나오지 않아요.';

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

// 조회 함수는 주입할 수 있다 — 테스트는 공식 API·사이트 계산 없이 출력만 확인한다.
export function createExecute({ siteEfficiency = getSiteEfficiency, siteValuation = getSiteValuation,
  arkgridEfficiency = getArkgridEfficiency, lopecScore = getLopecScore, followValuation = followSiteValuation } = {}) {
  return async function execute(interaction) {
  const name = resolveCharacter(interaction);
  if (!name) {
    await interaction.reply(NO_CHARACTER_HINT);
    return;
  }
  await interaction.deferReply();

  // 사이트(캐릭터 화면)와 같은 계산을 먼저 쓰고, 계산되지 않을 때만 효율표 값으로 물러난다.
  const [site, valuation, score] = await Promise.all([siteEfficiency(name), siteValuation(name), lopecScore(name)]);
  const fromSite = site?.gem?.status === 'ok' && finite(site.gem.efficiency);
  const gem = fromSite ? site.gem : await arkgridEfficiency(name);
  if (!gem || !finite(gem.efficiency)) {
    await interaction.editReply(`\`${name}\` — ${NOT_AVAILABLE}`);
    return;
  }

  const header = [`젬 효율 **${pct(gem.efficiency)}**`];
  if (finite(gem.optionEfficiency) && finite(gem.pointEfficiency)) {
    header.push(`└ 옵션 ${pct(gem.optionEfficiency)} · 포인트 ${pct(gem.pointEfficiency)}`);
  }
  if (score?.gemMedian) {
    const diff = gem.efficiency - score.gemMedian;
    header.push(`└ 레벨 중앙값 ${pct(score.gemMedian)} 대비 **${diff >= 0 ? '+' : '-'}${pct(Math.abs(diff))}**`);
  }
  // 실효율 0%는 그 캐릭터가 안 쓰는 옵션이라는 뜻이라 뒤로 밀어 둔다.
  const effects = [...(gem.effectEfficiencies ?? [])].sort(
    (a, b) => (b.efficiency ?? 0) - (a.efficiency ?? 0),
  );
  // The same embed is rendered again when the site finishes the expected value.
  const render = (value, live) => {
    const expectedText = expectationText(value, 'gems', { live });
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`💎 ${score?.name ?? name} — 아크 그리드 젬 효율`)
      .setDescription([...header, `젬 기댓값 ${value?.gems?.gold == null ? expectedText : `**${expectedText}**`}`].join('\n'));
    if (effects.length > 0) {
      const lines = effects.map(
        (e) => `**${e.name}** Lv.${e.level} — 효과 ${pct(e.effect)} · 실효율 **${pct(e.efficiency)}**`,
      );
      embed.addFields({ name: '옵션별 실효율', value: trunc(lines.join('\n')) });
    }
    embed.setFooter({ text: `${fromSite ? '포근해용 계산 기준' : '효율표 기준'} · 실효율 0%는 이 직업이 쓰지 않는 옵션이에요 · ${DEVELOPMENT_NOTE}` });
    return { embeds: [embed] };
  };
  const pending = valuation?.status === 'running' && interaction.platform !== 'kakao';
  await interaction.editReply(render(valuation, pending));
  // Discord messages can be edited later: keep asking the site and replace the row once the value exists.
  if (pending) void followValuation(name).then((value) => interaction.editReply(render(value, false))).catch(() => {});
  };
}

export const execute = createExecute();
