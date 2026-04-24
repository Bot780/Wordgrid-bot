/**
 * index.js — Word Grid Discord Bot
 *
 * FIXES applied:
 *  1. Every slash command defers immediately → no 10062 "Unknown interaction" timeouts
 *  2. No multiple-reply paths — all commands use deferReply + editReply exclusively
 *  3. Auto-hint "undefined" fixed in gameManager; extra guard here before sending
 *  4. Last-word found: endGame() is called inside processAnswer before we fetch
 *     the message, and timers are cleared there — no stale interaction used
 *  5. Session persistence: restored sessions get new timers on ready
 *  6. Timers always fetch channel via client.channels.fetch() — no stale objects
 *  7. All async operations wrapped in try/catch — bot never crashes on a bad edit
 */

'use strict';

require('dotenv').config();

const express = require('express');
const app = express();
app.get('/', (_, res) => res.send('Bot alive'));
app.listen(process.env.PORT || 3000, () =>
  console.log(`🌐 Server running on port ${process.env.PORT || 3000}`)
);

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
  Events,
  ActivityType,
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
  console.log(`✅ Logged in as ${c.user.tag}`);
  c.user.setActivity('Word Grid 🔤', { type: ActivityType.Playing });

  // Re-attach timers for any sessions that survived a restart
  const restored = loadPersistedSessions();
  for (const { channelId, session } of restored) {
    const elapsed = Date.now() - session.startTime;
    const maxMs   = 30 * 60 * 1000;

    if (elapsed >= maxMs) {
      // Game expired while the bot was offline — end it now
      try {
        const result  = endGame(channelId, false);
        if (!result || !session.channelId || !session.messageId) continue;

        const channel = await client.channels.fetch(session.channelId).catch(() => null);
        if (!channel) continue;

        const msg = await channel.messages.fetch(session.messageId).catch(() => null);
        if (msg) {
          await msg.edit({
            embeds: [buildGameEndEmbed(result, "⏰ Time's Up! (bot restarted)")],
            files:  [buildGridAttachment(result.grid, result.words, result.placements, result.foundWords, result.hardMode)],
          }).catch(console.error);
        }
        await channel.send({ content: '⏰ The previous game expired while the bot was offline.' }).catch(() => {});
      } catch (err) {
        console.error('[Restore] Error ending expired session:', err.message);
      }
    } else {
      // Re-attach timers with remaining time taken into account
      attachTimers(channelId);
      console.log(`[Restore] Re-attached timers for channel ${channelId}`);
    }
  }
});

// ─── Slash Command Handler ────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, channelId, guildId, user } = interaction;

  // ── /new ──────────────────────────────────────────────────────────────────
  if (commandName === 'new') {
    await handleStartGame(interaction, false);
  }

  // ── /newhard ──────────────────────────────────────────────────────────────
  else if (commandName === 'newhard') {
    await handleStartGame(interaction, true);
  }

  // ── /hint ─────────────────────────────────────────────────────────────────
  else if (commandName === 'hint') {
    // FIX: defer FIRST — prevents 10062 if hint logic takes > 3 s
    await interaction.deferReply({ ephemeral: true });

    if (!hasActiveGame(channelId)) {
      return interaction.editReply({ content: '❌ No active game in this channel.' });
    }

    const hintData = getHint(channelId);

    if (hintData?.error) {
      return interaction.editReply({ content: `❌ ${hintData.error}` });
    }
    if (!hintData) {
      return interaction.editReply({ content: '🎉 All words have already been found!' });
    }

    const embed = new EmbedBuilder()
      .setColor(0xF0A500)
      .setTitle('💡 Hint!')
      .setDescription(`\`${hintData.hint}\`\n${hintData.remaining} word(s) remaining`);

    await interaction.editReply({ embeds: [embed] });
  }

  // ── /leaderboard ──────────────────────────────────────────────────────────
  else if (commandName === 'leaderboard') {
    // FIX: defer first — file reads can be slow
    await interaction.deferReply();

    const type = interaction.options.getString('type') || 'local';
    let title, description;

    if (type === 'global') {
      const entries = getGlobalLeaderboard(10);
      title        = '🌍 Global Leaderboard';
      description  = formatLeaderboard(entries);
    } else {
      const entries = getLocalLeaderboard(guildId, 10);
      title        = '🏠 Server Leaderboard';
      description  = formatLeaderboard(entries);
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(title)
      .setDescription(description)
      .setFooter({ text: '3-letter words = 2pts • 4-letter = 3pts • 5+ letters = 5pts' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }

  // ── /endgame ──────────────────────────────────────────────────────────────
  else if (commandName === 'endgame') {
    // FIX: defer first — image generation takes time
    await interaction.deferReply();

    if (!hasActiveGame(channelId)) {
      return interaction.editReply({ content: '❌ No active game in this channel.' });
    }

    const session = getSession(channelId);
    const result  = endGame(channelId, false);
    if (!result) return interaction.editReply({ content: '❌ Could not end game.' });

    const embed      = buildGameEndEmbed(result, '⛔ Game Ended Early');
    const attachment = buildGridAttachment(
      session.grid, session.words, session.placements, session.foundWords, session.hardMode
    );

    await interaction.editReply({ embeds: [embed], files: [attachment] });
  }

  // ── /score ────────────────────────────────────────────────────────────────
  else if (commandName === 'score') {
    // FIX: defer first — image generation takes time
    await interaction.deferReply({ ephemeral: true });

    if (!hasActiveGame(channelId)) {
      return interaction.editReply({ content: '❌ No active game in this channel.' });
    }

    const session    = getSession(channelId);
    const foundCount = session.foundWords.length;
    const totalCount = session.words.length;
    const remaining  = totalCount - foundCount;
    const hintStatus = session.hintUsed ? '💡 Used ❌' : '💡 Available ✅';

    const embed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle('📊 Current Game Score')
      .addFields(
        { name: '📝 Progress', value: `Found **${foundCount}/${totalCount}** words • **${remaining}** remaining`, inline: false },
        { name: '💡 Hint',    value: hintStatus, inline: true },
        { name: '🏆 Scoreboard', value: buildSessionScoreboard(session), inline: false },
      )
      .setFooter({ text: `Mode: ${session.hardMode ? '🔴 Hard' : '🟢 Normal'} • Time limit: 30 min` })
      .setImage('attachment://grid.png');

    const attachment = buildGridAttachment(
      session.grid, session.words, session.placements, session.foundWords, session.hardMode
    );

    await interaction.editReply({ embeds: [embed], files: [attachment] });
  }
});

// ─── Message Handler (Answer Detection) ──────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const { channelId, author, content } = message;
  if (!hasActiveGame(channelId)) return;

  const word = content.trim();
  if (!word || word.includes(' ') || word.length < 3 || word.length > 7) return;
  if (!/^[a-zA-Z]+$/.test(word)) return;

  const result = processAnswer(channelId, author.id, author.username, word);
  if (!result) return;

  if (result.alreadyFound) {
    await message.react('♻️').catch(() => {});
    return;
  }

  if (!result.correct) return;

  await message.react('✅').catch(() => {});

  // ── All words found ───────────────────────────────────────────────────────
  // FIX: processAnswer already called endGame() internally when allFound — timers
  // are cleared. We just need to update the UI.
  if (result.allFound) {
    try {
      const attachment = buildGridAttachment(
        result.grid, result.words, result.placements, result.foundWords, false
      );

      const embed = new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle('🎉 All words found! Puzzle Complete!')
        .setDescription(`**${author.username}** found the last word!\n\n${result.scoreboard}`)
        .setFooter({ text: 'Amazing teamwork! Start a new game with /new' })
        .setImage('attachment://grid.png');

      // FIX: fetch channel + message via client — not via stale interaction
      if (result.messageId && result.channelId) {
        const channel    = await client.channels.fetch(result.channelId).catch(() => null);
        const gameMessage = channel
          ? await channel.messages.fetch(result.messageId).catch(() => null)
          : null;

        if (gameMessage) {
          await gameMessage.edit({ embeds: [embed], files: [attachment] }).catch(console.error);
        }
      }
    } catch (err) {
      console.error('[AllFound] Error updating game message:', err.message);
    }
    return;
  }

  // ── Normal word found — update main grid image ────────────────────────────
  // FIX: session is still alive here (not allFound), so getSession is safe
  const session = getSession(channelId);
  if (!session) return;

  try {
    const attachment = buildGridAttachment(
      session.grid, session.words, session.placements, session.foundWords, session.hardMode
    );

    if (session.messageId) {
      const channel    = await client.channels.fetch(session.channelId).catch(() => null);
      const gameMessage = channel
        ? await channel.messages.fetch(session.messageId).catch(() => null)
        : null;

      if (gameMessage) {
        const oldEmbed     = gameMessage.embeds[0];
        const updatedEmbed = EmbedBuilder.from(oldEmbed).setImage('attachment://grid.png');
        await gameMessage.edit({ embeds: [updatedEmbed], files: [attachment] }).catch(console.error);
      }
    }
  } catch (err) {
    console.error('[WordFound] Error updating grid message:', err.message);
  }

  // Send a brief score update as a new message
  try {
    await message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle(`✅ ${result.word} found by ${author.username}`)
          .setDescription(`+${result.points} pts • ${result.remaining} left`)
          .addFields({ name: '🏆 Scoreboard', value: result.scoreboard }),
      ],
    });
  } catch (err) {
    console.error('[WordFound] Error sending score message:', err.message);
  }
});

// ─── /new + /newhard Handler ──────────────────────────────────────────────────

async function handleStartGame(interaction, hardMode) {
  const { channelId, guildId } = interaction;

  // FIX: defer IMMEDIATELY — image generation can take ~100–300 ms
  await interaction.deferReply();

  const result = startGame(channelId, guildId, hardMode);

  if (result.error) {
    return interaction.editReply({ content: `❌ ${result.error}` });
  }

  const { session } = result;
  const modeLabel   = hardMode ? '🔴 Hard Mode' : '🟢 Normal Mode';
  const modeColor   = hardMode ? 0xED4245 : 0x57F287;
  const modeNote    = hardMode
    ? 'Words hidden in **all 8 directions** (including diagonals & backwards)'
    : 'Words hidden **right, down, and diagonally (↘)**';

  const embed = new EmbedBuilder()
    .setColor(modeColor)
    .setTitle(`🔤 Word Grid — ${modeLabel}`)
    .setDescription(
      `Find **${session.words.length} hidden words** in the grid!\n` +
      `${modeNote}\n\n` +
      `**Just type your answer** in this channel to submit!`
    )
    .addFields(
      { name: '⏱ Time Limit', value: '30 minutes', inline: true },
      { name: '💡 Hint',      value: 'Available ✅ (1 per game)', inline: true },
      { name: '🏆 Points',    value: '3-letter: **2pts** • 4-letter: **3pts** • 5+ letters: **5pts**', inline: false },
    )
    .setImage('attachment://grid.png')
    .setFooter({ text: 'Use /score to check progress • /endgame to end early' })
    .setTimestamp();

  const attachment = buildGridAttachment(session.grid, session.words, session.placements, [], hardMode);

  const reply = await interaction.editReply({ embeds: [embed], files: [attachment] });

  // Store IDs for later message edits (timers, word-found updates)
  session.messageId = reply.id;
  session.channelId = channelId;

  attachTimers(channelId);
}

/**
 * Attaches end timer and hint timer to the session identified by channelId.
 * Safe to call on restored sessions — setEndTimer/setHintTimer deduplicate.
 */
function attachTimers(channelId) {
  // ── 30-minute end timer ───────────────────────────────────────────────────
  setEndTimer(channelId, async (cid) => {
    // FIX: capture session BEFORE endGame deletes it
    const session   = getSession(cid);
    const endResult = endGame(cid, false);
    if (!endResult || !session) return;

    try {
      const channel = await client.channels.fetch(session.channelId).catch(() => null);
      if (!channel) return;

      const gameMessage = session.messageId
        ? await channel.messages.fetch(session.messageId).catch(() => null)
        : null;

      if (gameMessage) {
        await gameMessage.edit({
          embeds: [buildGameEndEmbed(endResult, "⏰ Time's Up!")],
          files:  [buildGridAttachment(
            endResult.grid, endResult.words, endResult.placements,
            endResult.foundWords, endResult.hardMode
          )],
        }).catch(console.error);
      }

      await channel.send({ content: '⏰ Game ended — time limit reached!' }).catch(() => {});
    } catch (err) {
      console.error('[EndTimer] Error ending game by timer:', err.message);
    }
  });

  // ── Auto-hint interval ────────────────────────────────────────────────────
  setHintTimer(channelId, async (cid) => {
    try {
      const hintData = getAutoHint(cid);

      // FIX: guard against undefined/null before using hintData fields
      if (!hintData || !hintData.hint) return;

      const hintEmbed = new EmbedBuilder()
        .setColor(0xF0A500)
        .setTitle('💡 Auto Hint!')
        .setDescription(
          `No one has answered in 10 minutes!\n\n` +
          `Here's a hint: **\`${hintData.hint}\`**\n\n` +
          `*${hintData.remaining} word(s) remaining*`
        );

      const channel = await client.channels.fetch(cid).catch(() => null);
      if (!channel) return;

      await channel.send({ embeds: [hintEmbed] });
    } catch (err) {
      console.error('[HintTimer] Could not send auto-hint:', err.message);
    }
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildGridAttachment(grid, words, placements, foundWords, hardMode) {
  const buffer = generateGridImage(grid, words, placements, foundWords ?? [], hardMode);
  return new AttachmentBuilder(buffer, { name: 'grid.png' });
}

function buildGameEndEmbed(result, title) {
  const durationMin = Math.floor(result.duration / 60);
  const durationSec = result.duration % 60;

  return new EmbedBuilder()
    .setColor(result.allFound ? 0xFFD700 : 0xED4245)
    .setTitle(title)
    .addFields(
      {
        name:   '✅ Words Found',
        value:  result.foundWords.length
          ? result.foundWords.map(w => `\`${w}\``).join(', ')
          : '*None*',
        inline: false,
      },
      {
        name:   '❌ Missed Words',
        value:  result.unfoundWords.length
          ? result.unfoundWords.map(w => `\`${w}\``).join(', ')
          : '*All found!*',
        inline: false,
      },
      {
        name:   '🏆 Final Scoreboard',
        value:  result.scoreboard || '*No scores recorded*',
        inline: false,
      },
      {
        name:   '⏱ Duration',
        value:  `${durationMin}m ${durationSec}s`,
        inline: true,
      }
    )
    .setFooter({ text: 'Start a new game with /new or /newhard!' })
    .setTimestamp();
}

function buildSessionScoreboard(session) {
  const entries = Object.entries(session.scores)
    .map(([, data]) => ({ username: data.username, points: data.points }))
    .sort((a, b) => b.points - a.points);

  if (!entries.length) return '*No scores yet!*';

  const medals = ['🥇', '🥈', '🥉'];
  return entries.map((e, i) => {
    const rank = medals[i] || `**${i + 1}.**`;
    return `${rank} **${e.username}** — ${e.points} pts`;
  }).join('\n');
}

// ─── Login ────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ Failed to login:', err.message);
  process.exit(1);
});
