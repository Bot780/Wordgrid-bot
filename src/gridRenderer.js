/**
 * gridRenderer.js
 * Generates a high-quality word grid image using @napi-rs/canvas.
 *
 * Rendering order (painter's algorithm):
 *   1. Background
 *   2. Grid cell backgrounds + borders
 *   3. Pill highlights (drawn behind letters, above cells)
 *   4. Letters
 *   5. Header & word-list panel
 */

const { createCanvas } = require('@napi-rs/canvas');

// ─── Design Tokens ────────────────────────────────────────────────────────────

const isLight = Math.random() < 0.5;

const THEME = isLight
  ? {
      bg: '#ffffff',
      cellBg: '#f3f4f6',
      cellBorder: '#d1d5db',
      letterDefault: '#111827',
      letterOnPill: '#111827',
      headerBg: '#ffffff',
      titleColor: '#111827',
      modeNormal: '#22c55e',
      modeHard: '#ef4444',
      wordPending: '#9ca3af',
      wordFound: '#111827',
      progressTrack: '#e5e7eb',
      progressFill: '#22c55e',
      accent: '#3b82f6',
    }
  : {
      bg: '#0f0f14',
      cellBg: '#17171f',
      cellBorder: '#2a2a40',
      letterDefault: '#ffffff',
      letterOnPill: '#ffffff',
      headerBg: '#0f0f14',
      titleColor: '#ffffff',
      modeNormal: '#4ade80',
      modeHard: '#f87171',
      wordPending: '#6b7280',
      wordFound: '#e2e8f0',
      progressTrack: '#1e1e2e',
      progressFill: '#4ade80',
      accent: '#5865f2',
    };

// Palette for auto-assigning highlight colours when not specified
const PILL_PALETTE = [
  '#5b8af5cc',
  '#f472b6cc',
  '#4ade80cc',
  '#fb923ccc',
  '#a78bfacc',
  '#38bdf8cc',
  '#facc15cc',
  '#34d399cc',
  '#f87171cc',
  '#818cf8cc',
];

// ─── Layout ───────────────────────────────────────────────────────────────────

const CELL_SIZE    = 54;    // px — each grid cell
const CELL_GAP     = 2;     // px — gap between cells
const GRID_MARGIN  = 24;    // px — space around the grid
const HEADER_H     = 64;    // px — title bar height
const FOOTER_H     = 14;    // px — bottom padding
const WORD_ROW_H   = 34;    // px — height of each word-list chip row
const WORDS_COLS   = 4;     // columns in the word list
const SECTION_GAP  = 16;    // px — gap between grid and word list

// Pill geometry
const PILL_RADIUS  = CELL_SIZE * 0.52;   // curvature of the pill caps
const PILL_INSET   = 3;                  // px — inset from cell edge

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * generateGridImage
 *
 * @param {string[][]} grid         - 2D array of uppercase letter strings
 * @param {string[]}   words        - full word list for the puzzle
 * @param {object[]}   placements   - [{word, row, col, dr, dc}, ...]
 * @param {string[]}   foundWords   - words already found (subset of words)
 * @param {boolean}    hardMode     - affects mode badge colour
 * @returns {Buffer}   PNG buffer
 *
 * foundWords entries are matched against placements to build the highlight list.
 * Each found word automatically gets a colour from PILL_PALETTE.
 */
function generateGridImage(grid, words, placements, foundWords = [], hardMode = false) {
  const rows = grid.length;
  const cols = grid[0].length;

  // Build structured highlight objects from placements
  const highlights = buildHighlights(placements, foundWords);

  // ── Canvas dimensions ─────────────────────────────────────────────────────
  const gridPixelW = cols * CELL_SIZE + (cols - 1) * CELL_GAP;
  const gridPixelH = rows * CELL_SIZE + (rows - 1) * CELL_GAP;

  const wordRows   = Math.ceil(words.length / WORDS_COLS);
  const wordListH  = wordRows > 0 ? SECTION_GAP + 18 + wordRows * WORD_ROW_H + 8 : 0;

  const canvasW = gridPixelW + GRID_MARGIN * 2;
  const canvasH = HEADER_H + gridPixelH + FOOTER_H + wordListH + GRID_MARGIN * 2;

  const canvas = createCanvas(canvasW, canvasH);
  const ctx    = canvas.getContext('2d');

  // ── 1. Background ─────────────────────────────────────────────────────────
  ctx.fillStyle = THEME.bg;
  ctx.fillRect(0, 0, canvasW, canvasH);

  // ── 2. Header ─────────────────────────────────────────────────────────────
  drawHeader(ctx, canvasW, hardMode, foundWords.length, words.length);

  // ── Grid origin ───────────────────────────────────────────────────────────
  const ox = GRID_MARGIN;                     // grid left edge
  const oy = HEADER_H + GRID_MARGIN;          // grid top edge

  // ── 3. Cell backgrounds & borders ────────────────────────────────────────
  drawCells(ctx, grid, rows, cols, ox, oy);

  // ── 4. Pill highlights (behind letters) ──────────────────────────────────
  for (const h of highlights) {
    drawPillHighlight(ctx, h.positions, ox, oy, h.color);
  }

  // ── 5. Letters ────────────────────────────────────────────────────────────
  drawLetters(ctx, grid, rows, cols, ox, oy, highlights);

  // ── 6. Word list ──────────────────────────────────────────────────────────
  const wordListY = oy + gridPixelH + FOOTER_H;
  drawWordList(ctx, words, placements, foundWords, ox, wordListY, gridPixelW);

  return canvas.toBuffer('image/png');
}

// ─── Drawing Helpers ──────────────────────────────────────────────────────────

/**
 * Converts a placement + foundWords list into highlight descriptor objects.
 * { positions: [{row,col}, ...], color: string }
 */
function buildHighlights(placements, foundWords) {
  return foundWords
    .map((word, idx) => {
      const placement = placements.find(p => p.word === word);
      if (!placement) return null;

      const positions = [];
      for (let i = 0; i < word.length; i++) {
        positions.push({
          row: placement.row + placement.dr * i,
          col: placement.col + placement.dc * i,
        });
      }

      // ✅ COLOR LOGIC MUST BE HERE (inside map)
      const base = PILL_PALETTE[idx % PILL_PALETTE.length];

      const color = isLight
        ? base.replace('cc', '55') // light theme softer
        : base.replace('cc', '88'); // dark theme stronger

      return {
        word,
        positions,
        color,
      };
    })
    .filter(Boolean);
}

/** Draws the title header bar. */
function drawHeader(ctx, canvasW, hardMode, found, total) {
  // Title
  ctx.fillStyle    = THEME.titleColor;
  ctx.font         = 'bold 22px Arial, sans-serif';
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('WORD GRID', GRID_MARGIN, HEADER_H / 2);

  // Mode pill
  const modeText  = hardMode ? 'HARD' : 'NORMAL';
  const modeColor = hardMode ? THEME.modeHard : THEME.modeNormal;
  const titleW    = ctx.measureText('WORD GRID').width;
  const pillX     = GRID_MARGIN + titleW + 12;
  const pillY     = HEADER_H / 2;
  const pillW     = 70;
  const pillH     = 22;

  ctx.fillStyle = modeColor + '30';
  roundRect(ctx, pillX, pillY - pillH / 2, pillW, pillH, pillH / 2);
  ctx.fill();

  ctx.strokeStyle = modeColor;
  ctx.lineWidth   = 1;
  roundRect(ctx, pillX, pillY - pillH / 2, pillW, pillH, pillH / 2);
  ctx.stroke();

  ctx.fillStyle    = modeColor;
  ctx.font         = 'bold 11px Arial, sans-serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(modeText, pillX + pillW / 2, pillY);

  // Progress counter (right-aligned)
  ctx.fillStyle    = THEME.wordPending;
  ctx.font         = '14px Arial, sans-serif';
  ctx.textAlign    = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${found} / ${total} found`, canvasW - GRID_MARGIN, HEADER_H / 2);

  // Accent divider
  ctx.strokeStyle = THEME.accent;
  ctx.lineWidth   = 1.5;
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.moveTo(GRID_MARGIN, HEADER_H - 1);
  ctx.lineTo(canvasW - GRID_MARGIN, HEADER_H - 1);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Draws all cell backgrounds and grid lines. */
function drawCells(ctx, grid, rows, cols, ox, oy) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = ox + c * (CELL_SIZE + CELL_GAP);
      const y = oy + r * (CELL_SIZE + CELL_GAP);

      ctx.fillStyle = THEME.cellBg;
      roundRect(ctx, x, y, CELL_SIZE, CELL_SIZE, 6);
      ctx.fill();

      ctx.strokeStyle = THEME.cellBorder;
      ctx.lineWidth   = 1;
      roundRect(ctx, x, y, CELL_SIZE, CELL_SIZE, 6);
      ctx.stroke();
    }
  }
}

/**
 * Draws a single pill highlight spanning an array of positions.
 * Supports horizontal, vertical, and diagonal directions.
 *
 * The pill is a single rounded capsule that stretches from the first
 * cell's centre to the last cell's centre, rotated to match direction.
 */
function drawPillHighlight(ctx, positions, ox, oy, color) {
  if (!positions || positions.length < 1) return;

  const first = positions[0];
  const last  = positions[positions.length - 1];

  const x1 = ox + first.col * (CELL_SIZE + CELL_GAP);
  const y1 = oy + first.row * (CELL_SIZE + CELL_GAP);

  const x2 = ox + last.col * (CELL_SIZE + CELL_GAP);
  const y2 = oy + last.row * (CELL_SIZE + CELL_GAP);

  const dx = Math.sign(last.col - first.col);
  const dy = Math.sign(last.row - first.row);

  const length = positions.length;

  // FULL block size (important)
  const width  = (dx !== 0 ? length : 1) * CELL_SIZE + (dx !== 0 ? (length - 1) * CELL_GAP : 0);
  const height = (dy !== 0 ? length : 1) * CELL_SIZE + (dy !== 0 ? (length - 1) * CELL_GAP : 0);

  const startX = Math.min(x1, x2);
  const startY = Math.min(y1, y2);

  const padding = 6;
  const radius  = 18;

  ctx.save();

  // ✨ transparent fill (NO glow)
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = color;

  roundRect(
    ctx,
    startX + padding,
    startY + padding,
    width - padding * 2,
    height - padding * 2,
    radius
  );

  ctx.fill();

  ctx.restore();
}

/** Draws all letters. Letters on highlighted cells use the pill-text colour. */
function drawLetters(ctx, grid, rows, cols, ox, oy, highlights) {
  // Build a set of highlighted cell keys for quick lookup
  const highlightedCells = new Set();
  for (const h of highlights) {
    for (const p of h.positions) {
      highlightedCells.add(`${p.row},${p.col}`);
    }
  }

  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.font         = `bold ${Math.round(CELL_SIZE * 0.44)}px Arial, sans-serif`;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = ox + c * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2;
      const y = oy + r * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2;

      const onPill     = highlightedCells.has(`${r},${c}`);
      ctx.fillStyle = onPill ? THEME.letterOnPill : THEME.letterDefault;
      ctx.shadowColor  = onPill ? 'rgba(0,0,0,0.6)' : 'transparent';
      ctx.shadowBlur   = onPill ? 8 : 0;

      ctx.fillText(grid[r][c], x, y);
    }
  }
  ctx.shadowBlur  = 0;
  ctx.shadowColor = 'transparent';
}

/** Draws the word chip list below the grid. */
function drawWordList(ctx, words, placements, foundWords, ox, startY, gridW) {
  if (!words.length) return;

  // Section label
  ctx.fillStyle    = THEME.wordPending;
  ctx.font         = 'bold 11px Arial, sans-serif';
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('WORDS TO FIND', ox, startY + 9);

  const chipW   = Math.floor((gridW - (WORDS_COLS - 1) * 8) / WORDS_COLS);
  const chipH   = WORD_ROW_H - 8;
  const labelY  = startY + 18;

  words.forEach((word, i) => {
    const col   = i % WORDS_COLS;
    const row   = Math.floor(i / WORDS_COLS);
    const chipX = ox + col * (chipW + 8);
    const chipY = labelY + row * WORD_ROW_H;
    const found = foundWords.includes(word);

    const highlightIdx = placements.findIndex(p => p.word === word);
const chipColor = found
  ? PILL_PALETTE[highlightIdx % PILL_PALETTE.length].replace('cc', '88')
  : null;

    // Chip background
    if (found) {
  const gradient = ctx.createLinearGradient(
    chipX,
    chipY,
    chipX + chipW,
    chipY
  );

  gradient.addColorStop(0, chipColor);
  gradient.addColorStop(1, chipColor);

  ctx.fillStyle = gradient;

  ctx.shadowColor = chipColor;
  ctx.shadowBlur = 14;

  roundRect(ctx, chipX, chipY, chipW, chipH, chipH / 2); // full pill
  ctx.fill();

  ctx.shadowBlur = 0;
} else {
  ctx.fillStyle = '#ffffff08';
  roundRect(ctx, chipX, chipY, chipW, chipH, 8);
  ctx.fill();
}

    // Chip border
    ctx.strokeStyle = found ? chipColor : THEME.cellBorder;
    ctx.lineWidth   = found ? 1.5 : 1;
    roundRect(ctx, chipX, chipY, chipW, chipH, 8);
    ctx.stroke();

    // ✅ FIXED TEXT LOGIC
    const textX = chipX + chipW / 2;
    const textY = chipY + chipH / 2;

    const hint = word[0] + '_'.repeat(word.length - 1);
    const displayText = found ? word : hint;

    ctx.fillStyle = found ? '#ffffff' : THEME.wordPending;
    ctx.font = found ? 'bold 13px Arial, sans-serif' : '13px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillText(`${displayText} (${word.length})`, textX, textY);

    // Strikethrough for found words
    if (found) {
      const tw = ctx.measureText(word).width;
      ctx.strokeStyle = chipColor;
      ctx.lineWidth   = 1.5;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(textX - tw / 2, textY);
      ctx.lineTo(textX + tw / 2, textY);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  });
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/** Draws a rounded rectangle path (no fill/stroke — caller decides). */
function roundRect(ctx, x, y, w, h, r = 6) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y,     x + w, y + r,     r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x,     y + h, x,     y + h - r, r);
  ctx.lineTo(x,     y + r);
  ctx.arcTo(x,     y,     x + r, y,          r);
  ctx.closePath();
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { generateGridImage, buildHighlights, PILL_PALETTE };

/*
 * ─── USAGE EXAMPLE ───────────────────────────────────────────────────────────
 *
 * // In your Discord command:
 * const { generateGridImage } = require('./gridRenderer');
 * const { AttachmentBuilder }  = require('discord.js');
 *
 * const buffer     = generateGridImage(grid, words, placements, foundWords, hardMode);
 * const attachment = new AttachmentBuilder(buffer, { name: 'grid.png' });
 *
 * await interaction.reply({ files: [attachment] });
 *
 * // foundWords format (auto-resolved from placements internally):
 * // foundWords = ['APPLE', 'STORM']   ← just an array of word strings
 *
 * // If you want to pass highlights manually (advanced):
 * // const { buildHighlights } = require('./gridRenderer');
 * // const highlights = buildHighlights(placements, foundWords);
 * // highlights === [
 * //   { word: 'APPLE', positions: [{row:0,col:0}, ...], color: '#5b8af580' },
 * //   { word: 'STORM', positions: [{row:2,col:1}, ...], color: '#f472b680' },
 * // ]
 */
