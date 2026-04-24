'use strict';
require('dotenv').config();

const express = require('express');
const app = express();
app.get('/', (_, res) => res.send('Bot alive'));
app.listen(process.env.PORT || 3000, () =>
console.log("🌐 Server running on port ${process.env.PORT || 3000}")
);

const {
Client,
GatewayIntentBits,
EmbedBuilder,
AttachmentBuilder,
Events,
ActivityType,
ActionRowBuilder,
ButtonBuilder,
ButtonStyle
} = require('discord.js');

const {
startGame,
processAnswer,
getHint,
getAutoHint,
endGame,
hasActiveGame,
getSession,
setEndTimer,
setHintTimer,
loadPersistedSessions,
} = require('./gameManager');

const {
getLocalLeaderboard,
getGlobalLeaderboard,
formatLeaderboard,
} = require('./leaderboard');

const { generateGridImage } = require('./gridRenderer');

// ─── Bot Client ─────────────────────────────────────────

const client = new Client({
intents: [
GatewayIntentBits.Guilds,
GatewayIntentBits.GuildMessages,
GatewayIntentBits.MessageContent,
],
});

// ─── Ready ──────────────────────────────────────────────

client.once(Events.ClientReady, async (c) => {
console.log("✅ Logged in as ${c.user.tag}");
c.user.setActivity('Word Grid 🔤', { type: ActivityType.Playing });

const restored = loadPersistedSessions();
for (const { channelId } of restored) {
attachTimers(channelId);
}
});

// ─── Interaction Handler ─────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {

// 🔥 BUTTON HANDLER
if (interaction.isButton()) {
if (interaction.customId.startsWith('solution_')) {
const channelId = interaction.customId.split('_')[1];
const session = getSession(channelId);

  if (!session) {
    return interaction.reply({
      content: '❌ Solution expired.',
      ephemeral: true
    });
  }

  const attachment = buildGridAttachment(
    session.grid,
    session.words,
    session.placements,
    session.words,
    session.hardMode
  );

  return interaction.reply({
    content: '📖 Full solution:',
    files: [attachment],
    ephemeral: true
  });
}

}

if (!interaction.isChatInputCommand()) return;

const { commandName, channelId, guildId } = interaction;

// ── NEW ──
if (commandName === 'new') {
return handleStartGame(interaction, false);
}

if (commandName === 'newhard') {
return handleStartGame(interaction, true);
}

// ── HINT ──
if (commandName === 'hint') {
await interaction.deferReply({ ephemeral: true });

if (!hasActiveGame(channelId)) {
  return interaction.editReply({ content: '❌ No active game.' });
}

const hintData = getHint(channelId);
if (!hintData) {
  return interaction.editReply({ content: '🎉 All words found!' });
}

const embed = new EmbedBuilder()
  .setColor(0xF0A500)
  .setTitle('💡 Hint!')
  .setDescription(`\`${hintData.hint}\`\n${hintData.remaining} left`);

return interaction.editReply({ embeds: [embed] });

}

// ── ENDGAME ──
if (commandName === 'endgame') {
await interaction.deferReply();

if (!hasActiveGame(channelId)) {
  return interaction.editReply({ content: '❌ No active game.' });
}

const session = getSession(channelId);
if (!session) {
  return interaction.editReply({ content: '❌ Session missing.' });
}

let result;
try {
  result = endGame(channelId, false);
} catch (err) {
  console.error(err);
  return interaction.editReply({ content: '❌ Failed to end game.' });
}

const embed = buildGameEndEmbed(result, '⛔ Game Ended Early');

const attachment = buildGridAttachment(
  session.grid,
  session.words,
  session.placements,
  session.words,
  session.hardMode
);

const row = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setCustomId(`solution_${channelId}`)
    .setLabel('📖 View Solution')
    .setStyle(ButtonStyle.Primary)
);

return interaction.editReply({
  embeds: [embed],
  files: [attachment],
  components: [row]
});

}

// ── SCORE ──
if (commandName === 'score') {
await interaction.deferReply({ ephemeral: true });

if (!hasActiveGame(channelId)) {
  return interaction.editReply({ content: '❌ No active game.' });
}

const session = getSession(channelId);

const embed = new EmbedBuilder()
  .setTitle('📊 Score')
  .setDescription(buildSessionScoreboard(session));

const attachment = buildGridAttachment(
  session.grid,
  session.words,
  session.placements,
  session.foundWords,
  session.hardMode
);

return interaction.editReply({ embeds: [embed], files: [attachment] });

}
});

// ─── Start Game ─────────────────────────────────────────

async function handleStartGame(interaction, hardMode) {
await interaction.deferReply();

const { channelId, guildId } = interaction;
const result = startGame(channelId, guildId, hardMode);

if (result.error) {
return interaction.editReply({ content: result.error });
}

const { session } = result;

const attachment = buildGridAttachment(
session.grid,
session.words,
session.placements,
[],
hardMode
);

const embed = new EmbedBuilder()
.setTitle('🔤 Word Grid')
.setDescription("Find ${session.words.length} words!")
.setImage('attachment://grid.png');

const reply = await interaction.editReply({
embeds: [embed],
files: [attachment]
});

session.messageId = reply.id;
session.channelId = channelId;

attachTimers(channelId);
}

// ─── Timers ─────────────────────────────────────────────

function attachTimers(channelId) {
setEndTimer(channelId, async (cid) => {
const session = getSession(cid);
const result = endGame(cid, false);
if (!session || !result) return;

const channel = await client.channels.fetch(session.channelId).catch(() => null);
if (!channel) return;

const msg = await channel.messages.fetch(session.messageId).catch(() => null);
if (!msg) return;

const row = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setCustomId(`solution_${cid}`)
    .setLabel('📖 View Solution')
    .setStyle(ButtonStyle.Primary)
);

await msg.edit({
  embeds: [buildGameEndEmbed(result, "⏰ Time's Up!")],
  files: [buildGridAttachment(
    result.grid,
    result.words,
    result.placements,
    result.foundWords,
    result.hardMode
  )],
  components: [row]
});

});
}

// ─── Helpers ────────────────────────────────────────────

function buildGridAttachment(grid, words, placements, foundWords, hardMode) {
const buffer = generateGridImage(grid, words, placements, foundWords ?? [], hardMode);
return new AttachmentBuilder(buffer, { name: 'grid.png' });
}

function buildGameEndEmbed(result, title) {
return new EmbedBuilder()
.setTitle(title)
.setDescription(result.scoreboard);
}

function buildSessionScoreboard(session) {
return Object.values(session.scores || {})
.map(s => "${s.username}: ${s.points}")
.join('\n') || 'No scores';
}

// ─── Safety ─────────────────────────────────────────────

process.on('unhandledRejection', console.error);
client.on('error', console.error);

// ─── Login ──────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);
