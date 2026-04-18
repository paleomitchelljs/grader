/**
 * Per-page processing pipeline.
 *
 * Input: a rendered page (ImageBitmap from pdf/load.ts).
 * Output: a full PageResult — oriented image, detected answers + flags,
 *         grid params, and the cropped name region.
 *
 * This is the analogue of omr_scanner.py :: process_single_page().
 */

import type { PageResult, SheetConfig } from '../types';
import { analyzeBubbleGrid } from './bubbles';
import { computeGridParams } from './grid';
import { orientImage } from './orient';

export async function processPage(
  pageIndex: number,
  bitmap: ImageBitmap,
  config: SheetConfig,
): Promise<PageResult> {
  const imageData = bitmapToImageData(bitmap);
  const { image: orientedData, orientationDetected } = orientImage(imageData);
  const orientedBitmap = await createImageBitmap(orientedData);
  const gridParams = computeGridParams(orientedData, config);
  const { answers, flags } = analyzeBubbleGrid(orientedData, gridParams, config);
  const nameCrop = await cropNameRegion(orientedData, config);

  if (!orientationDetected) {
    flags.unshift({ message: 'Orientation markers not detected — orientation may be wrong' });
  }

  return {
    pageIndex,
    orientedImage: orientedBitmap,
    width: orientedData.width,
    height: orientedData.height,
    detectedAnswers: answers,
    editedAnswers: new Map([...answers].map(([k, v]) => [k, new Set(v)])),
    flags,
    gridParams,
    nameCrop,
    rosterName: null,
  };
}

function bitmapToImageData(bitmap: ImageBitmap): ImageData {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get 2D context');
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

async function cropNameRegion(imageData: ImageData, config: SheetConfig): Promise<ImageBitmap | null> {
  const { width, height } = imageData;
  const x1 = Math.max(0, Math.floor(width * config.nameRegion.left));
  const x2 = Math.min(width, Math.ceil(width * config.nameRegion.right));
  const y1 = Math.max(0, Math.floor(height * config.nameRegion.top));
  const y2 = Math.min(height, Math.ceil(height * config.nameRegion.bottom));
  const cw = x2 - x1;
  const ch = y2 - y1;
  if (cw <= 0 || ch <= 0) return null;

  // Copy the ROI into a new ImageData.
  const out = new Uint8ClampedArray(cw * ch * 4);
  const src = imageData.data;
  for (let y = 0; y < ch; y++) {
    const srcOff = ((y1 + y) * width + x1) * 4;
    const dstOff = y * cw * 4;
    out.set(src.subarray(srcOff, srcOff + cw * 4), dstOff);
  }
  return createImageBitmap(new ImageData(out, cw, ch));
}
