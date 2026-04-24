//uuii

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
  ButtonStyle,
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

// ─── Solution Store ───────────────────────────────────────────────────────────
// Stores a snapshot of each game's grid/words/placements so the "View Solution"
// button works even after the session has been deleted.
// Falls back to the live session if a snapshot isn't found (e.g. mid-game /score).

const solutionStore = new Map();

function saveSolution(channelId, session) {
  solutionStore.set(channelId, {
    grid:       session.grid,
    words:      session.words,
    placements: session.placements,
    hardMode:   session.hardMode,
    isLight:    session.isLight,
    foundWords: [...session.foundWords],
  });
}

function getSolution(channelId) {
  if (solutionStore.has(channelId)) return solutionStore.get(channelId);
  // Fallback: live session (button pressed before game ends)
  const live = getSession(channelId);
  return live || null;
}

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
  console.log(`✅ Logged in as ${c.user.tag}`);
  c.user.setActivity('Word Grid 🔤', { type: ActivityType.Playing });

  // Restore sessions that survived a restart and re-attach their timers
  const restored = loadPersistedSessions();
  for (const { channelId } of restored) {
    attachTimers(channelId);
  }
});

// ─── Interaction Handler ──────────────────────────────────────────────────────
//
// ⚠️  MessageCreate is registered SEPARATELY below at the top level.
//     Do NOT nest it inside this handler — doing so means it only fires
//     while an interaction is being processed (i.e. almost never).

client.on(Events.InteractionCreate, async (interaction) => {

  // ── Button: View Solution ──────────────────────────────────────────────────
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('solution_')) {
      const channelId = interaction.customId.split('_')[1];
      const solution  = getSolution(channelId);

      if (!solution) {
        return interaction.reply({
          content:   '❌ Solution data not found.',
          ephemeral: true,
        });
      }

      await interaction.deferReply({ ephemeral: true });

      // Show ALL words highlighted in the solution image
      const attachment = buildGridAttachment(
        solution.grid,
        solution.words,
        solution.placements,
        solution.words,      // pass all words as "found" → highlights every word
        solution.hardMode,
        solution.isLight,
      );

      return interaction.editReply({
        content: '📖 Full solution:',
        files:   [attachment],
      });
    }
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName, channelId, guildId } = interaction;

  // ── /new ──────────────────────────────────────────────────────────────────
  if (commandName === 'new') {
    return handleStartGame(interaction, false);
  }

  // ── /newhard ──────────────────────────────────────────────────────────────
  if (commandName === 'newhard') {
    return handleStartGame(interaction, true);
  }

  // ── /hint ─────────────────────────────────────────────────────────────────
  if (commandName === 'hint') {
    await interaction.deferReply();

    if (!hasActiveGame(channelId)) {
      return interaction.editReply({ content: '❌ No active game.' });
    }

    const hintData = getHint(channelId);

    if (!hintData) {
      return interaction.editReply({ content: '🎉 All words found!' });
    }
    if (hintData.error) {
      return interaction.editReply({ content: `❌ ${hintData.error}` });
    }

    const embed = new EmbedBuilder()
      .setColor(0xF0A500)
      .setTitle('💡 Hint!')
      .setDescription(
        `One of the remaining words: **\`${hintData.hint}\`**\n\n` +
        `*${hintData.remaining} word(s) remaining*\n\n` +
        `Hints are also auto-given after 10 min of inactivity`
      );

    return interaction.editReply({ embeds: [embed] });
  }

  // ── /endgame ──────────────────────────────────────────────────────────────
  if (commandName === 'endgame') {
    await interaction.deferReply();

    if (!hasActiveGame(channelId)) {
      return interaction.editReply({ content: '❌ No active game.' });
    }

    const session = getSession(channelId);
    if (!session) {
      return interaction.editReply({ content: '❌ Session missing.' });
    }

    // ✅ Snapshot BEFORE endGame() deletes the session
    saveSolution(channelId, session);

    let result;
    try {
      result = endGame(channelId, false);
    } catch (err) {
      console.error('[/endgame]', err);
      return interaction.editReply({ content: '❌ Failed to end game.' });
    }

    if (!result) {
      return interaction.editReply({ content: '❌ Game already ended.' });
    }

    const embed = buildGameEndEmbed(result, '⛔ Game Ended Early');

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`solution_${channelId}`)
        .setLabel('📖 View Solution')
        .setStyle(ButtonStyle.Primary)
    );

    // Send the summary as a new message in the channel
    const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
    if (channel) {
      await channel.send({ embeds: [embed], components: [row] }).catch(console.error);
    }

    // Acknowledge the slash command (required — avoids "interaction failed")
    return interaction.editReply({ content: '✅ Game ended.' });
  }

  // ── /score ────────────────────────────────────────────────────────────────
  if (commandName === 'score') {
    await interaction.deferReply({ ephemeral: true });

    if (!hasActiveGame(channelId)) {
      return interaction.editReply({ content: '❌ No active game.' });
    }

    const session = getSession(channelId);

    const embed = new EmbedBuilder()
      .setTitle('📊 Current Scores')
      .setDescription(buildSessionScoreboard(session));

    const attachment = buildGridAttachment(
      session.grid,
      session.words,
      session.placements,
      session.foundWords,
      session.hardMode,
      session.isLight,
    );

    return interaction.editReply({ embeds: [embed], files: [attachment] });
  }

}); // ─── END InteractionCreate ────────────────────────────────────────────────

// ─── Message Handler ──────────────────────────────────────────────────────────
//
// CRITICAL FIX: Registered at the TOP LEVEL — NOT nested inside InteractionCreate.
//
// The original code had this handler inside the InteractionCreate callback, which
// meant it was only registered (and thus only fired) while an interaction was being
// actively processed. Moving it here makes it a persistent, always-active listener.

client.on(Events.MessageCreate, async (message) => {
  // Ignore bots and DM messages
  if (message.author.bot) return;
  if (!message.guild)     return;

  const channelId = message.channel.id;

  // No game active in this channel — skip
  if (!hasActiveGame(channelId)) return;

  // Only consider single-word messages (avoids reacting to every chat sentence)
  const raw   = message.content.trim();
  const guess = raw.toUpperCase();
  if (!guess || guess.includes(' ')) return;

  const result = processAnswer(
    channelId,
    message.author.id,
    message.author.username,
    guess,
  );

  // No session or other early-return from processAnswer
  if (!result) return;

  // ♻️ Already found — react and exit
  if (result.alreadyFound) {
    await message.react('♻️').catch(() => {});
    return;
  }

  // ❌ Wrong guess — ignore silently (no reaction)
  if (!result.correct) return;

  // ✅ Correct new word
  await message.react('✅').catch(() => {});

  const scoreboard = result.scoreboard || '*No scores yet!*';

  const correctEmbed = new EmbedBuilder()
    .setColor(0x57F287)
    .setDescription(
      `✅ **${result.word}** found by **${message.author.username}**\n` +
      `+${result.points} pts • ${result.remaining} word${result.remaining !== 1 ? 's' : ''} left`
    )
    .addFields({ name: '🏆 Scoreboard', value: scoreboard });

  await message.channel.send({ embeds: [correctEmbed] }).catch(() => {});

  // 🎉 All words found
  if (result.completed) {
    // Save solution snapshot (result carries everything we need)
    solutionStore.set(channelId, {
      grid:       result.grid,
      words:      result.words,
      placements: result.placements,
      hardMode:   result.hardMode,
      isLight:    result.isLight,
      foundWords: result.foundWords,
    });

    // End the game (processAnswer does NOT call endGame — we do it here)
    endGame(channelId, true);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`solution_${channelId}`)
        .setLabel('📖 View Solution')
        .setStyle(ButtonStyle.Primary)
    );

    const completionEmbed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle('🎉 All Words Found!')
      .setDescription(
        `**Every hidden word has been discovered!**\n\n` +
        `🏆 **Final Scoreboard**\n${scoreboard}`
      )
      .setTimestamp();

    await message.channel.send({
      embeds:     [completionEmbed],
      components: [row],
    }).catch(() => {});
  }
});

// ─── Start Game ───────────────────────────────────────────────────────────────

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
    [],            // no words found yet
    hardMode,
    session.isLight,
  );

  const embed = new EmbedBuilder()
    .setColor(hardMode ? 0xED4245 : 0x57F287)
    .setTitle(`🔤 Word Grid — ${hardMode ? '🔴 Hard Mode' : '🟢 Normal Mode'}`)
    .setDescription(
      `Find **${session.words.length} hidden words** in the grid!\n` +
      `${hardMode
        ? 'Words hidden in **all 8 directions** (↕ ↔ ↘ ↗)'
        : 'Words hidden **right, down, and diagonally (↘)**'
      }\n\n` +
      `**Just type your answer in this channel to submit!**`
    )
    .addFields(
      { name: '⏱ Time Limit', value: '30 minutes',                                               inline: true },
      { name: '💡 Hint',       value: 'Available ✅ (1 per game)',                                 inline: true },
      { name: '🏆 Points',     value: '3-letter: **2pts** • 4-letter: **3pts** • 5+ letters: **5pts**', inline: false },
    )
    .setImage('attachment://grid.png')
    .setFooter({ text: 'Use /score to check progress • /hint for a clue • /endgame to end early' })
    .setTimestamp();

  const reply = await interaction.editReply({ embeds: [embed], files: [attachment] });

  // Store the message ID so the end-timer can edit it later
  session.messageId = reply.id;
  session.channelId = channelId;

  attachTimers(channelId);
}

// ─── Timers ───────────────────────────────────────────────────────────────────

function attachTimers(channelId) {

  // ── End timer: fires once after 30 minutes ─────────────────────────────────
  setEndTimer(channelId, async (cid) => {
    const session = getSession(cid);
    if (!session) return;

    // Snapshot before ending
    saveSolution(cid, session);

    const result = endGame(cid, false);
    if (!result) return;

    const channel = await client.channels.fetch(session.channelId).catch(() => null);
    if (!channel) return;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`solution_${cid}`)
        .setLabel('📖 View Solution')
        .setStyle(ButtonStyle.Primary)
    );

    const timeUpEmbed = buildGameEndEmbed(result, "⏰ Time's Up!");

    // Try to edit the original game message; fall back to a new message
    if (session.messageId) {
      const msg = await channel.messages.fetch(session.messageId).catch(() => null);
      if (msg) {
        await msg.edit({ embeds: [timeUpEmbed], components: [row] }).catch(() => {});
        return;
      }
    }

    await channel.send({ embeds: [timeUpEmbed], components: [row] }).catch(() => {});
  });

  // ── Hint timer: checks every 60s, fires after 10 min of inactivity ─────────
  //
  // FIX: This call was MISSING from the original attachTimers() — auto-hints
  // never fired because setHintTimer was never called.
  setHintTimer(channelId, async (cid) => {
    const hint = getAutoHint(cid);
    if (!hint) return;

    const session = getSession(cid);
    if (!session) return;

    const channel = await client.channels.fetch(session.channelId).catch(() => null);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(0xF0A500)
      .setTitle('💡 Auto Hint — No activity for 10 minutes')
      .setDescription(
        `Here's a free clue: **\`${hint.hint}\`**\n` +
        `*${hint.remaining} word${hint.remaining !== 1 ? 's' : ''} still remaining*`
      );

    await channel.send({ embeds: [embed] }).catch(() => {});
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds an AttachmentBuilder from a grid image.
 * isLight is passed through so the image uses the session's decided theme.
 */
function buildGridAttachment(grid, words, placements, foundWords, hardMode, isLight) {
  const buffer = generateGridImage(
    grid,
    words,
    placements,
    foundWords ?? [],
    hardMode,
    isLight,          // ← per-game theme (null = random, which is the safe fallback)
  );
  return new AttachmentBuilder(buffer, { name: 'grid.png' });
}

/**
 * Builds a styled embed for game-end scenarios (time up, /endgame).
 */
function buildGameEndEmbed(result, title) {
  return new EmbedBuilder()
    .setColor(result.allFound ? 0x57F287 : 0xED4245)
    .setTitle(title)
    .setDescription(
      `✅ **Found:** ${
        result.foundWords.length
          ? result.foundWords.map(w => `\`${w}\``).join(', ')
          : '*None*'
      }\n` +
      `❌ **Missed:** ${
        result.unfoundWords.length
          ? result.unfoundWords.map(w => `\`${w}\``).join(', ')
          : '*All found!*'
      }\n\n` +
      `🏆 **Scoreboard**\n${result.scoreboard || '*No scores*'}\n\n` +
      `⏱ ${Math.floor(result.duration / 60)}m ${result.duration % 60}s`
    )
    .setTimestamp();
}

/**
 * Formats the session scoreboard for the /score command reply.
 */
function buildSessionScoreboard(session) {
  const entries = Object.values(session.scores || {})
    .sort((a, b) => b.points - a.points);

  if (!entries.length) return '*No scores yet!*';

  const medals = ['🥇', '🥈', '🥉'];
  return entries
    .map((s, i) => `${medals[i] || '•'} **${s.username}** — ${s.points} pts`)
    .join('\n');
}

// ─── Safety ───────────────────────────────────────────────────────────────────

process.on('unhandledRejection', console.error);
client.on('error', console.error);

// ─── Login ────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);

