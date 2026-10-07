import { SlashCommandBuilder } from 'discord.js';
import { showBoard } from './gem.js';

export const data = new SlashCommandBuilder()
  .setName('보석최저가')
  .setDescription('겁화·작열 10~7레벨 최저가와 전일 대비 시세판');

export const execute = showBoard;
