import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getArmoryPart } from '../lostark.js';
import { getBraceletEfficiency } from '../lopec.js';
import { getBanglePercent } from '../lopec-sim.js';
import { trunc, EMBED_COLOR, NOT_FOUND_HINT } from '../format.js';
import { resolveCharacter, NO_CHARACTER_HINT } from '../user-store.js';
import { parseTooltip, parseBracelet, findStoneEngravings } from '../tooltip.js';
import { TITLE, NOTE, row, section, blocks } from '../kakao/layout.js';
import { parseBraceletShortcut } from '../bracelet-search.js';
import { execute as searchBracelet } from './bracelet-search.js';
import { getSiteEfficiency, getSiteValuation, followSiteValuation, expectationText, DEVELOPMENT_NOTE } from '../site-valuation.js';

export const data = new SlashCommandBuilder()
  .setName('팔찌')
  .setDescription('스톤·팔찌 정보 또는 특성 2개와 최소값으로 부여 3줄 팔찌 경매장 검색')
  .addStringOption((option) =>
    option.setName('닉네임').setDescription('캐릭터 닉네임 또는 치특 90 90 (부여 3줄 검색, 비우면 등록 캐릭터)'),
  );

export const SEARCH_USAGE = '사용법: .팔찌 치특 90 90 — 치명 90 이상·특화 90 이상, 부여 효과 3줄 팔찌 검색 (예: .팔찌 특신 100 90)';

export function createExecute({ character = createShowCharacter(), search = searchBracelet } = {}) {
  return async function execute(interaction) {
    const query = parseBraceletShortcut(interaction.options.getString('닉네임'));
    if (query === undefined) return character(interaction);
    return search(interaction, { query, usage: SEARCH_USAGE });
  };
}

export const execute = createExecute();

// 스톤 각인은 첫 글자로 줄여 쓴다 — 돌격대장 Lv.3 · 아드레날린 Lv.2 → "돌3 아2"
const stoneSummary = (engravings) =>
  engravings
    .filter((e) => !e.negative && e.level > 0)
    .map((e) => `${e.name[0]}${e.level}`)
    .join(' ');

// 머리줄(head)과 내용(body)을 나눠 둔다 — 디스코드는 "✤ 머리줄", 카카오는 "▸ 항목" 아래에 붙인다.
function stoneParts(stone) {
  if (!stone) return { head: '어빌리티 스톤 없음', body: [] };
  const engravings = findStoneEngravings(parseTooltip(stone.Tooltip));
  const summary = stoneSummary(engravings);
  const minus = engravings.find((e) => e.negative && e.level > 0);
  return {
    head: `${stone.Grade} ${stone.Name}`,
    body: [summary || null, minus ? `(${minus.name} ${minus.level})` : null].filter(Boolean),
  };
}

function braceletParts(bracelet) {
  if (!bracelet) return { head: '팔찌 없음', body: [] };
  const { stats, effects } = parseBracelet(parseTooltip(bracelet.Tooltip));
  return {
    head: `${bracelet.Grade} 팔찌`,
    body: [...stats.map((s) => `[${s.name}] ${s.value}`), ...effects.map((e) => `• ${e}`)],
  };
}

const discordBlock = ({ head, body }) => [`✤ ${head}`, ...body].join('\n');

// 효율 수치의 출처에 따른 주의 문구 — 두 화면에서 같은 문장을 쓴다.
const EFFICIENCY_NOTES = {
  site: '포근해용 계산 기준 · 현재 장착한 팔찌로 계산했어요.',
  badge: '로펙 갱신 기준이라 현재 착용 팔찌와 다를 수 있습니다.',
  table: '로펙 효율표 값이에요. 캐릭터 페이지 배지와는 계산식이 다를 수 있습니다.',
};
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

// 조회 함수는 주입할 수 있다 — 테스트는 공식 API·로펙·사이트 계산 없이 출력만 확인한다.
export function createShowCharacter({ armory = getArmoryPart, siteEfficiency = getSiteEfficiency, banglePercent = getBanglePercent,
  braceletEfficiency = getBraceletEfficiency, siteValuation = getSiteValuation, followValuation = followSiteValuation } = {}) {
  return async function showCharacter(interaction) {
  const name = resolveCharacter(interaction);
  if (!name) {
    await interaction.reply(NO_CHARACTER_HINT);
    return;
  }
  await interaction.deferReply();

  const equipment = await armory(name, 'equipment');
  if (!equipment || equipment.length === 0) {
    await interaction.editReply(`\`${name}\` — ${NOT_FOUND_HINT}`);
    return;
  }

  const stone = equipment.find((e) => e.Type === '어빌리티 스톤');
  const bracelet = equipment.find((e) => e.Type === '팔찌');
  if (!stone && !bracelet) {
    await interaction.editReply(`\`${name}\` — 장착한 어빌리티 스톤과 팔찌가 없어요.`);
    return;
  }

  // 미착용이면 로펙에 남아 있는 이전 팔찌 효율도 조회하지 않는다.
  // 캐릭터 페이지 계산값이 없을 때만 효율표 값으로 물러난다.
  // 효율과 뽑기 기댓값은 사이트(캐릭터 화면)와 같은 계산을 먼저 쓰고, 계산되지 않을 때만 로펙 배지 → 효율표로 물러난다.
  const [site, valuation] = bracelet ? await Promise.all([siteEfficiency(name), siteValuation(name)]) : [null, null];
  let efficiency = site?.bracelet?.status === 'ok' && finite(site.bracelet.efficiency) ? site.bracelet.efficiency : null;
  let source = efficiency === null ? null : 'site';
  if (bracelet && efficiency === null) {
    const badge = await banglePercent(name);
    efficiency = badge ?? (await braceletEfficiency(name));
    source = efficiency === null ? null : badge !== null ? 'badge' : 'table';
  }
  const efficiencyText = efficiency === null ? '조회할 수 없어요' : `${efficiency.toFixed(2)}%`;

  const stoneInfo = stoneParts(stone);
  const braceletInfo = braceletParts(bracelet);
  const note = source ? EFFICIENCY_NOTES[source] : null;

  // 카카오톡: 핵심 수치(팔찌 효율)를 맨 위로 올리고 스톤·팔찌를 항목으로 나눈 뒤, 주의 문구는 맨 아래에 그대로 둔다.
  if (interaction.platform === 'kakao') {
    await interaction.editReply({
      content: blocks(
        TITLE(`${name} · 스톤 & 팔찌`),
        bracelet ? [row('팔찌 효율', efficiencyText), row('팔찌 기댓값', expectationText(valuation, 'bracelet'))].join('\n') : null,
        section('어빌리티 스톤', [stoneInfo.head, ...stoneInfo.body]),
        section('팔찌', [braceletInfo.head, ...braceletInfo.body]),
        note ? NOTE(note) : null,
        bracelet ? NOTE(DEVELOPMENT_NOTE) : null,
      ),
    });
    return;
  }

  // The same embed is rendered again when the site finishes the expected value.
  const render = (value, live) => {
    const expectedText = expectationText(value, 'bracelet', { live });
    const sections = [discordBlock(stoneInfo), discordBlock(braceletInfo)];
    if (bracelet) {
      sections.push(
        [
          '❙ 팔찌 효율',
          `  팔찌 효율: ${efficiency === null ? efficiencyText : `**${efficiencyText}**`}`,
          `  팔찌 기댓값: ${value?.bracelet?.gold == null ? expectedText : `**${expectedText}**`}`,
          note ? `  ※ ${note}` : null,
          `  ※ ${DEVELOPMENT_NOTE}`,
        ].filter(Boolean).join('\n'),
      );
    }
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`${name}님의 스톤 & 팔찌 정보`)
      .setDescription(trunc(sections.join('\n\n'), 4096))
      .setThumbnail(bracelet?.Icon ?? stone?.Icon ?? null);
    return { embeds: [embed] };
  };
  const pending = bracelet && valuation?.status === 'running';
  await interaction.editReply(render(valuation, pending));
  // Discord messages can be edited later: keep asking the site and replace the row once the value exists.
  if (pending) void followValuation(name).then((value) => interaction.editReply(render(value, false))).catch(() => {});
  };
}
