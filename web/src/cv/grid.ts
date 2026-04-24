/**
 * Compute calibrated bubble-grid parameters.
 *
 * Uses fiducial markers when supplied; falls back to SheetConfig fractions
 * otherwise. Ports omr_scanner.py :: _compute_grid_params(). Marker detection
 * itself now lives in rectify.ts — by the time grid.ts sees the image it's
 * already been perspective-unwarped so the fixed ratios below hold exactly.
 */

import type { GridParams, Markers, SheetConfig } from '../types';

/**
 * Both constants are fractions of the TL–TR horizontal span (hSpan). After
 * rectification (see rectify.ts) the page is axis-aligned with the template's
 * exact aspect, so these ratios hold regardless of scan rotation or scale.
 * Calibrated from the 2026 blank sheet at 200 DPI where hSpan ≈ 1387 px:
 *   bubble pitch ≈ 59 px  →  59 / 1387 ≈ 0.0425
 *   row height   ≈ 69 px  →  ratio 0.04831 (matches the Python source)
 */
const BUBBLE_X_PITCH_RATIO = 59.0 / 1387.0;
const ROW_HEIGHT_RATIO = 0.04831;

export function computeGridParams(
  imageData: ImageData,
  markers: Markers | null,
  config: SheetConfig,
): GridParams {
  const h = imageData.height;
  const w = imageData.width;

  if (markers) {
    const anchorY = markers.anchors.reduce((s, a) => s + a[1], 0) / markers.anchors.length;
    const hSpan = markers.tr[0] - markers.tl[0];
    const rowHeight = ROW_HEIGHT_RATIO * hSpan;

    // Row 0 center sits 1 row below the anchor; last row = 17 rows below.
    const topY = Math.round(anchorY + rowHeight);
    const bottomY = Math.round(anchorY + 17 * rowHeight);

    const pitch = BUBBLE_X_PITCH_RATIO * hSpan;
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
