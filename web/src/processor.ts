/**
 * Top-level orchestrator that runs the full grading pipeline.
 *
 * Coordinates PDF rasterization, OpenCV initialization, per-page processing,
 * and progress reporting into the store. All state mutations go through the
 * store; this module is otherwise stateless.
 */

import { renderPdfPages } from './pdf/load';
import { cvReady } from './cv/opencv-loader';
import { processPage } from './cv/pipeline';
import { store } from './state';
import type { PageResult } from './types';

// Let the event loop run a task queue tick — paints progress, flushes log DOM,
// and gives the tab a heartbeat so the browser doesn't decide it's hung.
const yieldToUI = () => new Promise<void>(r => setTimeout(r, 0));

export async function runProcessing(): Promise<void> {
  const { config, pdfFile } = store.state;
  if (!pdfFile) {
    store.setProcessing({ kind: 'error', message: 'No PDF selected' });
    return;
  }

  try {
    store.setProcessing({ kind: 'processing', message: 'Loading OpenCV…', progress: 0 });
    store.appendLog('Waiting for OpenCV.js to initialize…');
    await cvReady();
    store.appendLog('OpenCV ready.');

    store.appendLog(`Loading PDF: ${pdfFile.name} (${formatBytes(pdfFile.size)})`);
    store.setProcessing({ kind: 'processing', message: 'Opening PDF…', progress: 0 });

    const pages: PageResult[] = [];
    for await (const rendered of renderPdfPages(pdfFile)) {
      const { bitmap, pageNum, totalPages } = rendered;
      store.setProcessing({
        kind: 'processing',
        message: `Processing page ${pageNum} of ${totalPages}…`,
        progress: pageNum / totalPages,
      });
      await yieldToUI();

      try {
        const result = await processPage(pageNum - 1, bitmap, config);
        const numAnswered = [...result.detectedAnswers.values()].filter(s => s.size > 0).length;
        const markerNote = result.gridParams.markersUsed ? 'markers OK' : 'markers fallback';
        store.appendLog(`  page ${pageNum}: ${numAnswered} answers detected (${markerNote})`);
        pages.push(result);
      } finally {
        // The raw rasterized bitmap is no longer needed — processPage already
        // extracted its pixels. Release the GPU/memory backing immediately so
        // peak memory stays at ~one page rather than scaling with class size.
        bitmap.close();
      }

      await yieldToUI();
    }

    store.setPages(pages);
    store.setProcessing({ kind: 'idle' });
    const flagCount = pages.reduce((s, p) => s + p.flags.length, 0);
    store.appendLog(`Done — ${pages.length} pages, ${flagCount} flag${flagCount === 1 ? '' : 's'}.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.setProcessing({ kind: 'error', message });
    store.appendLog(`ERROR: ${message}`, 'err');
    throw err;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
