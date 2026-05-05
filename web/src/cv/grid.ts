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
 *
 * Tuned for the 2026 redesign where the LaTeX template uses 6mm bubble pitch
 * and 7mm row height on a 180mm hSpan, giving the tighter scantron-style
 * grid. The matching constants in latex/bubble_sheet_body.tex (\XPitch and
 * \RowHeight) and in rectify.ts must move together with these.
 */
const BUBBLE_X_PITCH_RATIO = 6.0 / 180.0;
const ROW_HEIGHT_RATIO = 7.0 / 180.0;

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

    // Row 0 center sits 1 row below the anchor; last row = maxRows rows below
    // (17 for 50q/3col, 25 for 100q/4col, etc.).
    const maxRows = Math.max(...config.columns.map(([a, b]) => b - a + 1));
    const topY = Math.round(anchorY + rowHeight);
    const bottomY = Math.round(anchorY + maxRows * rowHeight);

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
