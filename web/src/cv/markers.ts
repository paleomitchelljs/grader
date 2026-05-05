/**
 * Fiducial marker detection.
 *
 * Ports omr_scanner.py :: _find_marker_candidates() and detect_sheet_markers()
 * to OpenCV.js. The sheet has:
 *   - 4 solid-black corner squares at the corners of the reading area
 *     (~27×28 px at 200 DPI; low circularity, high fill)
 *   - 3 solid-black anchor circles, one above the "a" bubble in each column
 *     (~30×31 px at 200 DPI; high circularity)
 *
 * The function that detects them is stingy on purpose — it rejects unfilled
 * bubbles (too large), text glyphs (too small), and QR code cells (outside
 * the reading-area band).
 */

import { cv } from './opencv-loader';
import type { Markers, SheetConfig } from '../types';

type Candidate = {
  cx: number;
  cy: number;
  width: number;
  height: number;
  circularity: number;
  fill: number;
};

// Fiducial geometry from latex/bubble_sheet_body.tex on a 210mm-wide A4 page.
// Filters are expressed in fractions of image width so detection works at any
// scan DPI without retuning. Corners are 3.5mm squares (1.67% of W); anchor
// circles are 3.7mm in diameter (1.76% of W). The window covers both because
// they go through the same candidate list and are split downstream by shape.
const A4_WIDTH_MM = 210;
const FIDUCIAL_NOMINAL_MM = 3.6;
const FIDUCIAL_SIDE_MIN_FRAC = 0.6 * FIDUCIAL_NOMINAL_MM / A4_WIDTH_MM;  // ~1.0% of W
const FIDUCIAL_SIDE_MAX_FRAC = 1.8 * FIDUCIAL_NOMINAL_MM / A4_WIDTH_MM;  // ~3.1% of W
const FIDUCIAL_AREA_MIN_FACTOR = 0.35;  // vs π·(side/2)² of nominal
const FIDUCIAL_AREA_MAX_FACTOR = 2.5;

function findMarkerCandidates(imageData: ImageData): { corners: Candidate[]; anchors: Candidate[] } {
  const w = imageData.width;
  const h = imageData.height;
  const minSide = FIDUCIAL_SIDE_MIN_FRAC * w;
  const maxSide = FIDUCIAL_SIDE_MAX_FRAC * w;
  const nominalSidePx = (FIDUCIAL_NOMINAL_MM / A4_WIDTH_MM) * w;
  const nominalArea = Math.PI * (nominalSidePx / 2) * (nominalSidePx / 2);
  const minArea = FIDUCIAL_AREA_MIN_FACTOR * nominalArea;
  const maxArea = FIDUCIAL_AREA_MAX_FACTOR * nominalArea;

  const src = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  const binary = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    // Otsu adapts to scan brightness; the previous fixed cutoff at 60 missed
    // markers on slightly underexposed pages even when the same content
    // rendered at a different DPI was fine.
    cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
    cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const corners: Candidate[] = [];
    const anchors: Candidate[] = [];

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < minArea || area > maxArea) { cnt.delete(); continue; }

      const rect = cv.boundingRect(cnt);
      const cx = rect.x + Math.floor(rect.width / 2);
      const cy = rect.y + Math.floor(rect.height / 2);
      const longSide = Math.max(rect.width, rect.height);
      const shortSide = Math.max(Math.min(rect.width, rect.height), 1);
      const aspect = longSide / shortSide;
      const fill = area / (rect.width * rect.height);
      const perim = cv.arcLength(cnt, true);
      const circularity = perim > 0 ? (4 * Math.PI * area) / (perim * perim) : 0;
      cnt.delete();

      const withinBand = cy > 0.10 * h && cy < 0.90 * h;
      if (!withinBand) continue;
      if (fill <= 0.65 || aspect >= 1.5) continue;
      if (rect.width < minSide || rect.width > maxSide) continue;
      if (rect.height < minSide || rect.height > maxSide) continue;

      const entry: Candidate = { cx, cy, width: rect.width, height: rect.height, circularity, fill };
      if (circularity < 0.82 && fill > 0.80) corners.push(entry);
      else if (circularity > 0.82) anchors.push(entry);
    }

    corners.sort((a, b) => a.cy - b.cy);
    anchors.sort((a, b) => a.cy - b.cy);
    return { corners, anchors };
  } finally {
    src.delete();
    gray.delete();
    binary.delete();
    contours.delete();
    hierarchy.delete();
  }
}

/**
 * Count the column-anchor circles in the page header. Used to pick between
 * sheet layouts (3 → 50q, 4 → 100q) before the rest of the pipeline locks in
 * a config. Returns null if we can't find a confident header cluster.
 *
 * Rule of thumb: anchors live ~5mm below TL; the next things below them
 * (row 1 bubbles) are ~7mm further down. At 200 DPI that's ~55px, so a 30px
 * y-tolerance reliably isolates the anchor row.
 */
export function detectColumnCount(imageData: ImageData): number | null {
  const { anchors } = findMarkerCandidates(imageData);
  if (anchors.length < 3) return null;
  const sorted = [...anchors].sort((a, b) => a.cy - b.cy);
  const topY = sorted[0].cy;
  const tolerance = 0.015 * imageData.height; // ~30px at h≈2000
  const headerRow = sorted.filter(a => Math.abs(a.cy - topY) < tolerance);
  if (headerRow.length < 3) return null;
  return headerRow.length;
}

/**
 * Detect fiducial markers on a page. Returns null if fewer than 2 top corners
 * or numColumns anchor circles were found — the caller should fall back to
 * config fractions in that case.
 */
export function detectSheetMarkers(imageData: ImageData, config: SheetConfig): Markers | null {
  const h = imageData.height;
  const numColumns = config.numColumns;
  const { corners, anchors } = findMarkerCandidates(imageData);
  if (corners.length < 2 || anchors.length < numColumns) {
    console.warn('[grader] marker detection failed', {
      imageHeight: h,
      cornersFound: corners.length,
      anchorsFound: anchors.length,
      cornerSample: corners.slice(0, 4).map(c => ({ cx: c.cx, cy: c.cy, w: c.width, h: c.height, fill: +c.fill.toFixed(2), circ: +c.circularity.toFixed(2) })),
      anchorSample: anchors.slice(0, 6).map(a => ({ cx: a.cx, cy: a.cy, w: a.width, h: a.height, fill: +a.fill.toFixed(2), circ: +a.circularity.toFixed(2) })),
    });
    return null;
  }

  // Top two corners by cy.
  const topCorners = [...corners.slice(0, 2)].sort((a, b) => a.cx - b.cx);
  const [tl, tr] = topCorners;
  if (!tl || !tr) return null;
  const topYMean = (tl.cy + tr.cy) / 2;

  // Bottom corners (largest cy); tolerate one missing.
  const bottomCorners = [...corners.slice(-2)].sort((a, b) => a.cx - b.cx);
  let bl: Candidate | null = bottomCorners[0] ?? null;
  let br: Candidate | null = bottomCorners[1] ?? null;
  // Corners need to be well below the top (>30% of height).
  const bottomThreshold = topYMean + 0.3 * h;
  if (bl && bl.cy <= bottomThreshold) bl = null;
  if (br && br.cy <= bottomThreshold) br = null;

  let blY: number;
  if (bl) {
    blY = bl.cy;
  } else if (br) {
    // BL is below col-1 Q17; BR is below col-3 Q50 (one row earlier).
    // Estimated offset: ~69 px at h=2200, scaled to current height.
    blY = br.cy + 69.0 * (h / 2200);
  } else {
    return null;
  }

  // Anchors near the top corners (same header row), left-to-right by cx.
  // Window scales with image height — corner-to-anchor offset is ~5mm and
  // we need to capture it without bleeding into row 1 (~12mm below corner).
  const headerWindow = 0.025 * h;
  const topAnchors = anchors
    .filter(a => Math.abs(a.cy - topYMean) < headerWindow)
    .sort((a, b) => a.cx - b.cx)
    .slice(0, numColumns);
  if (topAnchors.length < numColumns) return null;

  return {
    tl: [tl.cx, tl.cy],
    tr: [tr.cx, tr.cy],
    bl: bl ? [bl.cx, bl.cy] : null,
    br: br ? [br.cx, br.cy] : null,
    blY,
    anchors: topAnchors.map(a => [a.cx, a.cy] as const),
  };
}
