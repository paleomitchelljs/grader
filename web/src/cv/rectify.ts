/**
 * Four-point perspective rectification.
 *
 * Detects the 4 corner fiducials via quadrant partitioning (one per quadrant,
 * scored by fill + squareness + proximity to image corner) and warps the page
 * to a rectangle with the template's exact aspect ratio (180mm horizontal,
 * 160mm vertical — see latex/bubble_sheet.tex). After rectification the bubble
 * grid is axis-aligned by construction.
 *
 * Anchor positions (used by grid.ts for per-column bubble placement) are then
 * *computed from template geometry* rather than detected: in canonical coords
 * we know exactly where each anchor should be (5mm below TL, at the column
 * spacing derived from numColumns/numChoices). This removes the original
 * failure mode: per-blob strict filters in markers.ts were rejecting one of
 * the three anchor circles on many real student sheets, causing the whole
 * detection to fall through and the grid to drift.
 *
 * If corner detection can't find 4 good candidates, we fall back to the old
 * detectSheetMarkers path — never worse than today.
 */

import { cv } from './opencv-loader';
import type { Markers, SheetConfig } from '../types';
import { detectSheetMarkers } from './markers';

// Template dimensions (latex/bubble_sheet.tex). Everything canonical is
// derived from these.
const TEMPLATE_WIDTH_MM = 180;            // TL to TR
const TEMPLATE_HEIGHT_MM = 160;           // TL to BL
const TEMPLATE_ANCHOR_Y_OFFSET_MM = 5;    // anchor y = TL_y + 5mm (60mm - 55mm)
const TEMPLATE_TL_X_MM = 15;              // TL's x on the physical page

// Per-column anchor x-positions on the page (mm), matching the tikz source.
// Anchor 1 at 30mm, last anchor at 183 - (numChoices-1)*7.657, evenly spaced.
const TEMPLATE_ANCHOR_X_FIRST_MM = 30;
const TEMPLATE_ANCHOR_X_RIGHT_EDGE_MM = 183;
const TEMPLATE_X_PITCH_MM = 7.657;

export type RectifyResult = {
  imageData: ImageData;
  markers: Markers | null;
  rectified: boolean;
};

type CornerCandidate = {
  cx: number;
  cy: number;
  fill: number;
  circularity: number;
  maxSide: number;
};

export function rectifyPage(imageData: ImageData, config: SheetConfig): RectifyResult {
  const corners = findFourCorners(imageData);
  if (!corners) {
    // Last-ditch: try the old path so we're no worse than before this fix.
    const legacy = detectSheetMarkers(imageData);
    console.warn('[grader] rectify: quadrant corner detection failed, using legacy path', {
      legacyHasTL: !!legacy?.tl, legacyHasTR: !!legacy?.tr,
      legacyHasBL: !!legacy?.bl, legacyHasBR: !!legacy?.br,
      legacyAnchorCount: legacy?.anchors.length ?? 0,
    });
    return { imageData, markers: legacy, rectified: false };
  }

  const [tl, tr, br, bl] = corners;

  // Average the two horizontal edges for canonical width so mild perspective
  // distortion (tl-tr and bl-br differing in length) is absorbed symmetrically.
  const hLenTop = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
  const hLenBottom = Math.hypot(br[0] - bl[0], br[1] - bl[1]);
  const canonicalW = 0.5 * (hLenTop + hLenBottom);
  const canonicalH = canonicalW * (TEMPLATE_HEIGHT_MM / TEMPLATE_WIDTH_MM);

  // Pin canonical TL to the detected TL so page content outside the 4-corner
  // box (name region, header, footer) stays approximately where it was.
  const tlX = tl[0];
  const tlY = tl[1];

  const srcPts = cv.matFromArray(
    4, 1, cv.CV_32FC2,
    [tl[0], tl[1], tr[0], tr[1], br[0], br[1], bl[0], bl[1]],
  );
  const dstPts = cv.matFromArray(
    4, 1, cv.CV_32FC2,
    [
      tlX,              tlY,
      tlX + canonicalW, tlY,
      tlX + canonicalW, tlY + canonicalH,
      tlX,              tlY + canonicalH,
    ],
  );
  const H = cv.getPerspectiveTransform(srcPts, dstPts);
  srcPts.delete();
  dstPts.delete();

  const srcImg = cv.matFromImageData(imageData);
  const dstImg = new cv.Mat();
  const dsize = new cv.Size(imageData.width, imageData.height);
  // White fill for out-of-bounds sampling — otherwise those pixels come back
  // black and could be mistaken for ink by downstream steps.
  cv.warpPerspective(
    srcImg, dstImg, H, dsize,
    cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255),
  );
  const rectifiedData = new ImageData(
    new Uint8ClampedArray(dstImg.data),
    dstImg.cols,
    dstImg.rows,
  );
  srcImg.delete();
  dstImg.delete();
  H.delete();

  const mmToPx = canonicalW / TEMPLATE_WIDTH_MM;
  const anchorY = tlY + TEMPLATE_ANCHOR_Y_OFFSET_MM * mmToPx;
  const anchorXOffsetsMm = templateAnchorXOffsetsMm(config.numColumns, config.numChoices);
  const anchors = anchorXOffsetsMm.map(
    offsetMm => [tlX + offsetMm * mmToPx, anchorY] as const,
  );

  const rectifiedMarkers: Markers = {
    tl: [tlX, tlY],
    tr: [tlX + canonicalW, tlY],
    bl: [tlX, tlY + canonicalH],
    br: [tlX + canonicalW, tlY + canonicalH],
    blY: tlY + canonicalH,
    anchors,
  };

  console.info('[grader] rectify: applied perspective warp', {
    detectedTL: tl, detectedTR: tr, detectedBR: br, detectedBL: bl,
    hLenTop: +hLenTop.toFixed(1), hLenBottom: +hLenBottom.toFixed(1),
    vLenLeft: +Math.hypot(bl[0] - tl[0], bl[1] - tl[1]).toFixed(1),
    vLenRight: +Math.hypot(br[0] - tr[0], br[1] - tr[1]).toFixed(1),
    canonicalW: +canonicalW.toFixed(1),
    canonicalH: +canonicalH.toFixed(1),
    anchorsTemplateMm: anchorXOffsetsMm.map(mm => +mm.toFixed(2)),
    anchorsPx: anchors.map(([x, y]) => [+x.toFixed(1), +y.toFixed(1)]),
  });

  return { imageData: rectifiedData, markers: rectifiedMarkers, rectified: true };
}

/**
 * Column anchor x-positions measured from the template's TL (mm). Matches
 * the derivation in latex/bubble_sheet.tex so we can't disagree silently.
 */
function templateAnchorXOffsetsMm(numColumns: number, numChoices: number): number[] {
  const anchorXLast = TEMPLATE_ANCHOR_X_RIGHT_EDGE_MM - (numChoices - 1) * TEMPLATE_X_PITCH_MM;
  const colSpacing = numColumns > 1
    ? (anchorXLast - TEMPLATE_ANCHOR_X_FIRST_MM) / (numColumns - 1)
    : 0;
  return Array.from({ length: numColumns }, (_, i) =>
    TEMPLATE_ANCHOR_X_FIRST_MM + i * colSpacing - TEMPLATE_TL_X_MM,
  );
}

/**
 * Quadrant-based 4-corner finder: partition candidates by image quadrant,
 * pick the best-scoring corner-like blob in each. Robust because it doesn't
 * depend on a per-blob filter passing *all four* true corners — each quadrant
 * just picks its best. Validates the result forms a plausible rectangle
 * (aspect close to template, opposite edges similar length) before returning.
 */
function findFourCorners(
  imageData: ImageData,
): [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]] | null {
  const w = imageData.width;
  const h = imageData.height;
  const candidates = findCornerCandidates(imageData);
  if (candidates.length < 4) {
    console.warn('[grader] rectify: too few corner candidates', { count: candidates.length });
    return null;
  }

  // Bucket: 0=TL, 1=TR, 2=BR, 3=BL (clockwise — matches the order we pass
  // into getPerspectiveTransform below).
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

  const cornerRefs: Array<readonly [number, number]> = [[0, 0], [w, 0], [w, h], [0, h]];
  const winners: Array<readonly [number, number] | null> = buckets.map((bucket, i) => {
    if (bucket.length === 0) return null;
    const ref = cornerRefs[i]!;
    let best = bucket[0]!;
    let bestScore = scoreCornerCandidate(best, ref[0], ref[1]);
    for (let k = 1; k < bucket.length; k++) {
      const s = scoreCornerCandidate(bucket[k]!, ref[0], ref[1]);
      if (s > bestScore) { bestScore = s; best = bucket[k]!; }
    }
    return [best.cx, best.cy] as const;
  });

  if (winners.some(w => w === null)) {
    console.warn('[grader] rectify: empty quadrant', {
      bucketCounts: buckets.map(b => b.length),
    });
    return null;
  }

  const [tl, tr, br, bl] = winners as [
    readonly [number, number], readonly [number, number],
    readonly [number, number], readonly [number, number],
  ];

  if (!isPlausibleRectangle(tl, tr, br, bl)) {
    console.warn('[grader] rectify: corner quadrilateral failed rectangle sanity check', {
      tl, tr, br, bl,
    });
    return null;
  }
  return [tl, tr, br, bl];
}

/**
 * All contours that *could* be a corner fiducial. Loose filters — we lean on
 * geometric selection afterwards rather than trying to get the filter exactly
 * right for every scan. Ranges cover roughly 150 - 330 DPI and tolerate
 * partial occlusion / mild skew.
 */
function findCornerCandidates(imageData: ImageData): CornerCandidate[] {
  const src = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  const binary = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const out: CornerCandidate[] = [];
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    // Otsu picks a threshold from the histogram, so scanner exposure variation
    // (dim vs crisp blacks) no longer sinks detection.
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

/**
 * Score a candidate as a corner: prefer high fill, square-ish shape (a
 * filled square has circularity ≈ π/4 ≈ 0.785), and proximity to the
 * reference image corner. The weights are tuned so a real corner
 * (fill ~0.95, circ ~0.78, near-corner) beats any plausible student ink
 * scribble by a comfortable margin.
 */
function scoreCornerCandidate(c: CornerCandidate, refX: number, refY: number): number {
  const dist = Math.hypot(c.cx - refX, c.cy - refY);
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

  // Opposite edges should be within ~25% of each other — even mild
  // perspective on a handheld-photographed sheet stays comfortably under this.
  if (Math.abs(hTop - hBot) / Math.max(hTop, hBot) > 0.25) return false;
  if (Math.abs(vLeft - vRight) / Math.max(vLeft, vRight) > 0.25) return false;

  const aspect = (hTop + hBot) / (vLeft + vRight);
  const expected = TEMPLATE_WIDTH_MM / TEMPLATE_HEIGHT_MM;
  if (aspect < expected * 0.7 || aspect > expected * 1.3) return false;
  return true;
}
