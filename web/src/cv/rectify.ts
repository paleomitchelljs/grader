/**
 * Four-point perspective rectification.
 *
 * Detects the 4 corner fiducials and warps the page so they land on a
 * rectangle with the template's exact aspect ratio (180mm horizontal span,
 * 160mm vertical span — see latex/bubble_sheet.tex). After rectification the
 * bubble grid is axis-aligned by construction, so the fixed template ratios
 * used by grid.ts hold no matter what rotation, skew, or non-uniform X/Y
 * scaling the print/scan path introduced.
 *
 * Falls through unchanged if either BL or BR wasn't detected (e.g. one
 * obscured by a student's ink). In that case grid.ts will use its existing
 * one-axis calibration on the detected corners — same behaviour as before.
 */

import { cv } from './opencv-loader';
import type { Markers } from '../types';
import { detectSheetMarkers } from './markers';

// Template: TL (15mm, 55mm), TR (195mm, 55mm), BL (15mm, 215mm), BR (195mm, 215mm).
// Width 180mm, height 160mm. This ratio is the whole point of rectification —
// enforcing it is what corrects any non-uniform X/Y scaling from the scanner.
const TEMPLATE_HEIGHT_OVER_WIDTH = 160 / 180;

export type RectifyResult = {
  imageData: ImageData;
  markers: Markers | null;
  rectified: boolean;
};

export function rectifyPage(imageData: ImageData): RectifyResult {
  const markers = detectSheetMarkers(imageData);
  if (!markers || !markers.bl || !markers.br) {
    return { imageData, markers, rectified: false };
  }

  const { tl, tr, bl, br } = markers;

  // Average the two horizontal edges for the canonical width so mild
  // perspective distortion (where tl-tr and bl-br differ in length) is
  // absorbed symmetrically rather than trusting just one edge.
  const hLenTop = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
  const hLenBottom = Math.hypot(br[0] - bl[0], br[1] - bl[1]);
  const canonicalW = 0.5 * (hLenTop + hLenBottom);
  const canonicalH = canonicalW * TEMPLATE_HEIGHT_OVER_WIDTH;

  // Pin canonical TL to the detected TL so the rest of the page (name
  // region, header, footer) stays roughly where it was — they lie outside
  // the 4-corner box and will be extrapolated through the same homography.
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
  // White fill for pixels pulled in from outside the source — otherwise they
  // come back black and could trip the marker-detection threshold.
  cv.warpPerspective(
    srcImg, dstImg, H, dsize,
    cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255),
  );

  // .data is a view into OpenCV's heap; copy into an owned buffer before
  // we delete the Mat.
  const rectifiedData = new ImageData(
    new Uint8ClampedArray(dstImg.data),
    dstImg.cols,
    dstImg.rows,
  );
  srcImg.delete();
  dstImg.delete();

  // Transform the anchor points through the same homography instead of
  // re-running marker detection on the warped image. Cheaper, and removes
  // a second-pass failure mode where a warp artefact could cause a real
  // fiducial to be rejected.
  const anchorsFlat: number[] = [];
  for (const a of markers.anchors) { anchorsFlat.push(a[0], a[1]); }
  const anchorSrc = cv.matFromArray(markers.anchors.length, 1, cv.CV_32FC2, anchorsFlat);
  const anchorDst = new cv.Mat();
  cv.perspectiveTransform(anchorSrc, anchorDst, H);
  const transformedAnchors: Array<readonly [number, number]> = [];
  for (let i = 0; i < markers.anchors.length; i++) {
    transformedAnchors.push([
      anchorDst.data32F[i * 2]!,
      anchorDst.data32F[i * 2 + 1]!,
    ] as const);
  }
  anchorSrc.delete();
  anchorDst.delete();
  H.delete();

  const rectifiedMarkers: Markers = {
    tl: [tlX, tlY],
    tr: [tlX + canonicalW, tlY],
    bl: [tlX, tlY + canonicalH],
    br: [tlX + canonicalW, tlY + canonicalH],
    blY: tlY + canonicalH,
    anchors: transformedAnchors,
  };

  return { imageData: rectifiedData, markers: rectifiedMarkers, rectified: true };
}
