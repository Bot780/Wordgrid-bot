const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOCAL_FILE  = path.join(DATA_DIR, 'local_leaderboard.json');
const GLOBAL_FILE = path.join(DATA_DIR, 'global_leaderboard.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJSON(filepath) {
  try {
    if (!fs.existsSync(filepath)) return {};
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch {
    return {};
  }
}

function writeJSON(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Adds points for a user in a specific guild (local) and globally.
 * @param {string} userId
 * @param {string} username
 * @param {string} guildId
 * @param {number} points
 */
function addPoints(userId, username, guildId, points) {
  // Local (per-guild)
  const local = readJSON(LOCAL_FILE);
  if (!local[guildId]) local[guildId] = {};
  if (!local[guildId][userId]) {
    local[guildId][userId] = { username, points: 0, wordsFound: 0, gamesPlayed: 0 };
  }
  local[guildId][userId].username = username; // update display name
  local[guildId][userId].points += points;
  local[guildId][userId].wordsFound += 1;
  writeJSON(LOCAL_FILE, local);

  // Global
  const global = readJSON(GLOBAL_FILE);
  if (!global[userId]) {
    global[userId] = { username, points: 0, wordsFound: 0 };
  }
  global[userId].username = username;
  global[userId].points += points;
  global[userId].wordsFound += 1;
  writeJSON(GLOBAL_FILE, global);
}

/**
 * Increments games played for a user in a guild.
 */
function recordGamePlayed(participants, guildId) {
  const local = readJSON(LOCAL_FILE);
  if (!local[guildId]) local[guildId] = {};

  for (const { userId, username } of participants) {
    if (!local[guildId][userId]) {
      local[guildId][userId] = { username, points: 0, wordsFound: 0, gamesPlayed: 0 };
    }
    local[guildId][userId].gamesPlayed = (local[guildId][userId].gamesPlayed || 0) + 1;
  }
  writeJSON(LOCAL_FILE, local);
}

/**
 * Returns the top N players for a guild (local leaderboard).
 */
function getLocalLeaderboard(guildId, limit = 10) {
  const local = readJSON(LOCAL_FILE);
  if (!local[guildId]) return [];

  return Object.entries(local[guildId])
    .map(([userId, data]) => ({ userId, ...data }))
    .sort((a, b) => b.points - a.points)
    .slice(0, limit);
}

/**
 * Returns the top N players globally.
 */
function getGlobalLeaderboard(limit = 10) {
  const global = readJSON(GLOBAL_FILE);
  return Object.entries(global)
    .map(([userId, data]) => ({ userId, ...data }))
    .sort((a, b) => b.points - a.points)
    .slice(0, limit);
}

/**
 * Formats leaderboard data into a Discord embed-ready string.
 */
function formatLeaderboard(entries, title) {
  if (!entries.length) return `*No scores yet! Start a game with /new*`;

  const medals = ['🥇', '🥈', '🥉'];
  const lines = entries.map((entry, i) => {
    const rank = medals[i] || `**${i + 1}.**`;
    const words = entry.wordsFound || 0;
    return `${rank} **${entry.username}** — ${entry.points} pts *(${words} words)*`;
  });

  return lines.join('\n');
}

module.exports = {
  addPoints,
  recordGamePlayed,
  getLocalLeaderboard,
  getGlobalLeaderboard,
  formatLeaderboard
};
