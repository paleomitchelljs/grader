/**
 * Draw the answer overlay on a page image.
 *
 * Green open rings go on the key's correct answers; red filled dots go on
 * what the student (or grader, post-edit) has marked. Ports
 * omr_scanner.py :: create_answer_overlay().
 *
 * Returns a Canvas with the page image + overlay drawn on top. The Canvas
 * is usable for further drawing (e.g. hit-testing clicks to toggle bubbles)
 * or for export to PNG/PDF.
 */

import type { AnswerKey, AnswersByQuestion, GridParams, SheetConfig } from '../types';
import { choiceLetter } from '../types';

export type BubbleHit = {
  /** 1-indexed question number this bubble belongs to. */
  qNum: number;
  /** Lowercase letter ("a", "b", ...). */
  letter: string;
  /** Centre X in image coordinates. */
  x: number;
  /** Centre Y in image coordinates. */
  y: number;
  /** Radius in image coordinates — use for hit-testing clicks. */
  r: number;
};

export type OverlayResult = {
  canvas: HTMLCanvasElement;
  /** All bubble positions — use to convert a click to a qNum/letter pair. */
  bubbles: BubbleHit[];
};

export function renderOverlay(opts: {
  image: ImageData | ImageBitmap;
  gridParams: GridParams;
  config: SheetConfig;
  key: AnswerKey | null;
  studentAnswers: AnswersByQuestion;
}): OverlayResult {
  const { image, gridParams, config, key, studentAnswers } = opts;
  const width = image.width;
  const height = image.height;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  // Base image
  if (image instanceof ImageData) {
    ctx.putImageData(image, 0, 0);
  } else {
    ctx.drawImage(image, 0, 0);
  }

  const maxRows = Math.max(...config.columns.map(([a, b]) => b - a + 1));
  const rowHeight = maxRows > 1 ? (gridParams.bottomY - gridParams.topY) / (maxRows - 1) : 0;

  const bubbles: BubbleHit[] = [];

  for (let colIdx = 0; colIdx < config.columns.length; colIdx++) {
    const [qStart, qEnd] = config.columns[colIdx]!;
    const numQs = qEnd - qStart + 1;
    const [colLeft, colRight] = gridParams.colBounds[colIdx]!;
    const colWidth = colRight - colLeft;

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
      const correct = key?.get(qNum);
      const detected = studentAnswers.get(qNum);

      choiceXs.forEach((x, c) => {
        const letter = choiceLetter(c);

        // Red filled dot for detected answers.
        if (detected?.has(letter)) {
          ctx.beginPath();
          ctx.fillStyle = 'rgba(220, 30, 30, 0.9)';
          ctx.arc(x, y, 6, 0, Math.PI * 2);
          ctx.fill();
        }

        // Green open ring for correct answers (drawn on top).
        if (correct?.has(letter)) {
          ctx.beginPath();
          ctx.strokeStyle = 'rgba(0, 180, 0, 0.95)';
          ctx.lineWidth = 2.5;
          ctx.arc(x, y, 12, 0, Math.PI * 2);
          ctx.stroke();
        }

        bubbles.push({ qNum, letter, x, y, r: Math.max(config.bubbleRadius, 14) });
      });
    }
  }

  return { canvas, bubbles };
}
