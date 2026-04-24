/**
 * Page orientation detection.
 *
 * Finds the 4 corner fiducials, then compares mean darkness in the strip
 * *above* the top-corner row against the strip *below* the bottom-corner
 * row. The template has a header (title + name field + student handwriting)
 * above the top fiducials and nothing below the bottom fiducials, so
 * "where's the ink" is a stable orientation signal that doesn't depend on
 * detecting the small anchor circles (which previously triggered spurious
 * flips when the old anchor-cluster heuristic locked onto heavily-marked
 * bubbles in the bottom half of the page).
 *
 * Errs conservatively: if the signal is weak (tightly cropped scan, blank
 * name field, etc.) we return the image unchanged rather than guess. A
 * missed flip is recoverable via manual editing; a wrong flip silently
 * grades the student against the wrong bubbles.
 */

import { findFourCorners } from './corners';

/**
 * Minimum strip height (pixels) above top corners / below bottom corners for
 * the density comparison to be trustworthy. At 200 DPI the template has a
 * ~55mm margin above the top corners (~433 px), so a healthy threshold is
 * well under that.
 */
const MIN_STRIP_HEIGHT = 50;

/**
 * Ratio threshold: the darker side must beat the lighter side by this
 * factor before we commit to a flip. Header text + name line comfortably
 * clear this on real sheets; ambient scanner noise does not.
 */
const DARKNESS_RATIO_THRESHOLD = 1.8;

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

function meanDarkness(imageData: ImageData, y1: number, y2: number): number {
  const w = imageData.width;
  const d = imageData.data;
  const yStart = Math.max(0, Math.floor(y1));
  const yEnd = Math.min(imageData.height, Math.ceil(y2));
  if (yEnd <= yStart) return 0;

  let sum = 0;
  let count = 0;
  for (let y = yStart; y < yEnd; y++) {
    const rowOff = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = rowOff + x * 4;
      // Rec. 601 luma; darkness = 255 - luma.
      const luma = (d[i]! * 299 + d[i + 1]! * 587 + d[i + 2]! * 114 + 500) / 1000 | 0;
      sum += 255 - luma;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

export type OrientResult = { image: ImageData; orientationDetected: boolean };

export function orientImage(imageData: ImageData): OrientResult {
  const corners = findFourCorners(imageData);
  if (!corners) {
    console.warn('[grader] orient: 4 corners not found — leaving orientation unchanged');
    return { image: imageData, orientationDetected: false };
  }

  const ys = corners.map(c => c[1]);
  const topY = Math.min(...ys);
  const bottomY = Math.max(...ys);

  const aboveStrip = topY;
  const belowStrip = imageData.height - bottomY;
  if (aboveStrip < MIN_STRIP_HEIGHT || belowStrip < MIN_STRIP_HEIGHT) {
    console.warn('[grader] orient: strips too thin for density check', {
      aboveStrip: +aboveStrip.toFixed(0), belowStrip: +belowStrip.toFixed(0),
    });
    return { image: imageData, orientationDetected: false };
  }

  const aboveDarkness = meanDarkness(imageData, 0, topY);
  const belowDarkness = meanDarkness(imageData, bottomY, imageData.height);

  const correct = aboveDarkness > DARKNESS_RATIO_THRESHOLD * belowDarkness;
  const flipped = belowDarkness > DARKNESS_RATIO_THRESHOLD * aboveDarkness;

  console.info('[grader] orient: ink density check', {
    topY: +topY.toFixed(0), bottomY: +bottomY.toFixed(0),
    aboveDarkness: +aboveDarkness.toFixed(2),
    belowDarkness: +belowDarkness.toFixed(2),
    ratio: +(Math.max(aboveDarkness, belowDarkness) / Math.max(1e-3, Math.min(aboveDarkness, belowDarkness))).toFixed(2),
    decision: correct ? 'keep' : flipped ? 'flip' : 'ambiguous',
  });

  if (correct) return { image: imageData, orientationDetected: true };
  if (flipped) return { image: rotate180(imageData), orientationDetected: true };
  return { image: imageData, orientationDetected: false };
}
