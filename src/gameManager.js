/**
 * gameManager.js
 *
 * Manages all active Word Grid sessions.
 * One game per channel at a time.
 *
 * FIXES APPLIED:
 *  - isLight (theme) is stored per-session so every game has its own consistent theme
 *  - processAnswer now returns isLight + grid/words/placements/foundWords so index.js
 *    can save a solution snapshot without accessing a deleted session
 *  - endGame() clears timers FIRST, then deletes session (no stale callbacks)
 *  - getAutoHint() always returns { hint, remaining } or null — never undefined fields
 *  - setHintTimer / setEndTimer guard against duplicate timers
 *  - All word comparisons are case-insensitive
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { generateGrid, renderGrid, renderGridWithFound, isValidAnswer } = require('./gridGenerator');
const { addPoints, recordGamePlayed, formatLeaderboard, getLocalLeaderboard } = require('./leaderboard');

// ─── Persistence ──────────────────────────────────────────────────────────────

const DATA_DIR      = path.join(__dirname, '..', 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function sessionToJSON(session) {
  return {
    channelId:      session.channelId,
    guildId:        session.guildId,
    hardMode:       session.hardMode,
    isLight:        session.isLight,        // ← persist theme
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
        isLight:        saved.isLight ?? (Math.random() < 0.5), // ← restore theme
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

const activeSessions = new Map();

// ─── Constants ────────────────────────────────────────────────────────────────

const GAME_DURATION_MS = 30 * 60 * 1000;  // 30 minutes
const HINT_INTERVAL_MS = 10 * 60 * 1000;  // auto-hint after 10 min inactivity

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPoints(word) {
  const len = word.length;
  if (len === 3) return 2;
  if (len === 4) return 3;
  if (len >= 5)  return 5;
  return 1;
}

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
 * Starts a new game.
 * Returns { session, gridText } or { error: string }.
 *
 * FIX: isLight is decided HERE (once per game) and stored on the session.
 * gridRenderer receives it as a parameter so every image for this game
 * uses the same theme — not a random roll at render time.
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
    isLight:        Math.random() < 0.5,  // ← theme decided ONCE per game
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
 *
 * Returns a result object describing what happened, or null if no game is active.
 *
 * Result shape (always):
 *   { correct, alreadyFound?, word?, points?, remaining?, completed?,
 *     scoreboard?, grid?, words?, placements?, foundWords?, hardMode?,
 *     isLight?, messageId?, channelId? }
 *
 * FIX: Returns isLight so callers (index.js) can pass the correct theme
 *   to generateGridImage without needing to re-fetch the session (which may
 *   already be deleted when completed === true).
 *
 * FIX: Does NOT call endGame() when completed — that is the caller's responsibility.
 *   Previously endGame() was called here AND in index.js, causing a double-end.
 */
function processAnswer(channelId, userId, username, answer) {
  const session = activeSessions.get(channelId);
  if (!session) return null;

  // Normalise: strip whitespace, uppercase
  const upperAnswer = answer.toUpperCase().trim();

  // Reject empty or multi-word guesses early
  if (!upperAnswer || upperAnswer.includes(' ')) return { correct: false };

  // ❌ Not a valid word in this puzzle
  if (!isValidAnswer(upperAnswer, session.words)) {
    return { correct: false };
  }

  // ♻️ Already found
  if (session.foundWords.some(w => w.toUpperCase() === upperAnswer)) {
    return {
      correct:      false,
      alreadyFound: true,
      word:         upperAnswer,
    };
  }

  // ✅ Correct — new word found
  const points = getPoints(upperAnswer);

  session.foundWords.push(upperAnswer);
  session.lastAnswerTime = Date.now();
  session.hintGiven      = false;

  if (!session.scores[userId]) {
    session.scores[userId] = { username, points: 0 };
  }
  session.scores[userId].points   += points;
  session.scores[userId].username  = username;
  session.participants.add(userId);

  addPoints(userId, username, session.guildId, points);

  const remaining = session.words.length - session.foundWords.length;
  const completed = remaining === 0;

  // Snapshot everything the caller needs BEFORE potentially ending the game
  const result = {
    correct:      true,
    alreadyFound: false,
    word:         upperAnswer,
    points,
    remaining,
    completed,
    scoreboard:   getSessionScoreboard(session),

    // Snapshot — available even after endGame() deletes the session
    grid:         session.grid,
    words:        session.words,
    placements:   session.placements,
    foundWords:   [...session.foundWords],
    hardMode:     session.hardMode,
    isLight:      session.isLight,          // ← theme for image rendering
    messageId:    session.messageId,
    channelId:    session.channelId,
  };

  // Persist updated scores; if completed, endGame() will remove the session
  persistSessions();

  return result;
  // NOTE: Caller (index.js MessageCreate) is responsible for calling endGame()
  //       when result.completed === true. We do NOT call it here to avoid double-end.
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

  const unfound = session.words.filter(w => !session.foundWords.some(f => f.toUpperCase() === w.toUpperCase()));
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
 * Always returns { hint, remaining } or null — never undefined fields.
 */
function getAutoHint(channelId) {
  const session = activeSessions.get(channelId);
  if (!session)            return null;
  if (session.autoHintUsed) return null;

  const unfound = session.words.filter(w => !session.foundWords.some(f => f.toUpperCase() === w.toUpperCase()));
  if (!unfound.length) return null;

  const word = unfound[Math.floor(Math.random() * unfound.length)];

  if (!session.hintProgress[word]) session.hintProgress[word] = 1;
  session.hintProgress[word] = Math.min(session.hintProgress[word] + 1, word.length - 1);

  const revealed  = word.slice(0, session.hintProgress[word]);
  const hidden    = '_'.repeat(word.length - session.hintProgress[word]);
  const hint      = `${revealed}${hidden}`;
  const remaining = unfound.length;

  session.autoHintUsed = true;
  persistSessions();

  return { hint, remaining };
}

/**
 * Ends the game session and returns a final summary.
 *
 * FIX: Timers are cleared FIRST so no stale callback can fire after deletion.
 */
function endGame(channelId, allFound = false) {
  const session = activeSessions.get(channelId);
  if (!session) return null;

  // Clear timers BEFORE deleting session
  if (session.endTimer)  { clearTimeout(session.endTimer);   session.endTimer  = null; }
  if (session.hintTimer) { clearInterval(session.hintTimer); session.hintTimer = null; }

  const participantList = [...session.participants].map(uid => ({
    userId:   uid,
    username: session.scores[uid]?.username || 'Unknown',
  }));
  if (participantList.length > 0) {
    recordGamePlayed(participantList, session.guildId);
  }

  const unfoundWords = session.words.filter(
    w => !session.foundWords.some(f => f.toUpperCase() === w.toUpperCase())
  );

  const summary = {
    allFound,
    foundWords:   session.foundWords,
    unfoundWords,
    scoreboard:   getSessionScoreboard(session),
    gridText:     renderGridWithFound(session.grid, session.placements, session.foundWords),
    grid:         session.grid,
    words:        session.words,
    placements:   session.placements,
    hardMode:     session.hardMode,
    isLight:      session.isLight,   // ← pass theme through to callers
    duration:     Math.floor((Date.now() - session.startTime) / 1000),
    messageId:    session.messageId,
    channelId:    session.channelId,
  };

  activeSessions.delete(channelId);
  persistSessions();

  return summary;
}

function hasActiveGame(channelId) {
  return activeSessions.has(channelId);
}

function getSession(channelId) {
  return activeSessions.get(channelId) || null;
}

/**
 * Sets the 30-minute end timer.
 * FIX: Clears any existing timer first to prevent duplicates.
 */
function setEndTimer(channelId, callback) {
  const session = activeSessions.get(channelId);
  if (!session) return;

  if (session.endTimer) {
    clearTimeout(session.endTimer);
    session.endTimer = null;
  }

  const elapsed   = Date.now() - session.startTime;
  const remaining = Math.max(GAME_DURATION_MS - elapsed, 0);

  session.endTimer = setTimeout(() => {
    if (!activeSessions.has(channelId)) return;
    callback(channelId);
  }, remaining);
}

/**
 * Sets the periodic hint-check interval.
 * FIX: Clears any existing interval first to prevent duplicates.
 * Fires callback only when inactive for HINT_INTERVAL_MS and auto-hint not yet used.
 */
function setHintTimer(channelId, callback) {
  const session = activeSessions.get(channelId);
  if (!session) return;

  if (session.hintTimer) {
    clearInterval(session.hintTimer);
    session.hintTimer = null;
  }

  session.hintTimer = setInterval(() => {
    const s = activeSessions.get(channelId);
    if (!s) return;
    if (s.autoHintUsed) return;
    if (Date.now() - s.lastAnswerTime >= HINT_INTERVAL_MS) {
      callback(channelId);
    }
  }, 60_000); // check every minute
}

// ─── Exports ──────────────────────────────────────────────────────────────────

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

