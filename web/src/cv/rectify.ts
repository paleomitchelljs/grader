/**
 * Four-point perspective rectification.
 *
 * Warps the page so the 4 corner fiducials land on a rectangle with the
 * template's exact aspect ratio (180mm horizontal, 160mm vertical — see
 * latex/bubble_sheet.tex). After rectification the bubble grid is axis-
 * aligned by construction.
 *
 * Anchor positions (used by grid.ts for per-column bubble placement) are
 * computed from template geometry rather than detected: in canonical coords
 * we know each anchor should be 5mm below TL, evenly spaced at the column
 * pitch derived from numColumns/numChoices. This removes the failure mode
 * where per-blob strict filters rejected one of the three anchor circles
 * and collapsed detection for the whole page.
 *
 * If corner detection can't find 4 good candidates, we fall back to the old
 * detectSheetMarkers path — never worse than today.
 */

import { cv } from './opencv-loader';
import type { Markers, SheetConfig } from '../types';
import { findFourCorners } from './corners';
import { detectSheetMarkers } from './markers';

const TEMPLATE_WIDTH_MM = 180;            // TL to TR
const TEMPLATE_HEIGHT_MM = 160;           // TL to BL
const TEMPLATE_ANCHOR_Y_OFFSET_MM = 5;    // anchor y = TL_y + 5mm (60mm - 55mm)
const TEMPLATE_TL_X_MM = 15;              // TL's x on the physical page

const TEMPLATE_ANCHOR_X_FIRST_MM = 30;
const TEMPLATE_ANCHOR_X_RIGHT_EDGE_MM = 183;
const TEMPLATE_X_PITCH_MM = 7.657;

export type RectifyResult = {
  imageData: ImageData;
  markers: Markers | null;
  rectified: boolean;
};

export function rectifyPage(imageData: ImageData, config: SheetConfig): RectifyResult {
  const corners = findFourCorners(imageData);
  if (!corners) {
    const legacy = detectSheetMarkers(imageData);
    console.warn('[grader] rectify: could not find 4 corners, using legacy path', {
      legacyHasTL: !!legacy?.tl, legacyHasTR: !!legacy?.tr,
      legacyHasBL: !!legacy?.bl, legacyHasBR: !!legacy?.br,
      legacyAnchorCount: legacy?.anchors.length ?? 0,
    });
    return { imageData, markers: legacy, rectified: false };
  }

  const [tl, tr, br, bl] = corners;

  const hLenTop = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
  const hLenBottom = Math.hypot(br[0] - bl[0], br[1] - bl[1]);
  const canonicalW = 0.5 * (hLenTop + hLenBottom);
  const canonicalH = canonicalW * (TEMPLATE_HEIGHT_MM / TEMPLATE_WIDTH_MM);

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
 * Column anchor x-positions measured from the template's TL (mm). Mirrors
 * the derivation in latex/bubble_sheet.tex so the two can't disagree.
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
