/**
 * Top-level orchestrator that runs the full grading pipeline.
 *
 * Coordinates PDF rasterization, OpenCV initialization, per-page processing,
 * and progress reporting into the store. All state mutations go through the
 * store; this module is otherwise stateless.
 */

import { renderPdf } from './pdf/load';
import { cvReady } from './cv/opencv-loader';
import { processPage } from './cv/pipeline';
import { store } from './state';
import type { PageResult } from './types';

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

    store.setProcessing({ kind: 'processing', message: 'Rasterizing PDF…', progress: 0 });
    store.appendLog(`Loading PDF: ${pdfFile.name} (${formatBytes(pdfFile.size)})`);
    const rendered = await renderPdf(pdfFile, {
      onProgress: (done, total) => {
        store.setProcessing({
          kind: 'processing',
          message: `Rasterizing page ${done} of ${total}…`,
          progress: (done / total) * 0.4,
        });
      },
    });
    store.appendLog(`Rendered ${rendered.length} page${rendered.length === 1 ? '' : 's'}.`);

    const pages: PageResult[] = [];
    for (let i = 0; i < rendered.length; i++) {
      const { bitmap } = rendered[i]!;
      store.setProcessing({
        kind: 'processing',
        message: `Processing page ${i + 1} of ${rendered.length}…`,
        progress: 0.4 + (i / rendered.length) * 0.6,
      });
      const result = await processPage(i, bitmap, config);
      const numAnswered = [...result.detectedAnswers.values()].filter(s => s.size > 0).length;
      const markerNote = result.gridParams.markersUsed ? 'markers OK' : 'markers fallback';
      store.appendLog(`  page ${i + 1}: ${numAnswered} answers detected (${markerNote})`);
      pages.push(result);
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
