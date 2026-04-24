/**
 * Quadrant-based 4-corner fiducial detection.
 *
 * Each image quadrant contributes its best dark-square candidate, scored by
 * fill + squareness + proximity to the image corner. Resistant to rotation,
 * DPI variation, and partial occlusion because it doesn't depend on any
 * single per-blob filter passing *all four* true corners — each quadrant
 * just picks its best.
 *
 * Shared by rectify.ts (to warp the page) and orient.ts (to identify the
 * top/bottom strips for orientation detection).
 *
 * Corners are returned in IMAGE order: [TL, TR, BR, BL] based on image
 * position, not page-layout semantics. On an upside-down scan these are
 * still the four physical squares — but image-TL is page-BR. Use
 * orient.ts's result first if you need a correctly-oriented image.
 */

import { cv } from './opencv-loader';

const TEMPLATE_WIDTH_MM = 180;
const TEMPLATE_HEIGHT_MM = 160;

export type CornerCandidate = {
  cx: number;
  cy: number;
  fill: number;
  circularity: number;
  maxSide: number;
};

export type CornerQuad = readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
];

export function findCornerCandidates(imageData: ImageData): CornerCandidate[] {
  const src = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  const binary = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const out: CornerCandidate[] = [];
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
    cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      const rect = cv.boundingRect(cnt);
      const maxSide = Math.max(rect.width, rect.height);
      const minSide = Math.max(1, Math.min(rect.width, rect.height));
      const aspect = maxSide / minSide;
      const boxArea = rect.width * rect.height;
      const fill = boxArea > 0 ? area / boxArea : 0;
      const perim = cv.arcLength(cnt, true);
      const circularity = perim > 0 ? (4 * Math.PI * area) / (perim * perim) : 0;
      cnt.delete();

      // Loose filters — geometric selection picks the right ones afterwards.
      // Ranges cover ~150-330 DPI and tolerate mild skew / occlusion.
      if (area < 150 || area > 5000) continue;
      if (maxSide > 90 || minSide < 8) continue;
      if (aspect > 2.2) continue;
      if (fill < 0.5) continue;

      out.push({
        cx: rect.x + rect.width / 2,
        cy: rect.y + rect.height / 2,
        fill, circularity, maxSide,
      });
    }
  } finally {
    src.delete();
    gray.delete();
    binary.delete();
    contours.delete();
    hierarchy.delete();
  }
  return out;
}

export function findFourCorners(imageData: ImageData): CornerQuad | null {
  const w = imageData.width;
  const h = imageData.height;
  const candidates = findCornerCandidates(imageData);
  if (candidates.length < 4) return null;

  // Bucket by image quadrant. Order matches [TL, TR, BR, BL] clockwise.
  const cx = w / 2;
  const cy = h / 2;
  const buckets: CornerCandidate[][] = [[], [], [], []];
  for (const c of candidates) {
    const bottom = c.cy > cy;
    const right = c.cx > cx;
    let idx: number;
    if (!bottom && !right) idx = 0;
    else if (!bottom && right) idx = 1;
    else if (bottom && right) idx = 2;
    else idx = 3;
    buckets[idx]!.push(c);
  }

  const refs: Array<readonly [number, number]> = [[0, 0], [w, 0], [w, h], [0, h]];
  const winners: Array<readonly [number, number] | null> = buckets.map((bucket, i) => {
    if (bucket.length === 0) return null;
    const [refX, refY] = refs[i]!;
    let best = bucket[0]!;
    let bestScore = scoreCornerCandidate(best, refX, refY);
    for (let k = 1; k < bucket.length; k++) {
      const s = scoreCornerCandidate(bucket[k]!, refX, refY);
      if (s > bestScore) { bestScore = s; best = bucket[k]!; }
    }
    return [best.cx, best.cy] as const;
  });

  if (winners.some(w => w === null)) return null;

  const tl = winners[0]!;
  const tr = winners[1]!;
  const br = winners[2]!;
  const bl = winners[3]!;
  if (!isPlausibleRectangle(tl, tr, br, bl)) return null;
  return [tl, tr, br, bl];
}

function scoreCornerCandidate(c: CornerCandidate, refX: number, refY: number): number {
  const dist = Math.hypot(c.cx - refX, c.cy - refY);
  // Solid square's circularity is ~π/4 ≈ 0.785 — penalise deviation.
  const squareness = -Math.abs(c.circularity - Math.PI / 4);
  return 1500 * c.fill + 800 * squareness - dist;
}

function isPlausibleRectangle(
  tl: readonly [number, number],
  tr: readonly [number, number],
  br: readonly [number, number],
  bl: readonly [number, number],
): boolean {
  const hTop = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
  const hBot = Math.hypot(br[0] - bl[0], br[1] - bl[1]);
  const vLeft = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
  const vRight = Math.hypot(br[0] - tr[0], br[1] - tr[1]);

  if (Math.abs(hTop - hBot) / Math.max(hTop, hBot) > 0.25) return false;
  if (Math.abs(vLeft - vRight) / Math.max(vLeft, vRight) > 0.25) return false;

  const aspect = (hTop + hBot) / (vLeft + vRight);
  const expected = TEMPLATE_WIDTH_MM / TEMPLATE_HEIGHT_MM;
  if (aspect < expected * 0.7 || aspect > expected * 1.3) return false;
  return true;
}
