/**
 * PDF loading via pdfjs-dist.
 *
 * Renders each page of a user-selected PDF file to an ImageBitmap at a
 * target DPI (default 200, matching the Python pipeline's calibration).
 */

import * as pdfjsLib from 'pdfjs-dist';
// Vite resolves this ?url import to a hashed asset path at build time; the
// worker runs off the main thread, keeping the UI responsive during decode.
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

export type RenderedPage = {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  pageNum: number;
  totalPages: number;
};

/**
 * Stream the pages of a PDF file one ImageBitmap at a time.
 *
 * Yielding rather than returning an array lets the caller process and free
 * each page before the next is rasterized — peak memory stays near a single
 * page (~15 MB at 200 DPI Letter) instead of scaling with class size.
 */
export async function* renderPdfPages(
  file: File,
  opts: { dpi?: number } = {},
): AsyncGenerator<RenderedPage, void, void> {
  const { dpi = 200 } = opts;
  const arrayBuffer = await file.arrayBuffer();

  const loadingTask = pdfjsLib.getDocument({
    data: arrayBuffer,
    disableFontFace: false,
    useSystemFonts: true,
    isEvalSupported: false,
  });

  const pdf = await loadingTask.promise;
  const scale = dpi / 72;
  const totalPages = pdf.numPages;

  try {
    for (let i = 1; i <= totalPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = new OffscreenCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Failed to get 2D context from OffscreenCanvas');

      await page.render({
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
        intent: 'print',
      }).promise;

      const bitmap = canvas.transferToImageBitmap();
      page.cleanup();
      yield { bitmap, width: viewport.width, height: viewport.height, pageNum: i, totalPages };
    }
  } finally {
    // Release the parsed PDF structure as soon as the consumer is done (or bails).
    pdf.destroy();
  }
}

/**
 * Convert an ImageBitmap to an ImageData (pixel array) usable by CV code.
 * Returns a canvas-backed ImageData; the caller owns it.
 */
export function bitmapToImageData(bitmap: ImageBitmap): ImageData {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get 2D context');
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}
