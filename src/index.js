require('dotenv').config();
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
  endGame,
  hasActiveGame,
  getSession,
  setEndTimer,
  setHintTimer,
} = require('./gameManager');

const {
  getLocalLeaderboard,
  getGlobalLeaderboard,
  formatLeaderboard,
} = require('./leaderboard');

const { generateGridImage } = require('./gridRenderer');

// ─── Bot Client Setup ────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── Ready Event ─────────────────────────────────────────────────────────────

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  c.user.setActivity('Word Grid 🔤', { type: ActivityType.Playing });
});

// ─── Slash Command Handler ────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, channelId, guildId, user } = interaction;

  if (commandName === 'new') {
    await handleStartGame(interaction, false);
  }

  else if (commandName === 'newhard') {
    await handleStartGame(interaction, true);
  }

  else if (commandName === 'hint') {
    if (!hasActiveGame(channelId)) {
      return interaction.reply({ content: '❌ No active game in this channel. Use `/new` to start one!', ephemeral: true });
    }

    const hintData = getHint(channelId);

if (hintData?.error) {
  return interaction.reply({
    content: `❌ ${hintData.error}`,
    ephemeral: true
  });
}
    if (!hintData) {
      return interaction.reply({ content: '🎉 All words have been found!', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setColor(0xF0A500)
      .setTitle('💡 Hint!')
      .setDescription(`One of the remaining words: **\`${hintData.hint}\`**\n\n*${hintData.remaining} word(s) remaining*`)
      .setFooter({ text: 'Hints are also auto-given after 10 min of inactivity' });

    await interaction.reply({ embeds: [embed] });
  }

  else if (commandName === 'leaderboard') {
    const type = interaction.options.getString('type') || 'local';

    let title, description;
    if (type === 'global') {
      const entries = getGlobalLeaderboard(10);
      title = '🌍 Global Leaderboard';
      description = formatLeaderboard(entries);
    } else {
      const entries = getLocalLeaderboard(guildId, 10);
      title = '🏠 Server Leaderboard';
      description = formatLeaderboard(entries);
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(title)
      .setDescription(description)
      .setFooter({ text: '3-letter words = 2pts • 4-letter = 3pts • 5+ letters = 5pts' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  }

  else if (commandName === 'endgame') {
    if (!hasActiveGame(channelId)) {
      return interaction.reply({ content: '❌ No active game in this channel.', ephemeral: true });
    }

    // Grab session before ending so we can render the final image
    const session = getSession(channelId);
    const result  = endGame(channelId, false);
    if (!result) return interaction.reply({ content: '❌ No game found.', ephemeral: true });

    const embed      = buildGameEndEmbed(result, '⛔ Game Ended Early');
    const attachment = buildGridAttachment(session.grid, session.words, session.placements, session.foundWords, session.hardMode);

    await interaction.reply({ embeds: [embed], files: [attachment] });
  }

  else if (commandName === 'score') {
    if (!hasActiveGame(channelId)) {
      return interaction.reply({ content: '❌ No active game in this channel.', ephemeral: true });
    }

    const session    = getSession(channelId);
    const foundCount = session.foundWords.length;
    const totalCount = session.words.length;
    const remaining  = totalCount - foundCount;

    const hintStatus = session.hintUsed
  ? '💡 Used ❌'
  : '💡 Available ✅';

const embed = new EmbedBuilder()
  .setColor(0x57F287)
  .setTitle('📊 Current Game Score')
  .addFields(
    { name: '📝 Progress', value: `Found **${foundCount}/${totalCount}** words • **${remaining}** remaining`, inline: false },
    { name: '💡 Hint', value: hintStatus, inline: true },
    { name: '🏆 Scoreboard', value: buildSessionScoreboard(session), inline: false },
  )
  .setFooter({ text: `Mode: ${session.hardMode ? '🔴 Hard' : '🟢 Normal'} • Time limit: 30 min` })
  .setImage('attachment://grid.png');

    const attachment = buildGridAttachment(session.grid, session.words, session.placements, session.foundWords, session.hardMode);

    await interaction.reply({ embeds: [embed], files: [attachment] });
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
    await message.react('♻️');
    return;
  }

  if (result.correct) {
  await message.react('✅');

  const session = getSession(channelId);

  // 🎉 ALL FOUND
  if (result.allFound) {
    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle('🎉 All words found! Puzzle Complete!')
      .setDescription(`**${author.username}** found the last word!\n\n${result.scoreboard}`)
      .setFooter({ text: 'Amazing teamwork! Start a new game with /new' })
      .setImage('attachment://grid.png');

    const attachment = buildGridAttachment(
      result.grid,
      result.words,
      result.placements,
      result.foundWords,
      false
    );

    const gameMessage = await message.channel.messages.fetch(session.messageId);

    await gameMessage.edit({
      embeds: [embed],
      files: [attachment],
    });

    return;
  }
}); // ✅ CLOSE MessageCreate EVENT
  // ✅ NORMAL UPDATE (THIS IS THE IMPORTANT PART)
  // 🔥 EDIT ONLY IMAGE (keep original embed)
const gameMessage = await message.channel.messages.fetch(session.messageId);

// clone old embed instead of replacing
const oldEmbed = gameMessage.embeds[0];

const updatedEmbed = EmbedBuilder.from(oldEmbed)
  .setImage('attachment://grid.png');

await gameMessage.edit({
  embeds: [updatedEmbed],
  files: [attachment],
});

// ✅ SEND SEPARATE SCORE MESSAGE
await message.channel.send({
  embeds: [
    new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle(`✅ ${result.word} found by ${author.username}`)
      .setDescription(`+${result.points} pts • ${result.remaining} left`)
      .addFields({
        name: '🏆 Scoreboard',
        value: result.scoreboard,
      })
  ]
});
// ─── Helper: Handle /new and /newhard ────────────────────────────────────────

async function handleStartGame(interaction, hardMode) {
  const { channelId, guildId } = interaction;

  // Defer — image generation can take ~100ms
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
      { name: '💡 Hint', value: 'Available ✅ (1 per game)', inline: true },
      { name: '🏆 Points', value: '3-letter: **2pts** • 4-letter: **3pts** • 5+ letters: **5pts**', inline: false },
    )
    .setImage('attachment://grid.png')
    .setFooter({ text: 'Use /score to check progress • /endgame to end early' })
    .setTimestamp();

  const attachment = buildGridAttachment(
    session.grid, session.words, session.placements, [], hardMode
  );

  const reply = await interaction.editReply({
  embeds: [embed],
  files: [attachment]
});

// ✅ Save message ID so we can update it later
session.messageId = reply.id;

  // 30-minute end timer
  setEndTimer(channelId, async (cid) => {
    // Session already ended by timer — result contains final state
    const endResult = endGame(cid, false);
    if (!endResult) return;

    const endEmbed = buildGameEndEmbed(endResult, '⏰ Time\'s Up!');
    try {
      await interaction.channel.send({ embeds: [endEmbed] });
    } catch (err) {
      console.error('Could not send game end message:', err);
    }
  });

  // Hint timer
  setHintTimer(channelId, async (cid) => {
    const hintData = getHint(cid);
    if (!hintData) return;

    const hintEmbed = new EmbedBuilder()
      .setColor(0xF0A500)
      .setTitle('💡 Auto Hint!')
      .setDescription(
        `No one has answered in 10 minutes!\n\n` +
        `Here's a hint: **\`${hintData.hint}\`**\n\n` +
        `*${hintData.remaining} word(s) remaining*`
      );

    try {
      await interaction.channel.send({ embeds: [hintEmbed] });
    } catch (err) {
      console.error('Could not send hint:', err);
    }
  });
}

// ─── Helper: Build AttachmentBuilder from grid state ─────────────────────────

function buildGridAttachment(grid, words, placements, foundWords, hardMode) {
  const buffer = generateGridImage(grid, words, placements, foundWords, hardMode);
  return new AttachmentBuilder(buffer, { name: 'grid.png' });
}

// ─── Helper: Build game end embed ────────────────────────────────────────────

function buildGameEndEmbed(result, title) {
  const durationMin = Math.floor(result.duration / 60);
  const durationSec = result.duration % 60;

  return new EmbedBuilder()
    .setColor(result.allFound ? 0xFFD700 : 0xED4245)
    .setTitle(title)
    .addFields(
      {
        name: '✅ Words Found',
        value: result.foundWords.length ? result.foundWords.map(w => `\`${w}\``).join(', ') : '*None*',
        inline: false,
      },
      {
        name: '❌ Missed Words',
        value: result.unfoundWords.length ? result.unfoundWords.map(w => `\`${w}\``).join(', ') : '*All found!*',
        inline: false,
      },
      {
        name: '🏆 Final Scoreboard',
        value: result.scoreboard || '*No scores recorded*',
        inline: false,
      },
      {
        name: '⏱ Duration',
        value: `${durationMin}m ${durationSec}s`,
        inline: true,
      }
    )
    .setFooter({ text: 'Start a new game with /new or /newhard!' })
    .setTimestamp();
}

// ─── Helper: Session scoreboard ──────────────────────────────────────────────

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

// ─── Login ───────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ Failed to login:', err.message);
  process.exit(1);
});
