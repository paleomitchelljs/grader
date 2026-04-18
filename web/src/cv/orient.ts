/**
 * Page orientation correction.
 *
 * If the anchor circles end up near the top of the page (same row as the top
 * corner squares), the sheet is oriented correctly. If they're near the
 * bottom, the sheet is upside-down and must be rotated 180°.
 *
 * Ports omr_scanner.py :: orient_image().
 */

import { cv } from './opencv-loader';

type CandidateLike = { cx: number; cy: number; fill: number; circularity: number };

function findBasicCandidates(imageData: ImageData): { corners: CandidateLike[]; anchors: CandidateLike[] } {
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

    const corners: CandidateLike[] = [];
    const anchors: CandidateLike[] = [];

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

      const withinBand = cy > 0.10 * h && cy < 0.90 * h;
      if (!withinBand) continue;
      if (fill <= 0.65 || aspect >= 1.5 || rect.width >= 40 || rect.height >= 40) continue;

      const entry: CandidateLike = { cx, cy, fill, circularity };
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
 * Rotate an ImageData 180° in place (returns a fresh ImageData).
 */
function rotate180(imageData: ImageData): ImageData {
  const w = imageData.width;
  const h = imageData.height;
  const src = imageData.data;
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const di = ((h - 1 - y) * w + (w - 1 - x)) * 4;
      out[di] = src[si]!;
      out[di + 1] = src[si + 1]!;
      out[di + 2] = src[si + 2]!;
      out[di + 3] = src[si + 3]!;
    }
  }
  return new ImageData(out, w, h);
}

export type OrientResult = { image: ImageData; orientationDetected: boolean };

/**
 * Detect orientation from fiducial markers; rotate 180° if the sheet is upside-down.
 */
export function orientImage(imageData: ImageData): OrientResult {
  const h = imageData.height;
  const { corners, anchors } = findBasicCandidates(imageData);

  if (corners.length >= 2 && anchors.length >= 3) {
    const top2 = corners.slice(0, 2);
    const topCornerY = (top2[0]!.cy + top2[1]!.cy) / 2;

    // Find the tightest cluster of 3 anchors (they share a row).
    const byCy = [...anchors].sort((a, b) => a.cy - b.cy);
    let bestGroup = byCy.slice(0, 3);
    if (byCy.length > 3) {
      let bestSpread = Math.max(...bestGroup.map(a => a.cy)) - Math.min(...bestGroup.map(a => a.cy));
      for (let i = 1; i <= byCy.length - 3; i++) {
        const group = byCy.slice(i, i + 3);
        const spread = group[group.length - 1]!.cy - group[0]!.cy;
        if (spread < bestSpread) {
          bestSpread = spread;
          bestGroup = group;
        }
      }
    }
    const anchorMeanY = bestGroup.reduce((s, a) => s + a.cy, 0) / 3;

    const anchorsNearTop = Math.abs(anchorMeanY - topCornerY) < 0.08 * h;
    const anchorsInBottomHalf = anchorMeanY > h * 0.5;

    if (anchorsNearTop && !anchorsInBottomHalf) {
      return { image: imageData, orientationDetected: true };
    }
    if (anchorsInBottomHalf) {
      return { image: rotate180(imageData), orientationDetected: true };
    }
  }

  return { image: imageData, orientationDetected: false };
}
