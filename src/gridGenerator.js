const WORDS = require('./words');

/**
 * Generates an NxN grid with hidden words for the puzzle.
 * Normal mode: 9x9 grid with ~8-12 words
 * Hard mode: 9x9 grid with more words, smaller ones hidden, harder fills
 */

const GRID_SIZE = 9;

const DIRECTIONS = [
  [0, 1],   // right
  [1, 0],   // down
  [1, 1],   // diagonal down-right
  [0, -1],  // left
  [-1, 0],  // up
  [-1, -1], // diagonal up-left
  [1, -1],  // diagonal down-left
  [-1, 1],  // diagonal up-right
];

const NORMAL_DIRECTIONS = [
  [0, 1],   // right
  [1, 0],   // down
  [1, 1],   // diagonal down-right
];

/**
 * Picks a random subset of words for the puzzle.
 */
function pickWords(hardMode) {
  const picked = [];

  if (hardMode) {
    // Hard: mix of 3–7 letter words
    const threeLetters = shuffle([...WORDS[3]]).slice(0, 3);
    const fourLetters  = shuffle([...WORDS[4]]).slice(0, 3);
    const fiveLetters  = shuffle([...WORDS[5]]).slice(0, 2);
    const sixLetters   = shuffle([...WORDS[6]]).slice(0, 2);
    const sevenLetters = shuffle([...WORDS[7]]).slice(0, 1);
    picked.push(...threeLetters, ...fourLetters, ...fiveLetters, ...sixLetters, ...sevenLetters);
  } else {
    // Normal: 4–6 letter words
    const fourLetters  = shuffle([...WORDS[4]]).slice(0, 4);
    const fiveLetters  = shuffle([...WORDS[5]]).slice(0, 3);
    const sixLetters   = shuffle([...WORDS[6]]).slice(0, 2);
    picked.push(...fourLetters, ...fiveLetters, ...sixLetters);
  }

  return picked;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Attempts to place a word on the grid.
 * Returns true if successful.
 */
function placeWord(grid, word, directions) {
  const shuffledDirs = shuffle([...directions]);
  for (const [dr, dc] of shuffledDirs) {
    // Try random start positions
    const positions = [];
    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        positions.push([r, c]);
      }
    }
    shuffle(positions);

    for (const [startR, startC] of positions) {
      if (canPlace(grid, word, startR, startC, dr, dc)) {
        doPlace(grid, word, startR, startC, dr, dc);
        return { placed: true, row: startR, col: startC, dr, dc };
      }
    }
  }
  return { placed: false };
}

function canPlace(grid, word, r, c, dr, dc) {
  for (let i = 0; i < word.length; i++) {
    const nr = r + dr * i;
    const nc = c + dc * i;
    if (nr < 0 || nr >= GRID_SIZE || nc < 0 || nc >= GRID_SIZE) return false;
    if (grid[nr][nc] !== null && grid[nr][nc] !== word[i]) return false;
  }
  return true;
}

function doPlace(grid, word, r, c, dr, dc) {
  for (let i = 0; i < word.length; i++) {
    grid[r + dr * i][c + dc * i] = word[i];
  }
}

/**
 * Fill remaining null cells with random uppercase letters. **/
function fillGrid(grid) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      if (!grid[r][c] || grid[r][c] === null) {
        grid[r][c] = letters[Math.floor(Math.random() * letters.length)];
      }
    }
  }

  return grid;
}

/**
 * Main grid generator.
 * Returns { grid, words, placements }
 * placements: [{word, row, col, dr, dc}]
 */
function generateGrid(hardMode = false) {
  let attempts = 0;
  const MAX_ATTEMPTS = 20;

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    const grid = Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(null));
    const words = pickWords(hardMode);
    const placements = [];
    const directions = hardMode ? DIRECTIONS : NORMAL_DIRECTIONS;

    // Sort longer words first for better placement
    const sortedWords = [...words].sort((a, b) => b.length - a.length);
    let allPlaced = true;

    for (const word of sortedWords) {
      const result = placeWord(grid, word, directions);
      if (result.placed) {
        placements.push({ word, row: result.row, col: result.col, dr: result.dr, dc: result.dc });
      } else {
        allPlaced = false;
        break;
      }
    }

    if (allPlaced) {
      fillGrid(grid);
      return { grid, words: sortedWords, placements };
    }
  }

  // Fallback: generate with fewer words
  const grid = Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(null));
  const words = shuffle([...WORDS[4]]).slice(0, 4);
  const placements = [];

  for (const word of words) {
    const result = placeWord(grid, word, NORMAL_DIRECTIONS);
    if (result.placed) {
      placements.push({ word, row: result.row, col: result.col, dr: result.dr, dc: result.dc });
    }
  }

  fillGrid(grid);
  return { grid, words: placements.map(p => p.word), placements };
}

/**
 * Renders the grid as a Discord-formatted code block.
 */
function renderGrid(grid) {
  const header = '```\n  A B C D E F G H I\n';
  const rows = grid.map((row, i) => {
    const rowNum = String(i + 1).padStart(2);
    return `${rowNum} ${row.join(' ')}`;
  }).join('\n');
  return header + rows + '\n```';
}

/**
 * Renders the grid with found words highlighted using bracket notation.
 * foundWords: array of word strings already found
 * placements: array of placement objects
 */
function renderGridWithFound(grid, placements, foundWords) {
  const highlighted = Array.from({ length: GRID_SIZE }, (_, r) =>
    Array.from({ length: GRID_SIZE }, (_, c) => ({ letter: grid[r][c], found: false }))
  );

  for (const p of placements) {
    if (foundWords.includes(p.word)) {
      for (let i = 0; i < p.word.length; i++) {
        highlighted[p.row + p.dr * i][p.col + p.dc * i].found = true;
      }
    }
  }

  const header = '```\n  A B C D E F G H I\n';
  const rows = highlighted.map((row, i) => {
    const rowNum = String(i + 1).padStart(2);
    const cells = row.map(cell => cell.found ? `[${cell.letter}]` : ` ${cell.letter} `);
    // Compact display
    const compact = row.map(cell => cell.found ? `*${cell.letter}` : cell.letter).join(' ');
    return `${rowNum} ${compact}`;
  }).join('\n');
  return header + rows + '\n```';
}

/**
 * Validates if a given answer word exists in the grid word list.
 * Returns true if it's a valid answer.
 */
function isValidAnswer(word, words) {
  return words.includes(word.toUpperCase());
}

module.exports = { generateGrid, renderGrid, renderGridWithFound, isValidAnswer, GRID_SIZE };
