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
import { configForColumns } from '../types';
import { analyzeBubbleGrid } from './bubbles';
import { computeGridParams } from './grid';
import { detectColumnCount } from './markers';
import { orientImage } from './orient';
import { rectifyPage } from './rectify';

export type ProcessPageResult = { result: PageResult; configUsed: SheetConfig };

export async function processPage(
  pageIndex: number,
  bitmap: ImageBitmap,
  config: SheetConfig,
  onStage?: (stage: string) => void,
  opts: { forceConfig?: boolean } = {},
): Promise<ProcessPageResult> {
  const yieldTo = () => new Promise<void>(r => setTimeout(r, 0));
  const stage = async (name: string) => { onStage?.(name); await yieldTo(); };

  await stage('rasterToImageData');
  const imageData = bitmapToImageData(bitmap);
  await stage('orient');
  const { image: orientedData, orientationDetected } = orientImage(imageData);
  await stage('detectLayout');
  const detectedCols = detectColumnCount(orientedData);
  let activeConfig = config;
  if (!opts.forceConfig && detectedCols !== null && detectedCols !== config.numColumns) {
    const swapped = configForColumns(detectedCols, config);
    if (swapped) {
      console.info('[grader] auto-detected layout', {
        detectedColumns: detectedCols,
        fromQuestions: config.numQuestions,
        toQuestions: swapped.numQuestions,
      });
      activeConfig = swapped;
    }
  } else if (opts.forceConfig && detectedCols !== null && detectedCols !== config.numColumns) {
    console.warn('[grader] forced config overrides per-page detection', {
      detectedColumns: detectedCols, forcedColumns: config.numColumns,
    });
  }
  await stage('rectify');
  const { imageData: rectifiedData, markers, rectified } = rectifyPage(orientedData, activeConfig);
  await stage('createRectifiedBitmap');
  const rectifiedBitmap = await createImageBitmap(rectifiedData);
  await stage('computeGrid');
  const gridParams = computeGridParams(rectifiedData, markers, activeConfig);
  await stage('analyzeBubbles');
  const { answers, flags } = analyzeBubbleGrid(rectifiedData, gridParams, activeConfig);
  await stage('cropName');
  const nameCrop = await cropNameRegion(rectifiedData, activeConfig);
  await stage('done');

  if (!orientationDetected) {
    flags.unshift({ message: 'Orientation markers not detected — orientation may be wrong' });
  }
  if (!rectified && gridParams.markersUsed) {
    flags.unshift({ message: 'Only 3 fiducial corners detected — grid not perspective-corrected' });
  }

  const result: PageResult = {
    pageIndex,
    orientedImage: rectifiedBitmap,
    width: rectifiedData.width,
    height: rectifiedData.height,
    detectedAnswers: answers,
    editedAnswers: new Map([...answers].map(([k, v]) => [k, new Set(v)])),
    flags,
    gridParams,
    nameCrop,
    rosterName: null,
  };
  return { result, configUsed: activeConfig };
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
