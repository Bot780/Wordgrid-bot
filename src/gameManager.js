/**
 * GameManager handles all active Word Grid sessions.
 * One game per channel at a time.
 */

const { generateGrid, renderGrid, renderGridWithFound, isValidAnswer } = require('./gridGenerator');
const { addPoints, recordGamePlayed, formatLeaderboard, getLocalLeaderboard } = require('./leaderboard');

// Map of channelId -> GameSession
const activeSessions = new Map();

const GAME_DURATION_MS = 30 * 60 * 1000;  // 30 minutes
const HINT_INTERVAL_MS = 10 * 60 * 1000;  // hint if unanswered for 10 min

/**
 * Point values per word length
 */
function getPoints(word) {
  const len = word.length;
  if (len === 3) return 2;
  if (len === 4) return 3;
  if (len >= 5) return 5;
  return 1;
}

/**
 * Starts a new game in a channel.
 * Returns an object with embed data, or null if game already running.
 */
function startGame(channelId, guildId, hardMode = false) {
  if (activeSessions.has(channelId)) {
    return { error: 'A game is already running in this channel! Finish it or wait for it to end.' };
  }

  const { grid, words, placements } = generateGrid(hardMode);

  const session = {
  channelId,
  guildId,
  hardMode,
  grid,
  words,
  placements,
  foundWords: [],
  scores: {},
  participants: new Set(),
  startTime: Date.now(),
  lastAnswerTime: Date.now(),

  hintUsed: false,
  hintProgress: {},   // word -> revealed letters count

  endTimer: null,
  hintTimer: null,
};

  activeSessions.set(channelId, session);
  return { session, gridText: renderGrid(grid) };
}

/**
 * Processes an answer attempt.
 * Returns result object.
 */
function processAnswer(channelId, userId, username, answer) {
  const session = activeSessions.get(channelId);
  if (!session) return null; // No active game

  const upperAnswer = answer.toUpperCase().trim();

  // Only accept valid words from the grid
  if (!isValidAnswer(upperAnswer, session.words)) return null;

  // Already found?
  if (session.foundWords.includes(upperAnswer)) {
    return { alreadyFound: true, word: upperAnswer };
  }

  // Correct answer!
  const points = getPoints(upperAnswer);
  session.foundWords.push(upperAnswer);
  session.lastAnswerTime = Date.now();
  session.hintGiven = false; // reset hint timer on correct answer

  // Track score
  if (!session.scores[userId]) {
    session.scores[userId] = { username, points: 0 };
  }
  session.scores[userId].points += points;
  session.scores[userId].username = username;
  session.participants.add(userId);

  // Save to leaderboard
  addPoints(userId, username, session.guildId, points);

  const remaining = session.words.length - session.foundWords.length;
  const gridText = renderGridWithFound(session.grid, session.placements, session.foundWords);
  const allFound = remaining === 0;

  if (allFound) {
    endGame(channelId, true);
  }

  return {
    correct: true,
    word: upperAnswer,
    points,
    remaining,
    allFound,
    gridText,
    scoreboard: getSessionScoreboard(session),
  };
}

/**
 * Provides a hint for an unanswered word.
 * Returns hint string or null.
 */
function getHint(channelId) {
  const session = activeSessions.get(channelId);
  if (!session) return null;

  // ❌ Only ONE hint per game
  if (session.hintUsed) {
    return { error: 'Hint already used in this game!' };
  }

  const unfound = session.words.filter(w => !session.foundWords.includes(w));
  if (!unfound.length) return null;

  // Pick random word
  const word = unfound[Math.floor(Math.random() * unfound.length)];

  // Initialize progress
  if (!session.hintProgress[word]) {
    session.hintProgress[word] = 1;
  }

  // Increase reveal
  session.hintProgress[word] = Math.min(
    session.hintProgress[word] + 1,
    word.length
  );

  const reveal = session.hintProgress[word];

  const hint =
    word.slice(0, reveal) +
    '_'.repeat(word.length - reveal);

  session.hintUsed = true;

  return {
    hint,
    word,
    remaining: unfound.length
  };
}

/**
 * Checks if hint should be given (10 min without answer).
 */
function shouldGiveHint(channelId) {
  const session = activeSessions.get(channelId);
  if (!session) return false;
  return Date.now() - session.lastAnswerTime >= HINT_INTERVAL_MS;
}

/**
 * Ends the game session and returns final summary.
 */
function endGame(channelId, allFound = false) {
  const session = activeSessions.get(channelId);
  if (!session) return null;

  // Clear timers
  if (session.endTimer) clearTimeout(session.endTimer);
  if (session.hintTimer) clearInterval(session.hintTimer);

  // Record game participation
  const participantList = [...session.participants].map(uid => ({
    userId: uid,
    username: session.scores[uid]?.username || 'Unknown'
  }));
  if (participantList.length > 0) {
    recordGamePlayed(participantList, session.guildId);
  }

  const unfoundWords = session.words.filter(w => !session.foundWords.includes(w));

  activeSessions.delete(channelId);

  return {
    allFound,
    foundWords: session.foundWords,
    unfoundWords,
    scoreboard: getSessionScoreboard(session),
    gridText: renderGridWithFound(session.grid, session.placements, session.foundWords),
    duration: Math.floor((Date.now() - session.startTime) / 1000),
  };
}

/**
 * Checks if a game is running in a channel.
 */
function hasActiveGame(channelId) {
  return activeSessions.has(channelId);
}

/**
 * Formats the current session scoreboard.
 */
function getSessionScoreboard(session) {
  const entries = Object.entries(session.scores)
    .map(([uid, data]) => ({ userId: uid, username: data.username, points: data.points }))
    .sort((a, b) => b.points - a.points);

  if (!entries.length) return '*No scores yet!*';

  const medals = ['🥇', '🥈', '🥉'];
  return entries.map((e, i) => {
    const rank = medals[i] || `**${i + 1}.**`;
    return `${rank} **${e.username}** — ${e.points} pts`;
  }).join('\n');
}

/**
 * Returns the active session for a channel.
 */
function getSession(channelId) {
  return activeSessions.get(channelId) || null;
}

/**
 * Sets the end timer for a session (called after sending the start message).
 * Returns the session.
 */
function setEndTimer(channelId, callback) {
  const session = activeSessions.get(channelId);
  if (!session) return;
  session.endTimer = setTimeout(() => callback(channelId), GAME_DURATION_MS);
}

/**
 * Sets the hint interval for a session.
 */
function setHintTimer(channelId, callback) {
  const session = activeSessions.get(channelId);
  if (!session) return;
  session.hintTimer = setInterval(() => {
    if (shouldGiveHint(channelId)) {
      callback(channelId);
    }
  }, 60 * 1000); // check every minute
}

module.exports = {
  startGame,
  processAnswer,
  getHint,
  endGame,
  hasActiveGame,
  getSession,
  setEndTimer,
  setHintTimer,
  getPoints,
};
