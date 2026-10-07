import { SlashCommandBuilder } from 'discord.js';
import { parseGemSearch } from '../gem-search.js';
import { showSingleGem } from './gem.js';

export const data = new SlashCommandBuilder()
  .setName('경매장')
  .setDescription('겁화·작열 보석의 경매장 최저가 검색 (예: 10겁, 10작)')
  .addStringOption((option) => option
    .setName('검색어')
    .setDescription('1~10레벨 겁화·작열 (예: 10겁, 9작, 겁화 10)')
    .setRequired(true));

export async function execute(interaction) {
  const gem = parseGemSearch(interaction.options.getString('검색어'));
  if (!gem) {
    await interaction.reply('겁화·작열 보석의 레벨(1~10)을 함께 적어 주세요. 예: /경매장 10겁 · /경매장 9작');
    return;
  }
  return showSingleGem(interaction, gem.종류, gem.레벨);
}
