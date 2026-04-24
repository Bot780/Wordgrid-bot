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
 *
 * FIXES APPLIED:
 *  - isLight / THEME are now LOCAL to generateGridImage (not module-level).
 *    A new optional `isLight` parameter lets the caller pass the per-game theme
 *    decided in startGame(), so every image for the same game looks identical.
 *    If omitted, a fresh random roll is used (safe fallback).
 *  - LIGHT_THEME / DARK_THEME are named module-level constants so they are easy
 *    to edit without touching function bodies.
 *  - buildHighlights accepts isLight so alpha is applied correctly per theme.
 *  - drawPillHighlight / drawLetters / drawWordList all receive isLight + theme
 *    as explicit parameters — no more implicit globals.
 *  - Found-word chip text uses THEME.letterOnPill (always black or white) so it
 *    is never the same colour as the pill background.
 *  - Chip background now uses globalAlpha=0.9 so the solid pill colour does not
 *    obliterate the text sitting on top.
 *  - buildHighlights word-lookup is case-insensitive (h.word vs found-word).
 *  - drawWordList section label uses theme titleColor (not hard-coded black/white).
 */

'use strict';

const { createCanvas } = require('@napi-rs/canvas');

// ─── Theme constants ──────────────────────────────────────────────────────────
// Edit colours here; logic below never needs changing for theme tweaks.

const LIGHT_THEME = {
  bg:            '#ffffff',
  cellBg:        '#f3f4f6',
  cellBorder:    '#d1d5db',
  letterDefault: '#374151',
  letterOnPill:  '#000000',   // always black on light — guaranteed contrast
  headerBg:      '#ffffff',
  titleColor:    '#111827',
  modeNormal:    '#22c55e',
  modeHard:      '#ef4444',
  wordPending:   '#9ca3af',
  wordFound:     '#111827',
  progressTrack: '#e5e7eb',
  progressFill:  '#22c55e',
  accent:        '#3b82f6',
};

const DARK_THEME = {
  bg:            '#0f0f14',
  cellBg:        '#17171f',
  cellBorder:    '#2a2a40',
  letterDefault: '#9ca3af',
  letterOnPill:  '#ffffff',   // always white on dark — guaranteed contrast
  headerBg:      '#0f0f14',
  titleColor:    '#ffffff',
  modeNormal:    '#4ade80',
  modeHard:      '#f87171',
  wordPending:   '#6b7280',
  wordFound:     '#e2e8f0',
  progressTrack: '#1e1e2e',
  progressFill:  '#4ade80',
  accent:        '#5865f2',
};

// Solid hex pill colours — alpha is added per-render inside buildHighlights
const PILL_PALETTE = [
  '#5b8af5',
  '#f472b6',
  '#4ade80',
  '#fb923c',
  '#a78bfa',
  '#38bdf8',
  '#facc15',
  '#34d399',
  '#f87171',
  '#818cf8',
];

// ─── Layout ───────────────────────────────────────────────────────────────────

const CELL_SIZE   = 54;
const CELL_GAP    = 2;
const GRID_MARGIN = 24;
const HEADER_H    = 64;
const FOOTER_H    = 14;
const WORD_ROW_H  = 44;
const WORDS_COLS  = 4;
const SECTION_GAP = 16;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * generateGridImage
 *
 * @param {string[][]} grid       - 2D array of uppercase letter strings
 * @param {string[]}   words      - full word list for the puzzle
 * @param {object[]}   placements - [{ word, row, col, dr, dc }, ...]
 * @param {string[]}   foundWords - words already found (uppercase)
 * @param {boolean}    hardMode   - affects mode badge colour
 * @param {boolean}    [isLight]  - theme flag; pass session.isLight for consistency.
 *                                  Omit (or pass null) to roll randomly.
 * @returns {Buffer} PNG buffer
 */
function generateGridImage(grid, words, placements, foundWords = [], hardMode = false, isLight = null) {
  if (!grid?.length || !grid[0]?.length) throw new Error('generateGridImage: grid is empty or invalid');
  foundWords = Array.isArray(foundWords) ? foundWords : [];

  // FIX: theme is LOCAL — decided per call, not per module load.
  // If the caller supplies isLight (from session), use it; otherwise roll randomly.
  const themeIsLight = isLight !== null && isLight !== undefined ? Boolean(isLight) : (Math.random() < 0.5);
  const THEME        = themeIsLight ? LIGHT_THEME : DARK_THEME;

  const rows = grid.length;
  const cols = grid[0].length;

  const highlights = buildHighlights(placements, foundWords, themeIsLight);

  // Canvas dimensions
  const gridPixelW = cols * CELL_SIZE + (cols - 1) * CELL_GAP;
  const gridPixelH = rows * CELL_SIZE + (rows - 1) * CELL_GAP;

  const wordRows  = Math.ceil(words.length / WORDS_COLS);
  const wordListH = wordRows > 0 ? SECTION_GAP + 18 + wordRows * WORD_ROW_H + 8 : 0;

  const canvasW = gridPixelW + GRID_MARGIN * 2;
  const canvasH = HEADER_H + gridPixelH + FOOTER_H + wordListH + GRID_MARGIN * 2;

  const canvas = createCanvas(canvasW, canvasH);
  const ctx    = canvas.getContext('2d');

  // 1. Background
  ctx.fillStyle = THEME.bg;
  ctx.fillRect(0, 0, canvasW, canvasH);

  // 2. Header
  drawHeader(ctx, canvasW, hardMode, foundWords.length, words.length, THEME);

  const ox = GRID_MARGIN;
  const oy = HEADER_H + GRID_MARGIN;

  // 3. Cell backgrounds & borders
  drawCells(ctx, rows, cols, ox, oy, THEME);

  // 4. Pill highlights (behind letters)
  for (const h of highlights) {
    drawPillHighlight(ctx, h.positions, ox, oy, h.color, themeIsLight);
  }

  // 5. Letters
  drawLetters(ctx, grid, rows, cols, ox, oy, highlights, THEME, themeIsLight);

  // 6. Word list
  const wordListY = oy + gridPixelH + SECTION_GAP;
  drawWordList(ctx, words, placements, foundWords, highlights, ox, wordListY, gridPixelW, THEME, themeIsLight);

  return canvas.toBuffer('image/png');
}

// ─── buildHighlights ──────────────────────────────────────────────────────────

/**
 * Converts placements + foundWords into highlight descriptor objects.
 *
 * FIX: word lookup is case-insensitive so "news" matches placement "NEWS".
 * FIX: receives themeIsLight so alpha is baked in consistently.
 *
 * @returns {{ word, positions, color, index }[]}
 */
function buildHighlights(placements, foundWords, themeIsLight) {
  if (!Array.isArray(placements) || !Array.isArray(foundWords)) return [];

  return foundWords
    .map((word, idx) => {
      const placement = placements.find(
        p => p.word.toUpperCase() === word.toUpperCase()
      );
      if (!placement) return null;

      const base  = PILL_PALETTE[idx % PILL_PALETTE.length];
      const alpha = themeIsLight ? '99' : 'cc';
      const color = `${base}${alpha}`;

      const positions = [];
      for (let i = 0; i < word.length; i++) {
        positions.push({
          row: placement.row + placement.dr * i,
          col: placement.col + placement.dc * i,
        });
      }

      return { word: word.toUpperCase(), positions, color, index: idx };
    })
    .filter(Boolean);
}

// ─── Drawing Helpers ──────────────────────────────────────────────────────────

function drawHeader(ctx, canvasW, hardMode, found, total, THEME) {
  ctx.fillStyle    = THEME.titleColor;
  ctx.font         = 'bold 22px Arial, sans-serif';
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('WORD GRID', GRID_MARGIN, HEADER_H / 2);

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

  ctx.fillStyle    = THEME.wordPending;
  ctx.font         = '14px Arial, sans-serif';
  ctx.textAlign    = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${found} / ${total} found`, canvasW - GRID_MARGIN, HEADER_H / 2);

  ctx.strokeStyle = THEME.accent;
  ctx.lineWidth   = 1.5;
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.moveTo(GRID_MARGIN, HEADER_H - 1);
  ctx.lineTo(canvasW - GRID_MARGIN, HEADER_H - 1);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawCells(ctx, rows, cols, ox, oy, THEME) {
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
 * Draws per-cell radial glow highlights.
 * FIX: ctx.save/restore inside loop keeps shadow state isolated per cell.
 */
function drawPillHighlight(ctx, positions, ox, oy, color, themeIsLight) {
  if (!positions?.length) return;

  for (const pos of positions) {
    ctx.save();

    const x  = ox + pos.col * (CELL_SIZE + CELL_GAP);
    const y  = oy + pos.row * (CELL_SIZE + CELL_GAP);
    const cx = x + CELL_SIZE / 2;
    const cy = y + CELL_SIZE / 2;

    const gradient    = ctx.createRadialGradient(cx, cy, 4, cx, cy, CELL_SIZE / 1.4);
    const solidColor  = color.length === 9 ? color.slice(0, 7) + 'ff' : color;
    const fadeColor   = color.length === 9 ? color.slice(0, 7) + '00' : color + '00';
    gradient.addColorStop(0, solidColor);
    gradient.addColorStop(1, fadeColor);

    ctx.fillStyle   = gradient;
    ctx.shadowColor = color.slice(0, 7);
    ctx.shadowBlur  = themeIsLight ? 10 : 18;

    roundRect(ctx, x + 3, y + 3, CELL_SIZE - 6, CELL_SIZE - 6, 12);
    ctx.fill();

    ctx.restore();
  }
}

/**
 * Draws all letters on the grid.
 * FIX: uses THEME.letterOnPill / THEME.letterDefault — never hard-coded.
 */
function drawLetters(ctx, grid, rows, cols, ox, oy, highlights, THEME, themeIsLight) {
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
      const x      = ox + c * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2;
      const y      = oy + r * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2;
      const onPill = highlightedCells.has(`${r},${c}`);

      ctx.fillStyle   = onPill ? THEME.letterOnPill : THEME.letterDefault;
      ctx.shadowColor = onPill ? 'rgba(0,0,0,0.35)' : 'transparent';
      ctx.shadowBlur  = onPill ? 6 : 0;

      ctx.fillText(grid[r][c], x, y);

      if (onPill) {
        ctx.strokeStyle = themeIsLight ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.5)';
        ctx.lineWidth   = 1.2;
        ctx.strokeText(grid[r][c], x, y);
      }
    }
  }

  ctx.shadowBlur  = 0;
  ctx.shadowColor = 'transparent';
}

/**
 * Draws the word chip list below the grid.
 *
 * FIX: chip background uses globalAlpha=0.9 so the pill colour doesn't
 *   completely fill the chip — text on top remains legible.
 * FIX: text colour for found words is always THEME.letterOnPill (black or
 *   white) — never the pill colour itself (which caused invisible text).
 * FIX: word lookup for highlight is case-insensitive.
 * FIX: section label uses THEME.titleColor instead of hard-coded black/white.
 */
function drawWordList(ctx, words, placements, foundWords, highlights, ox, wordListY, gridPixelW, THEME, themeIsLight) {
  if (!words.length) return;

  // Section label
  ctx.fillStyle    = THEME.titleColor;
  ctx.font         = 'bold 11px Arial, sans-serif';
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('WORDS TO FIND', ox, wordListY + 9);

  const chipW  = Math.floor((gridPixelW - (WORDS_COLS - 1) * 8) / WORDS_COLS);
  const chipH  = WORD_ROW_H - 6;
  const labelY = wordListY + 22;

  words.forEach((word, i) => {
    // Case-insensitive found check
    const found     = foundWords.some(f => f.toUpperCase() === word.toUpperCase());
    const col       = i % WORDS_COLS;
    const row       = Math.floor(i / WORDS_COLS);
    const chipX     = ox + col * (chipW + 8);
    const chipY     = labelY + row * WORD_ROW_H;

    // FIX: case-insensitive lookup so highlight chip color always matches grid highlight
    const highlight = highlights.find(h => h.word.toUpperCase() === word.toUpperCase());
    const baseColor = (found && highlight?.color) ? highlight.color.slice(0, 7) : null;

    // ── BACKGROUND ──
    if (found && baseColor) {
      // FIX: use globalAlpha so chip colour doesn't overwhelm the text
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle   = baseColor;
      ctx.shadowColor = baseColor;
      ctx.shadowBlur  = 10;
      roundRect(ctx, chipX, chipY, chipW, chipH, chipH / 2);
      ctx.fill();
      ctx.restore(); // resets globalAlpha and shadow
    } else {
      ctx.fillStyle = themeIsLight ? '#00000008' : '#ffffff08';
      roundRect(ctx, chipX, chipY, chipW, chipH, 8);
      ctx.fill();
    }

    // ── BORDER ──
    ctx.strokeStyle = found && baseColor ? baseColor : THEME.cellBorder;
    ctx.lineWidth   = found ? 1.5 : 1;
    roundRect(ctx, chipX, chipY, chipW, chipH, 8);
    ctx.stroke();

    // ── TEXT ──
    const textX       = chipX + chipW / 2;
    const textY       = chipY + chipH / 2;
    const hint        = word[0] + '_'.repeat(word.length - 1);
    const displayText = found ? word : hint;

    // FIX: THEME.letterOnPill is always black (light) or white (dark) — never the pill colour
    ctx.fillStyle    = found ? THEME.letterOnPill : THEME.titleColor;
    ctx.font         = found ? 'bold 15px Arial, sans-serif' : '14px Arial, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${displayText} (${word.length})`, textX, textY);

    // ── STRIKETHROUGH on found words ──
    if (found) {
      const tw = ctx.measureText(displayText).width;

      ctx.strokeStyle = THEME.letterOnPill;
      ctx.lineWidth   = 1.5;
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.moveTo(textX - tw / 2, textY);
      ctx.lineTo(textX + tw / 2, textY);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  });
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function roundRect(ctx, x, y, w, h, r = 6) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y,      x + w, y + r,      r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h,  x + w - r, y + h,  r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x,      y + h,  x,     y + h - r,  r);
  ctx.lineTo(x,      y + r);
  ctx.arcTo(x,      y,      x + r,  y,          r);
  ctx.closePath();
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  generateGridImage,
  buildHighlights,
  PILL_PALETTE,
  LIGHT_THEME,
  DARK_THEME,
};

