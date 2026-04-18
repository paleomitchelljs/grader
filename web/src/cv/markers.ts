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
import type { Markers } from '../types';

type Candidate = {
  cx: number;
  cy: number;
  width: number;
  height: number;
  circularity: number;
  fill: number;
};

function findMarkerCandidates(imageData: ImageData): { corners: Candidate[]; anchors: Candidate[] } {
  const h = imageData.height;
  const src = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  const binary = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.threshold(gray, binary, 60, 255, cv.THRESH_BINARY_INV);
    cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const corners: Candidate[] = [];
    const anchors: Candidate[] = [];

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < 300 || area > 1200) { cnt.delete(); continue; }

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

      // Exclude only the extreme margins — real fiducial corners on a
      // tightly-cropped scan can sit at 3-4% of the height.
      const withinBand = cy > 0.02 * h && cy < 0.98 * h;
      if (!withinBand) continue;
      if (fill <= 0.65 || aspect >= 1.5 || rect.width >= 40 || rect.height >= 40) continue;

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
 * Detect fiducial markers on a page. Returns null if fewer than 2 top corners
 * or 3 anchor circles were found — the caller should fall back to config
 * fractions in that case.
 */
export function detectSheetMarkers(imageData: ImageData): Markers | null {
  const h = imageData.height;
  const { corners, anchors } = findMarkerCandidates(imageData);
  if (corners.length < 2 || anchors.length < 3) {
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
  const topAnchors = anchors
    .filter(a => Math.abs(a.cy - topYMean) < 50)
    .sort((a, b) => a.cx - b.cx)
    .slice(0, 3);
  if (topAnchors.length < 3) return null;

  return {
    tl: [tl.cx, tl.cy],
    tr: [tr.cx, tr.cy],
    bl: bl ? [bl.cx, bl.cy] : null,
    br: br ? [br.cx, br.cy] : null,
    blY,
    anchors: topAnchors.map(a => [a.cx, a.cy] as const),
  };
}
