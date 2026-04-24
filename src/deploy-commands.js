require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('new')
    .setDescription('Start a new Word Grid puzzle (normal mode)'),

  new SlashCommandBuilder()
    .setName('newhard')
    .setDescription('Start a new Word Grid puzzle (hard mode — more words, all directions)'),

  new SlashCommandBuilder()
    .setName('hint')
    .setDescription('Request a hint for the current puzzle'),

  new SlashCommandBuilder()
    .setName('endgame')
    .setDescription('End the current game early'),

  new SlashCommandBuilder()
    .setName('score')
    .setDescription('View the current game scoreboard'),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('🔄 Registering slash commands...');

    if (process.env.GUILD_ID) {
      // Guild-specific (instant, good for dev)
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
      );
      console.log(`✅ Registered commands to guild ${process.env.GUILD_ID}`);
    } else {
      // Global (can take up to 1hr to propagate)
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands }
      );
      console.log('✅ Registered global slash commands (may take up to 1 hour to appear)');
    }
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }
})();
