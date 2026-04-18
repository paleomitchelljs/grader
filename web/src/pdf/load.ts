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
};

/**
 * Render every page of a PDF file to an ImageBitmap.
 * onProgress is called once per rendered page, with (pageIndex0Based, totalPages).
 */
export async function renderPdf(
  file: File,
  opts: { dpi?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<RenderedPage[]> {
  const { dpi = 200, onProgress } = opts;
  const arrayBuffer = await file.arrayBuffer();

  const loadingTask = pdfjsLib.getDocument({
    data: arrayBuffer,
    // Disable remote font fetches — we do not make network requests.
    disableFontFace: false,
    useSystemFonts: true,
    isEvalSupported: false,
  });

  const pdf = await loadingTask.promise;
  const scale = dpi / 72; // 72 pt = 1 in, pdfjs uses pt at scale 1
  const pages: RenderedPage[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
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
    pages.push({ bitmap, width: viewport.width, height: viewport.height });
    onProgress?.(i, pdf.numPages);

    // Free per-page resources.
    page.cleanup();
  }

  return pages;
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
