'use strict';
require('dotenv').config();

const express = require('express');
const app = express();
app.get('/', (_, res) => res.send('Bot alive'));
app.listen(process.env.PORT || 3000, () => {
  console.log(`🌐 Server running on port ${process.env.PORT || 3000}`);
});

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
console.log(`✅ Logged in as ${c.user.tag}`);
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

    console.log("🔍 Fetching solution for", channelId);

    const solution = global.solutions?.[channelId];

    if (!solution) {
      console.log("❌ No solution found");
      return interaction.reply({
        content: '❌ Solution expired.',
        ephemeral: true
      });
    }

    console.log("✅ Solution found");

    const attachment = buildGridAttachment(
      solution.grid,
      solution.words,
      solution.placements,
      solution.words,
      solution.hardMode
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
await interaction.deferReply();

if (!hasActiveGame(channelId)) {
  return interaction.editReply({ content: '❌ No active game.' });
}

const hintData = getHint(channelId);
if (!hintData) {
  return interaction.editReply({ content: '🎉 All words found!' });
}

const embed = new EmbedBuilder()
  .setColor(0xF0A500) // yellow/orange like screenshot

  .setTitle('💡 Hint!')

  .setDescription(
    `One of the remaining words: **\`${hintData.hint}\`**\n\n` +
    `*${hintData.remaining} word(s) remaining*\n\n` +
    `Hints are also auto-given after 10 min of inactivity`
  );

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

  // ✅ SAVE SOLUTION BEFORE END
  global.solutions = global.solutions || {};
  global.solutions[channelId] = {
    grid: session.grid,
    words: session.words,
    placements: session.placements,
    hardMode: session.hardMode
  };

  let result;
  try {
    result = endGame(channelId, false);
  } catch (err) {
    console.error(err);
    return interaction.editReply({ content: '❌ Failed to end game.' });
  }

  // ✅ Embed builder
  const embed = new EmbedBuilder()
    .setColor(result.allFound ? 0x57F287 : 0xED4245)
    .setTitle("⛔ Game Ended Early")
    .setDescription(
      `✅ **Words Found**\n` +
      `${result.foundWords.length
        ? result.foundWords.map(w => `\`${w}\``).join(', ')
        : '*None*'}\n\n` +

      `❌ **Missed Words**\n` +
      `${result.unfoundWords.length
        ? result.unfoundWords.map(w => `\`${w}\``).join(', ')
        : '*All found!*'}\n\n` +

      `🏆 **Final Scoreboard**\n` +
      `${result.scoreboard || '*No scores yet!*'}\n\n` +

      `⏱ **Duration**\n` +
      `${Math.floor(result.duration / 60)}m ${result.duration % 60}s`
    )
    .setFooter({
      text: 'Start a new game with /new or /newhard!'
    })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`solution_${channelId}`)
      .setLabel('📖 View Solution')
      .setStyle(ButtonStyle.Primary)
  );

  // ✅ send NEW message (not edit)
  const channel = await interaction.client.channels.fetch(channelId);

await channel.send({
  embeds: [embed],
  components: [row]
});

// ✅ VERY IMPORTANT (this fixes 10062)
return interaction.editReply({
  content: '✅ Game ended.'
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
  .setColor(hardMode ? 0xED4245 : 0x57F287)

  // 🧠 Title (clean + modern)
  .setTitle(`🔤 Word Grid — ${hardMode ? '🔴 Hard Mode' : '🟢 Normal Mode'}`)

  // 📝 Main description (structured like your screenshot)
  .setDescription(
    `Find **${session.words.length} hidden words** in the grid!\n` +
    `${hardMode 
      ? 'Words hidden in **all 8 directions** (↕ ↔ ↘ ↗)' 
      : 'Words hidden **right, down, and diagonally (↘)**'
    }\n\n` +
    `**Just type your answer in this channel to submit!**`
  )

  // 🔥 Sections like your screenshot
  .addFields(
    {
      name: '⏱ Time Limit',
      value: '30 minutes',
      inline: true,
    },
    {
      name: '💡 Hint',
      value: 'Available ✅ (1 per game)',
      inline: true,
    },
    {
      name: '🏆 Points',
      value: '3-letter: **2pts** • 4-letter: **3pts** • 5+ letters: **5pts**',
      inline: false,
    }
  )

  // 🖼 Grid image
  .setImage('attachment://grid.png')

  // ✨ Footer (clean like UI)
  .setFooter({
    text: 'Use /score to check progress • /endgame to end early',
  })

  .setTimestamp();

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
if (!session) return;

// ✅ SAVE SOLUTION BEFORE ENDING
global.solutions = global.solutions || {};
global.solutions[cid] = {
  grid: session.grid,
  words: session.words,
  placements: session.placements,
  hardMode: session.hardMode
};

const result = endGame(cid, false);
if (!result) return;

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
  components: [row]
});

});
}
}); // ✅ CLOSE interaction handler
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
.map(s => `${s.username}: ${s.points}`)
.join('\n') || 'No scores';
}

// ─── Safety ─────────────────────────────────────────────

process.on('unhandledRejection', console.error);
client.on('error', console.error);

// ─── Login ──────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);
