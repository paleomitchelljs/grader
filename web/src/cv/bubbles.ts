/**
 * Bubble-grid sampling.
 *
 * For each expected bubble location (as determined by the grid params),
 * we measure the mean darkness in a small ROI. If it exceeds the fill
 * threshold, that choice counts as selected.
 *
 * No OpenCV needed here — plain Canvas ImageData gives us grayscale pixels
 * directly, and we do the averaging in JS. Matches
 * omr_scanner.py :: analyze_bubble_grid().
 */

import type { AnswersByQuestion, Flag, GridParams, SheetConfig } from '../types';
import { choiceLetter } from '../types';

/** Convert a packed RGBA ImageData to a tight grayscale Uint8Array (no allocations per pixel). */
export function toGrayscale(imageData: ImageData): Uint8Array {
  const d = imageData.data;
  const n = imageData.width * imageData.height;
  const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    // Rec. 601 luma approximation
    out[i] = (d[j]! * 299 + d[j + 1]! * 587 + d[j + 2]! * 114 + 500) / 1000 | 0;
  }
  return out;
}

/** Mean of pixel values inside a rectangular region, clipped to image bounds. */
function meanRegion(gray: Uint8Array, width: number, height: number,
                    xc: number, yc: number, r: number): number {
  const x1 = Math.max(0, xc - r);
  const x2 = Math.min(width, xc + r);
  const y1 = Math.max(0, yc - r);
  const y2 = Math.min(height, yc + r);
  if (x2 <= x1 || y2 <= y1) return 255;
  let sum = 0;
  let count = 0;
  for (let y = y1; y < y2; y++) {
    const rowOff = y * width;
    for (let x = x1; x < x2; x++) {
      sum += gray[rowOff + x]!;
      count++;
    }
  }
  return count > 0 ? sum / count : 255;
}

export type BubbleAnalysis = {
  answers: AnswersByQuestion;
  flags: Flag[];
};

export function analyzeBubbleGrid(
  imageData: ImageData,
  gridParams: GridParams,
  config: SheetConfig,
): BubbleAnalysis {
  const { width, height } = imageData;
  const gray = toGrayscale(imageData);
  const answers: AnswersByQuestion = new Map();
  const flags: Flag[] = [];

  if (!gridParams.markersUsed) {
    flags.push({ message: 'Sheet markers not detected — using default layout config' });
  }

  // Row spacing: number of rows = tallest column. Row 0 at topY, last row at bottomY.
  // Rows are shared across all columns (grid has 17 rows for 50q/3col layout).
  const maxRows = Math.max(...config.columns.map(([a, b]) => b - a + 1));
  const rowHeight = maxRows > 1 ? (gridParams.bottomY - gridParams.topY) / (maxRows - 1) : 0;

  for (let colIdx = 0; colIdx < config.columns.length; colIdx++) {
    const [qStart, qEnd] = config.columns[colIdx]!;
    const numQs = qEnd - qStart + 1;
    const [colLeft, colRight] = gridParams.colBounds[colIdx]!;
    const colWidth = colRight - colLeft;

    // Bubble x-positions per column: marker-based (anchor + pitch) or evenly distributed.
    let choiceXs: number[];
    if (gridParams.anchorXs && gridParams.bubblePitch != null) {
      const ax = gridParams.anchorXs[colIdx]!;
      choiceXs = [];
      for (let c = 0; c < config.numChoices; c++) {
        choiceXs.push(Math.round(ax + c * gridParams.bubblePitch));
      }
    } else {
      choiceXs = [];
      for (let c = 0; c < config.numChoices; c++) {
        choiceXs.push(Math.round(colLeft + colWidth * (c + 0.5) / config.numChoices));
      }
    }

    for (let rowIdx = 0; rowIdx < numQs; rowIdx++) {
      const qNum = qStart + rowIdx;
      const y = Math.round(gridParams.topY + rowHeight * rowIdx);

      // Sample each bubble
      const fillValues: number[] = [];
      for (const x of choiceXs) {
        const mean = meanRegion(gray, width, height, x, y, config.bubbleRadius);
        const darkness = 1 - mean / 255;
        fillValues.push(darkness);
      }

      // Which bubbles are filled?
      const selected = new Set<string>();
      fillValues.forEach((darkness, c) => {
        if (darkness >= config.fillThreshold) selected.add(choiceLetter(c));
      });
      answers.set(qNum, selected);

      const maxFill = Math.max(...fillValues);

      // Flag: faint mark — nothing selected but something approaches the threshold.
      if (selected.size === 0 && maxFill > config.fillThreshold * 0.7) {
        flags.push({
          question: qNum,
          message: `Q${qNum.toString().padStart(2, '0')}: possible faint mark (max darkness ${maxFill.toFixed(2)}, threshold ${config.fillThreshold.toFixed(2)})`,
        });
      }

      // Flag: multiple selections.
      if (selected.size > 1) {
        const letters = [...selected].sort().join('').toUpperCase();
        flags.push({
          question: qNum,
          message: `Q${qNum.toString().padStart(2, '0')}: multiple selections (${letters})`,
        });
      }

      // Flag: ambiguous near-threshold darkness for any choice.
      fillValues.forEach((darkness, c) => {
        if (darkness >= config.fillThreshold * 0.8 && darkness < config.fillThreshold) {
          flags.push({
            question: qNum,
            message: `Q${qNum.toString().padStart(2, '0')}: choice ${choiceLetter(c).toUpperCase()} near threshold (darkness ${darkness.toFixed(2)})`,
          });
        }
      });
    }
  }

  return { answers, flags };
}
