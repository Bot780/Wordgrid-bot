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
ActionRowBuilder,        // ✅ ADDED
ButtonBuilder,           // ✅ ADDED
ButtonStyle,             // ✅ ADDED
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

// ─── Bot Client ───────────────────────────────────────────────────────────────

const client = new Client({
intents: [
GatewayIntentBits.Guilds,
GatewayIntentBits.GuildMessages,
GatewayIntentBits.MessageContent,
],
});

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (c) => {
console.log("✅ Logged in as ${c.user.tag}");
c.user.setActivity('Word Grid 🔤', { type: ActivityType.Playing });

const restored = loadPersistedSessions();
for (const { channelId, session } of restored) {
const elapsed = Date.now() - session.startTime;
const maxMs = 30 * 60 * 1000;

if (elapsed >= maxMs) {
  try {
    const result = endGame(channelId, false);
    if (!result || !session.channelId || !session.messageId) continue;

    const channel = await client.channels.fetch(session.channelId).catch(() => null);
    if (!channel) continue;

    const msg = await channel.messages.fetch(session.messageId).catch(() => null);

    if (msg) {
      await msg.edit({
        embeds: [buildGameEndEmbed(result, "⏰ Time's Up! (bot restarted)")],
        files: [buildGridAttachment(result.grid, result.words, result.placements, result.foundWords, result.hardMode)],
      }).catch(console.error);
    }

    await channel.send({ content: '⏰ The previous game expired while the bot was offline.' }).catch(() => {});
  } catch (err) {
    console.error('[Restore] Error ending expired session:', err.message);
  }
} else {
  attachTimers(channelId);
}

}
});

// ─── Interaction Handler ──────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {

// 🔥 BUTTON HANDLER (ADDED)
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

if (commandName === 'endgame') {
await interaction.deferReply();

if (!hasActiveGame(channelId)) {
  return interaction.editReply({ content: '❌ No active game in this channel.' });
}

const session = getSession(channelId);
const result = endGame(channelId, false);

const embed = buildGameEndEmbed(result, '⛔ Game Ended Early');

const attachment = buildGridAttachment(
  session.grid,
  session.words,
  session.placements,
  session.words,
  session.hardMode
);

// 🔥 BUTTON
const row = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setCustomId(`solution_${channelId}`)
    .setLabel('📖 View Solution')
    .setStyle(ButtonStyle.Primary)
);

await interaction.editReply({
  embeds: [embed],
  files: [attachment],
  components: [row]
});

}
});

// ─── Timers ───────────────────────────────────────────────────────────────────

function attachTimers(channelId) {

setEndTimer(channelId, async (cid) => {
const session = getSession(cid);
const endResult = endGame(cid, false);
if (!endResult || !session) return;

const channel = await client.channels.fetch(session.channelId).catch(() => null);
if (!channel) return;

const gameMessage = await channel.messages.fetch(session.messageId).catch(() => null);

if (gameMessage) {

  // 🔥 BUTTON
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`solution_${cid}`)
      .setLabel('📖 View Solution')
      .setStyle(ButtonStyle.Primary)
  );

  await gameMessage.edit({
    embeds: [buildGameEndEmbed(endResult, "⏰ Time's Up!")],
    files: [buildGridAttachment(
      endResult.grid,
      endResult.words,
      endResult.placements,
      endResult.foundWords,
      endResult.hardMode
    )],
    components: [row]
  }).catch(console.error);
}

});
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function buildGridAttachment(grid, words, placements, foundWords, hardMode) {
const buffer = generateGridImage(grid, words, placements, foundWords ?? [], hardMode);
return new AttachmentBuilder(buffer, { name: 'grid.png' });
}

function buildGameEndEmbed(result, title) {
return new EmbedBuilder()
.setTitle(title)
.setDescription(result.scoreboard);
}

// ─── Login ────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);
