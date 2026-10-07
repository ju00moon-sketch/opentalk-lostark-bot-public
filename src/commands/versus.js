import { SlashCommandBuilder } from 'discord.js';
import { compareVersus } from '../versus.js';
import { parseVersusInput, VERSUS_MAX_LENGTH, VERSUS_USAGE } from '../versus-input.js';

export const data = new SlashCommandBuilder()
  .setName('vs')
  .setDescription('둘 중 하나를 무작위로 고르고 짧은 유머 코멘트를 붙여드려요')
  .addStringOption((option) => option.setName('비교').setDescription('예: 노트북 vs 컴퓨터')
    .setRequired(true).setMaxLength(VERSUS_MAX_LENGTH));

export function createVersusExecute({ compare = compareVersus } = {}) {
  return async (interaction) => {
    const input = interaction.options.getString('비교') ?? '';
    if (!parseVersusInput(input)) {
      await interaction.reply({ content: VERSUS_USAGE, allowedMentions: { parse: [] } });
      return;
    }
    await interaction.deferReply();
    const result = await compare(input, interaction.user?.id);
    await interaction.editReply({ content: result.text, allowedMentions: { parse: [] }, kakaoNoPublicStore: true });
  };
}

export const execute = createVersusExecute();
