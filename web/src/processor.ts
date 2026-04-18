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
  console.log('[grader] runProcessing: enter');
  const { config, pdfFile } = store.state;
  if (!pdfFile) {
    store.setProcessing({ kind: 'error', message: 'No PDF selected' });
    return;
  }

  try {
    console.log('[grader] runProcessing: setting status Loading OpenCV');
    store.setProcessing({ kind: 'processing', message: 'Loading OpenCV…', progress: 0 });
    console.log('[grader] runProcessing: appending Waiting log');
    store.appendLog('Waiting for OpenCV.js to initialize…');
    console.log('[grader] runProcessing: awaiting cvReady');
    await cvReady();
    console.log('[grader] runProcessing: cvReady resolved');
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

      let lastStage = 'start';
      let stageStart = performance.now();
      const trackStage = (s: string) => {
        const elapsed = performance.now() - stageStart;
        if (lastStage !== 'start') {
          store.appendLog(`    ${lastStage}: ${elapsed.toFixed(0)}ms`);
        }
        lastStage = s;
        stageStart = performance.now();
      };
      try {
        const result = await processPage(pageNum - 1, bitmap, config, trackStage);
        const numAnswered = [...result.detectedAnswers.values()].filter(s => s.size > 0).length;
        const markerNote = result.gridParams.markersUsed ? 'markers OK' : 'markers fallback';
        store.appendLog(`  page ${pageNum}: ${numAnswered} answers detected (${markerNote})`);
        pages.push(result);
      } catch (pageErr) {
        // Surface per-page failures without aborting the whole batch — this
        // turns "tab crashed" into a visible log line pointing at the stage.
        const msg = pageErr instanceof Error ? pageErr.message : String(pageErr);
        store.appendLog(`  page ${pageNum} FAILED at stage "${lastStage}": ${msg}`, 'err');
        console.error(`[grader] page ${pageNum} failed at stage ${lastStage}:`, pageErr);
      } finally {
        bitmap.close();
      }

      await yieldToUI();
    }

    if (pages.length === 0) {
      throw new Error('No pages processed successfully — see log for per-page errors.');
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
