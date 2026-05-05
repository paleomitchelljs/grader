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
import type { PageResult, SheetConfig } from './types';

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

    type PageEntry = { result: PageResult; configUsed: SheetConfig; pageNum: number };
    const entries: PageEntry[] = [];
    for await (const rendered of renderPdfPages(pdfFile)) {
      const { bitmap, pageNum, totalPages } = rendered;
      store.setProcessing({
        kind: 'processing',
        message: `Processing page ${pageNum} of ${totalPages}…`,
        progress: pageNum / totalPages,
      });
      await yieldToUI();

      const trackStage = makeStageTracker(store);
      try {
        const entry = await runPage(pageNum, bitmap, config, trackStage);
        entries.push(entry);
      } catch (pageErr) {
        const msg = pageErr instanceof Error ? pageErr.message : String(pageErr);
        store.appendLog(`  page ${pageNum} FAILED at stage "${trackStage.lastStage()}": ${msg}`, 'err');
        console.error(`[grader] page ${pageNum} failed at stage ${trackStage.lastStage()}:`, pageErr);
      } finally {
        bitmap.close();
      }
      await yieldToUI();
    }

    if (entries.length === 0) {
      throw new Error('No pages processed successfully — see log for per-page errors.');
    }

    // Consensus pass: pick the layout the majority of pages agree on. If any
    // page detected something else, re-render and re-process it with the
    // consensus config. Without this, a single page that misdetects (e.g.
    // because of a stray hand-drawn mark near a fiducial) would lock the
    // store config to the wrong layout for the entire batch.
    const consensusConfig = pickConsensus(entries);
    const disagreeing = entries.filter(e => e.configUsed.numColumns !== consensusConfig.numColumns);
    if (disagreeing.length > 0) {
      const pageNums = disagreeing.map(e => e.pageNum);
      store.appendLog(
        `  re-processing ${disagreeing.length} page(s) ${pageNums.join(', ')} ` +
        `with consensus ${consensusConfig.numQuestions}-question layout`,
      );
      for await (const rendered of renderPdfPages(pdfFile, { onlyPages: pageNums })) {
        const { bitmap, pageNum } = rendered;
        const trackStage = makeStageTracker(store);
        try {
          const entry = await runPage(pageNum, bitmap, consensusConfig, trackStage, /*forceConfig*/ true);
          const idx = entries.findIndex(e => e.pageNum === pageNum);
          if (idx >= 0) entries[idx] = entry;
        } catch (pageErr) {
          const msg = pageErr instanceof Error ? pageErr.message : String(pageErr);
          store.appendLog(`  page ${pageNum} FAILED on re-process: ${msg}`, 'err');
        } finally {
          bitmap.close();
        }
        await yieldToUI();
      }
    }

    const pages = entries.map(e => e.result);
    store.config(consensusConfig);
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

type StageTracker = ((s: string) => void) & { lastStage: () => string };

function makeStageTracker(s: typeof store): StageTracker {
  let lastStage = 'start';
  let stageStart = performance.now();
  const fn = ((name: string) => {
    const elapsed = performance.now() - stageStart;
    if (lastStage !== 'start') {
      s.appendLog(`    ${lastStage}: ${elapsed.toFixed(0)}ms`);
    }
    lastStage = name;
    stageStart = performance.now();
  }) as StageTracker;
  fn.lastStage = () => lastStage;
  return fn;
}

async function runPage(
  pageNum: number,
  bitmap: ImageBitmap,
  config: SheetConfig,
  trackStage: StageTracker,
  forceConfig = false,
): Promise<{ result: PageResult; configUsed: SheetConfig; pageNum: number }> {
  const { result, configUsed } = await processPage(pageNum - 1, bitmap, config, trackStage, { forceConfig });
  const numAnswered = [...result.detectedAnswers.values()].filter(s => s.size > 0).length;
  const markerNote = result.gridParams.markersUsed ? 'markers OK' : 'markers fallback';
  store.appendLog(`  page ${pageNum}: ${numAnswered} answers detected, ${configUsed.numColumns}-col (${markerNote})`);
  return { result, configUsed, pageNum };
}

function pickConsensus(entries: Array<{ configUsed: SheetConfig }>): SheetConfig {
  // Tally column counts; pick the highest-count winner. Ties broken by the
  // larger layout (more columns) since the failure mode here is "missed an
  // anchor", not "saw a phantom one".
  const counts = new Map<number, { count: number; config: SheetConfig }>();
  for (const e of entries) {
    const k = e.configUsed.numColumns;
    const cur = counts.get(k);
    if (cur) cur.count += 1;
    else counts.set(k, { count: 1, config: e.configUsed });
  }
  let best: { count: number; config: SheetConfig } | null = null;
  for (const v of counts.values()) {
    if (!best || v.count > best.count || (v.count === best.count && v.config.numColumns > best.config.numColumns)) {
      best = v;
    }
  }
  return best!.config;
}
