/**
 * Stats panel — summary statistics + CSV and annotated-PDF downloads.
 *
 * - Shows an overview (# students, mean, flags) and a per-question table
 *   with point-biserial correlation, entropy, and the most-selected
 *   wrong choice / most-missed correct choice.
 * - Download buttons emit a graded CSV (first, last, q01..qNN) and a
 *   single PDF where every page carries the answer overlay baked in.
 */

import { PDFDocument } from 'pdf-lib';
import { renderOverlay } from '../cv/overlay';
import { emitResultsCsv } from '../io/csv';
import { computeSummaryStats } from '../domain/stats';
import { store } from '../state';
import type { PageResult, QuestionStat } from '../types';

export function mountStatsPanel(root: HTMLElement): () => void {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <h2>Stats &amp; downloads</h2>
    <div data-role="overview"></div>
    <div class="download-row">
      <button class="primary" data-role="csv-btn">Download grades CSV</button>
      <button class="primary" data-role="pdf-btn">Download annotated PDF</button>
      <span data-role="download-status" class="small-note" style="margin-left:8px;"></span>
    </div>
    <h3 style="margin-top:20px;">Per-question item analysis</h3>
    <div data-role="stats-table"></div>
  `;
  root.appendChild(panel);

  const overview = panel.querySelector<HTMLElement>('[data-role="overview"]')!;
  const tableWrap = panel.querySelector<HTMLElement>('[data-role="stats-table"]')!;
  const csvBtn = panel.querySelector<HTMLButtonElement>('[data-role="csv-btn"]')!;
  const pdfBtn = panel.querySelector<HTMLButtonElement>('[data-role="pdf-btn"]')!;
  const status = panel.querySelector<HTMLElement>('[data-role="download-status"]')!;

  csvBtn.addEventListener('click', () => downloadCsv(status));
  pdfBtn.addEventListener('click', () => downloadPdf(status, pdfBtn));

  const rerender = () => {
    const { pages, key, config } = store.state;
    const haveKey = !!key;
    csvBtn.disabled = pages.length === 0;
    pdfBtn.disabled = pages.length === 0;

    if (pages.length === 0) {
      overview.innerHTML = `<p class="small-note">No pages processed yet.</p>`;
      tableWrap.innerHTML = '';
      return;
    }
    if (!haveKey) {
      overview.innerHTML = `<p class="small-note">No answer key loaded — load one to compute item statistics.</p>`;
      tableWrap.innerHTML = '';
      return;
    }

    const allAnswers = pages.map(p => p.editedAnswers);
    const summary = computeSummaryStats(allAnswers, key!, config);
    overview.innerHTML = renderOverview(summary);
    tableWrap.innerHTML = renderTable(summary.questionStats);
  };

  const unsub = store.subscribe(rerender);
  rerender();
  return unsub;
}

function renderOverview(summary: ReturnType<typeof computeSummaryStats>): string {
  const flagList = summary.flags.length
    ? `<div class="flag-list"><strong>Flags</strong><ul>${summary.flags.map(escapeHtmlLi).join('')}</ul></div>`
    : '';
  return `
    <div class="score-summary">
      <div><strong>Students:</strong> ${summary.numStudents}</div>
      <div><strong>Mean score:</strong> ${summary.meanScore.toFixed(1)} / ${summary.maxPossible} (${summary.meanPct.toFixed(1)}%)</div>
    </div>
    ${flagList}
  `;
}

function renderTable(stats: QuestionStat[]): string {
  const rows = stats.map(s => {
    const cls: string[] = [];
    if (s.pctCorrect < 30) cls.push('low-pct');
    else if (s.pctCorrect > 95) cls.push('high-pct');
    if (s.pointBiserial < 0) cls.push('neg-corr');
    const mw = s.mostWrong ? `${s.mostWrong.letter} (${s.mostWrong.count})` : '—';
    const mm = s.mostMissed ? `${s.mostMissed.letter} (${s.mostMissed.count})` : '—';
    return `
      <tr class="${cls.join(' ')}">
        <td>Q${s.qNum}</td>
        <td>${s.correctKey || '—'}</td>
        <td>${s.numFullyCorrect}</td>
        <td>${s.pctCorrect.toFixed(1)}%</td>
        <td>${s.pointBiserial.toFixed(3)}</td>
        <td>${s.entropy.toFixed(2)}</td>
        <td>${mw}</td>
        <td>${mm}</td>
      </tr>
    `;
  }).join('');
  return `
    <table class="stats-table">
      <thead>
        <tr>
          <th>Q</th><th>Key</th><th>#Correct</th><th>%Correct</th>
          <th>r<sub>pb</sub></th><th>H</th><th>Top wrong</th><th>Top missed</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function downloadCsv(status: HTMLElement): void {
  const { pages, config } = store.state;
  if (pages.length === 0) return;

  const rows = pages.map(p => {
    const { first, last } = splitName(p.rosterName);
    return { first, last, answers: p.editedAnswers };
  });
  const csv = emitResultsCsv({ rows, numQuestions: config.numQuestions });
  const blob = new Blob([csv], { type: 'text/csv' });
  triggerDownload(blob, 'grades.csv');
  status.textContent = 'grades.csv ready.';
  status.style.color = '';
}

async function downloadPdf(status: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  const { pages } = store.state;
  if (pages.length === 0) return;
  btn.disabled = true;
  status.textContent = 'Building annotated PDF…';
  status.style.color = '';

  try {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages.length; i++) {
      status.textContent = `Rendering page ${i + 1} of ${pages.length}…`;
      const png = await overlayPng(pages[i]!);
      const image = await doc.embedPng(png);
      const page = doc.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    }
    const bytes = await doc.save();
    const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
    triggerDownload(blob, 'annotated.pdf');
    status.textContent = 'annotated.pdf ready.';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    status.textContent = `PDF error: ${msg}`;
    status.style.color = 'var(--err)';
    store.appendLog(`PDF export error: ${msg}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function overlayPng(page: PageResult): Promise<Uint8Array> {
  const { key, config } = store.state;
  const { canvas } = renderOverlay({
    image: page.orientedImage,
    gridParams: page.gridParams,
    config,
    key,
    studentAnswers: page.editedAnswers,
  });
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Canvas toBlob failed');
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function splitName(full: string | null): { first: string; last: string } {
  if (!full) return { first: '', last: '' };
  if (full.includes(',')) {
    const [l, f] = full.split(',').map(s => s.trim());
    return { first: f ?? '', last: l ?? '' };
  }
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first: '', last: parts[0] ?? '' };
  return { first: parts.slice(0, -1).join(' '), last: parts.slice(-1)[0] ?? '' };
}

function escapeHtmlLi(s: string): string {
  return `<li>${s.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!)}</li>`;
}
