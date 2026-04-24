/**
 * gameManager.js
 *
 * Manages all active Word Grid sessions.
 * One game per channel at a time.
 *
 * FIXES:
 *  - Persistent sessions saved to disk (JSON) so they survive bot restarts
 *  - getAutoHint() always returns valid { hint, remaining } or null — never undefined
 *  - Timer safety: no duplicate timers, cleared on game end, no memory leaks
 *  - endGame() clears timers before deleting session so stale callbacks can't fire
 *  - autoHintUsed flag reset per-session so re-started games work cleanly
 *  - Session stores channelId + messageId for safe message editing inside timers
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { generateGrid, renderGrid, renderGridWithFound, isValidAnswer } = require('./gridGenerator');
const { addPoints, recordGamePlayed, formatLeaderboard, getLocalLeaderboard } = require('./leaderboard');

// ─── Persistence ─────────────────────────────────────────────────────────────

const DATA_DIR      = path.join(__dirname, '..', 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/** Serialises a session to a plain object safe for JSON.stringify. */
function sessionToJSON(session) {
  return {
    channelId:      session.channelId,
    guildId:        session.guildId,
    hardMode:       session.hardMode,
    grid:           session.grid,
    words:          session.words,
    placements:     session.placements,
    foundWords:     session.foundWords,
    scores:         session.scores,
    participants:   [...session.participants],
    startTime:      session.startTime,
    lastAnswerTime: session.lastAnswerTime,
    hintUsed:       session.hintUsed,
    autoHintUsed:   session.autoHintUsed,
    hintProgress:   session.hintProgress,
    messageId:      session.messageId || null,
  };
}

/** Saves all active sessions to disk. */
function persistSessions() {
  try {
    const data = {};
    for (const [channelId, session] of activeSessions) {
      data[channelId] = sessionToJSON(session);
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[GameManager] Failed to persist sessions:', err.message);
  }
}

/**
 * Loads sessions from disk on startup.
 * Timers cannot be restored — they are marked as expired so the bot can
 * gracefully notify channels when it reconnects (caller handles this).
 * Returns an array of { channelId, session } for the caller to act on.
 */
function loadPersistedSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return [];
    const raw  = fs.readFileSync(SESSIONS_FILE, 'utf8');
    const data = JSON.parse(raw);
    const restored = [];

    for (const [channelId, saved] of Object.entries(data)) {
      const session = {
        channelId:      saved.channelId,
        guildId:        saved.guildId,
        hardMode:       saved.hardMode,
        grid:           saved.grid,
        words:          saved.words,
        placements:     saved.placements,
        foundWords:     saved.foundWords     || [],
        scores:         saved.scores         || {},
        participants:   new Set(saved.participants || []),
        startTime:      saved.startTime,
        lastAnswerTime: saved.lastAnswerTime || saved.startTime,
        hintUsed:       saved.hintUsed       || false,
        autoHintUsed:   saved.autoHintUsed   || false,
        hintProgress:   saved.hintProgress   || {},
        messageId:      saved.messageId      || null,
        // Timers are null until re-attached by the caller
        endTimer:       null,
        hintTimer:      null,
      };
      activeSessions.set(channelId, session);
      restored.push({ channelId, session });
    }

    console.log(`[GameManager] Restored ${restored.length} session(s) from disk.`);
    return restored;
  } catch (err) {
    console.error('[GameManager] Failed to load persisted sessions:', err.message);
    return [];
  }
}

// ─── Active Sessions ──────────────────────────────────────────────────────────

// Map of channelId -> GameSession
const activeSessions = new Map();

// ─── Constants ────────────────────────────────────────────────────────────────

const GAME_DURATION_MS = 30 * 60 * 1000;  // 30 minutes
const HINT_INTERVAL_MS = 10 * 60 * 1000;  // auto-hint if no answer for 10 min

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Point values per word length. */
function getPoints(word) {
  const len = word.length;
  if (len === 3) return 2;
  if (len === 4) return 3;
  if (len >= 5) return 5;
  return 1;
}

/** Formats the current session scoreboard string. */
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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Starts a new game in a channel.
 * Returns { session, gridText } or { error: string }.
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
    foundWords:     [],
    scores:         {},
    participants:   new Set(),
    startTime:      Date.now(),
    lastAnswerTime: Date.now(),
    hintUsed:       false,
    autoHintUsed:   false,
    hintProgress:   {},
    messageId:      null,
    endTimer:       null,
    hintTimer:      null,
  };

  activeSessions.set(channelId, session);
  persistSessions();

  return { session, gridText: renderGrid(grid) };
}

/**
 * Processes an answer attempt.
 * Returns a result object, or null if not applicable.
 */
function processAnswer(channelId, userId, username, answer) {
  const session = activeSessions.get(channelId);
  if (!session) return null;

  const upperAnswer = answer.toUpperCase().trim();

  // ❌ not a valid word
  if (!isValidAnswer(upperAnswer, session.words)) {
    return { correct: false };
  }

  // ♻️ already found
  if (session.foundWords.includes(upperAnswer)) {
    return {
      correct: false,
      alreadyFound: true,
      word: upperAnswer
    };
  }

  // ✅ correct word
  const points = getPoints(upperAnswer);

  session.foundWords.push(upperAnswer);
  session.lastAnswerTime = Date.now();
  session.hintGiven = false;

  if (!session.scores[userId]) {
    session.scores[userId] = { username, points: 0 };
  }

  session.scores[userId].points += points;
  session.scores[userId].username = username;
  session.participants.add(userId);

  addPoints(userId, username, session.guildId, points);
  persistSessions();

  const remaining = session.words.length - session.foundWords.length;
  const completed = remaining === 0;

  // end game if finished
  if (completed) {
    endGame(channelId, true);
  }

  return {
    correct: true,
    alreadyFound: false,
    word: upperAnswer,
    points,
    remaining,
    completed, // ✅ FIXED NAME
    scoreboard: getSessionScoreboard(session),

    // extra (optional but useful)
    grid: session.grid,
    words: session.words,
    placements: session.placements,
    foundWords: session.foundWords,
    hardMode: session.hardMode,
    messageId: session.messageId,
    channelId: session.channelId,
  };
}

/**
 * Provides a manual hint for an unanswered word.
 * Returns { hint, word, remaining } or { error } or null.
 */
function getHint(channelId) {
  const session = activeSessions.get(channelId);
  if (!session) return null;

  if (session.hintUsed) {
    return { error: 'Hint already used in this game!' };
  }

  const unfound = session.words.filter(w => !session.foundWords.includes(w));
  if (!unfound.length) return null;

  const word = unfound[Math.floor(Math.random() * unfound.length)];

  if (!session.hintProgress[word]) session.hintProgress[word] = 1;
  session.hintProgress[word] = Math.min(session.hintProgress[word] + 1, word.length - 1);

  const revealed = word.slice(0, session.hintProgress[word]);
  const hidden   = '_'.repeat(word.length - session.hintProgress[word]);

  session.hintUsed = true;
  persistSessions();

  return { hint: `${revealed}${hidden}`, word, remaining: unfound.length };
}

/**
 * Provides an automatic (timer-triggered) hint.
 *
 * FIX: Always returns { hint, remaining } or null — never undefined fields.
 * Guard checks: session exists, words remain, and auto-hint not yet used.
 */
function getAutoHint(channelId) {
  const session = activeSessions.get(channelId);
  if (!session) return null;

  // Already sent one auto-hint this game
  if (session.autoHintUsed) return null;

  const unfound = session.words.filter(w => !session.foundWords.includes(w));

  // No words left — game should already be ended, but be safe
  if (!unfound.length) return null;

  const word = unfound[Math.floor(Math.random() * unfound.length)];

  if (!session.hintProgress[word]) session.hintProgress[word] = 1;
  session.hintProgress[word] = Math.min(session.hintProgress[word] + 1, word.length - 1);

  const revealed = word.slice(0, session.hintProgress[word]);
  const hidden   = '_'.repeat(word.length - session.hintProgress[word]);

  // Both fields are always defined strings
  const hint      = `${revealed}${hidden}`;
  const remaining = unfound.length;

  session.autoHintUsed = true;
  persistSessions();

  return { hint, remaining };
}

/**
 * Ends the game session and returns a final summary.
 * FIX: Timers are cleared FIRST so no stale callback can fire after deletion.
 */
function endGame(channelId, allFound = false) {
  const session = activeSessions.get(channelId);
  if (!session) return null;

  // ── Clear timers FIRST ─────────────────────────────────────────────────────
  if (session.endTimer)  { clearTimeout(session.endTimer);  session.endTimer  = null; }
  if (session.hintTimer) { clearInterval(session.hintTimer); session.hintTimer = null; }

  // Record participation
  const participantList = [...session.participants].map(uid => ({
    userId:   uid,
    username: session.scores[uid]?.username || 'Unknown',
  }));
  if (participantList.length > 0) {
    recordGamePlayed(participantList, session.guildId);
  }

  const unfoundWords = session.words.filter(w => !session.foundWords.includes(w));

  activeSessions.delete(channelId);
  persistSessions();   // Remove from disk

  return {
    allFound,
    foundWords: session.foundWords,
    unfoundWords,
    scoreboard: getSessionScoreboard(session),
    gridText:   renderGridWithFound(session.grid, session.placements, session.foundWords),
    grid:       session.grid,
    words:      session.words,
    placements: session.placements,
    hardMode:   session.hardMode,
    duration:   Math.floor((Date.now() - session.startTime) / 1000),
  };
}

/**
 * Returns true if a game is active in the given channel.
 */
function hasActiveGame(channelId) {
  return activeSessions.has(channelId);
}

/**
 * Returns the active session for a channel, or null.
 */
function getSession(channelId) {
  return activeSessions.get(channelId) || null;
}

/**
 * Sets the 30-minute end timer for a session.
 *
 * FIX: Checks for an existing timer before creating one (prevents duplicates
 * if called twice, e.g. after session restore).
 */
function setEndTimer(channelId, callback) {
  const session = activeSessions.get(channelId);
  if (!session) return;

  // Prevent duplicate timers
  if (session.endTimer) {
    clearTimeout(session.endTimer);
    session.endTimer = null;
  }

  const elapsed   = Date.now() - session.startTime;
  const remaining = Math.max(GAME_DURATION_MS - elapsed, 0);

  session.endTimer = setTimeout(() => {
    // Guard: session might have been ended between scheduling and firing
    if (!activeSessions.has(channelId)) return;
    callback(channelId);
  }, remaining);
}

/**
 * Sets the periodic hint-check interval for a session.
 *
 * FIX: Clears any existing interval before setting a new one.
 * The callback is only invoked when the session is still active and the
 * inactivity threshold has been reached.
 */
function setHintTimer(channelId, callback) {
  const session = activeSessions.get(channelId);
  if (!session) return;

  // Prevent duplicate timers
  if (session.hintTimer) {
    clearInterval(session.hintTimer);
    session.hintTimer = null;
  }

  session.hintTimer = setInterval(() => {
    const s = activeSessions.get(channelId);
    if (!s) return;                              // game ended — interval will be cleared by endGame
    if (s.autoHintUsed) return;                 // already sent one
    if (Date.now() - s.lastAnswerTime >= HINT_INTERVAL_MS) {
      callback(channelId);
    }
  }, 60_000); // check every minute
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  startGame,
  processAnswer,
  getHint,
  getAutoHint,
  endGame,
  hasActiveGame,
  getSession,
  setEndTimer,
  setHintTimer,
  getPoints,
  loadPersistedSessions,
  persistSessions,
};

