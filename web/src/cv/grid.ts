/**
 * Compute calibrated bubble-grid parameters.
 *
 * Uses fiducial markers when detected; falls back to SheetConfig fractions
 * otherwise. Ports omr_scanner.py :: _compute_grid_params().
 */

import type { GridParams, SheetConfig } from '../types';
import { detectSheetMarkers } from './markers';

const BUBBLE_X_PITCH = 59.0 / 1700.0;   // inter-bubble spacing as fraction of width
/**
 * Row-height as a fraction of the TL–TR horizontal span.
 * Calibrated from the 2026 blank sheet at 200 DPI:
 *   row_height ≈ 69.3 px when TL–TR span ≈ 1387 px  →  ratio ≈ 0.0499
 * The Python source uses 0.04831 — keep them identical.
 */
const ROW_HEIGHT_RATIO = 0.04831;

export function computeGridParams(imageData: ImageData, config: SheetConfig): GridParams {
  const h = imageData.height;
  const w = imageData.width;
  const markers = detectSheetMarkers(imageData);

  if (markers) {
    const anchorY = markers.anchors.reduce((s, a) => s + a[1], 0) / markers.anchors.length;
    const hSpan = markers.tr[0] - markers.tl[0];
    const rowHeight = ROW_HEIGHT_RATIO * hSpan;

    // Row 0 center sits 1 row below the anchor; last row = 17 rows below.
    const topY = Math.round(anchorY + rowHeight);
    const bottomY = Math.round(anchorY + 17 * rowHeight);

    const pitch = BUBBLE_X_PITCH * w;
    const anchorXs = markers.anchors.map(a => a[0]);
    const margin = 0.4 * pitch;
    const colBounds = anchorXs.map(ax => [
      Math.round(ax - margin),
      Math.round(ax + (config.numChoices - 1) * pitch + margin),
    ] as const);

    return {
      topY,
      bottomY,
      colBounds,
      anchorXs,
      bubblePitch: pitch,
      markersUsed: true,
    };
  }

  const topY = Math.round(h * config.fallback.bubbleAreaTop);
  const bottomY = Math.round(h * config.fallback.bubbleAreaBottom);
  const colBounds = config.fallback.colFractions.map(([l, r]) => [
    Math.round(w * l),
    Math.round(w * r),
  ] as const);

  return {
    topY,
    bottomY,
    colBounds,
    anchorXs: null,
    bubblePitch: null,
    markersUsed: false,
  };
}
