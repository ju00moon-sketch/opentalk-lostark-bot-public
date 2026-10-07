import { SlashCommandBuilder } from 'discord.js';
import { formatArkgridRoster, getArkgridRoster, splitArkgridReport } from '../arkgrid-roster.js';
import { NO_CHARACTER_HINT, resolveCharacter } from '../user-store.js';

export const data = new SlashCommandBuilder()
  .setName('앜그현황')
  .setDescription('같은 서버 원정대의 아크그리드 코어와 포인트를 모아 봅니다.')
  .addStringOption((option) => option.setName('닉네임').setDescription('캐릭터 닉네임 (등록했다면 생략 가능)'));

export function createExecute({ getRoster = getArkgridRoster } = {}) {
  return async function execute(interaction) {
    const name = resolveCharacter(interaction);
    if (!name) return interaction.reply({ content: NO_CHARACTER_HINT, flags: 64 });
    await interaction.deferReply();
    const text = formatArkgridRoster(await getRoster(name));
    if (interaction.platform === 'kakao') {
      return interaction.editReply({ content: text, kakaoBridgeText: text, kakaoPreserveWhitespace: true });
    }
    const chunks = splitArkgridReport(text);
    await interaction.editReply({ content: chunks[0], allowedMentions: { parse: [] } });
    for (const content of chunks.slice(1)) {
      const payload = { content, allowedMentions: { parse: [] } };
      if (typeof interaction.followUp === 'function') await interaction.followUp(payload);
      else await interaction.editReply(payload);
    }
  };
}

export const execute = createExecute();
