/**
 * Review & edit panel — the centrepiece.
 *
 * Three-pane layout:
 *   - Left:   page list (one entry per scanned sheet, with assigned name + score)
 *   - Centre: the oriented page image with overlay (green rings on key,
 *             red dots on current edited answers). Clicking a bubble toggles it.
 *   - Right:  name assignment (cropped name region + roster dropdown),
 *             score summary, per-question answer table, and flags.
 *
 * The "edited" answers drive the overlay and the output CSV. Detected
 * answers are preserved for reference but never written out directly.
 */

import { renderOverlay, type BubbleHit } from '../cv/overlay';
import { scoreStudent, maxPossibleTfItems } from '../domain/scoring';
import { store } from '../state';
import type { AnswerSet, PageResult } from '../types';
import { choiceLetter } from '../types';

export function mountReviewPanel(root: HTMLElement): () => void {
  const wrap = document.createElement('div');
  wrap.className = 'review-layout';
  wrap.innerHTML = `
    <div class="review-pagelist" data-role="pagelist"></div>
    <div class="review-canvas-wrap" data-role="canvas-wrap">
      <canvas data-role="overlay"></canvas>
    </div>
    <div class="review-sidebar" data-role="sidebar"></div>
  `;
  root.appendChild(wrap);

  const pagelist = wrap.querySelector<HTMLElement>('[data-role="pagelist"]')!;
  const canvasWrap = wrap.querySelector<HTMLElement>('[data-role="canvas-wrap"]')!;
  const canvas = wrap.querySelector<HTMLCanvasElement>('[data-role="overlay"]')!;
  const sidebar = wrap.querySelector<HTMLElement>('[data-role="sidebar"]')!;

  // Bubble hit-map for the currently rendered page — updated on every render.
  let currentBubbles: BubbleHit[] = [];

  canvas.addEventListener('click', (e) => {
    const page = currentPage();
    if (!page) return;
    const hit = hitTest(canvas, e, currentBubbles);
    if (!hit) return;
    store.toggleBubble(page.pageIndex, hit.qNum, hit.letter);
  });

  const rerender = () => {
    renderPageList(pagelist);
    const page = currentPage();
    if (!page) {
      canvas.width = 0;
      canvas.height = 0;
      sidebar.innerHTML = '';
      return;
    }
    currentBubbles = drawOverlay(canvas, canvasWrap, page);
    renderSidebar(sidebar, page);
  };

  // Keyboard shortcuts: ←/→ for prev/next page.
  const onKey = (e: KeyboardEvent) => {
    if (isTyping(e.target)) return;
    const { currentPage: idx, pages } = store.state;
    if (e.key === 'ArrowLeft' && idx > 0) {
      store.setCurrentPage(idx - 1);
      e.preventDefault();
    } else if (e.key === 'ArrowRight' && idx < pages.length - 1) {
      store.setCurrentPage(idx + 1);
      e.preventDefault();
    }
  };
  window.addEventListener('keydown', onKey);

  // Refit canvas on window resize.
  const onResize = () => {
    const page = currentPage();
    if (page) drawOverlay(canvas, canvasWrap, page);
  };
  window.addEventListener('resize', onResize);

  const unsub = store.subscribe(rerender);
  rerender();

  return () => {
    unsub();
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
  };
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

function currentPage(): PageResult | null {
  const { pages, currentPage } = store.state;
  return pages[currentPage] ?? null;
}

function drawOverlay(
  canvas: HTMLCanvasElement,
  wrap: HTMLElement,
  page: PageResult,
): BubbleHit[] {
  const { config, key } = store.state;
  const { canvas: source, bubbles } = renderOverlay({
    image: page.orientedImage,
    gridParams: page.gridParams,
    config,
    key,
    studentAnswers: page.editedAnswers,
  });

  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.drawImage(source, 0, 0);

  // Fit the rendered canvas to the available width while preserving aspect.
  const wrapWidth = wrap.clientWidth - 20;
  const scale = Math.min(1, wrapWidth / source.width);
  canvas.style.width = `${Math.round(source.width * scale)}px`;
  canvas.style.height = `${Math.round(source.height * scale)}px`;

  return bubbles;
}

function hitTest(
  canvas: HTMLCanvasElement,
  e: MouseEvent,
  bubbles: BubbleHit[],
): BubbleHit | null {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;

  let best: BubbleHit | null = null;
  let bestDist = Infinity;
  for (const b of bubbles) {
    const dx = b.x - x;
    const dy = b.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < b.r * b.r && d2 < bestDist) {
      best = b;
      bestDist = d2;
    }
  }
  return best;
}

function renderPageList(root: HTMLElement) {
  const { pages, currentPage, key, config } = store.state;
  root.innerHTML = '';
  pages.forEach((page, i) => {
    const row = document.createElement('div');
    row.className = 'page-item' + (i === currentPage ? ' active' : '');
    const name = page.rosterName || `(unassigned)`;
    let scoreChip = '';
    if (key) {
      const { tfItems } = scoreStudent(page.editedAnswers, key, config);
      scoreChip = `${tfItems}/${maxPossibleTfItems(config)}`;
    }
    row.innerHTML = `
      <div>
        <div>Page ${i + 1}</div>
        <div class="score-chip">${escapeHtml(name)}</div>
      </div>
      <div class="score-chip">${scoreChip}</div>
    `;
    row.addEventListener('click', () => store.setCurrentPage(i));
    root.appendChild(row);
  });
}

function renderSidebar(root: HTMLElement, page: PageResult) {
  root.innerHTML = '';
  root.appendChild(renderNamePanel(page));
  root.appendChild(renderScoreSummary(page));
  root.appendChild(renderAnswersTable(page));
  if (page.flags.length > 0) root.appendChild(renderFlags(page));
  root.appendChild(renderPageNav());
}

function renderNamePanel(page: PageResult): HTMLElement {
  const el = document.createElement('div');
  el.className = 'name-panel';

  const crop = document.createElement('canvas');
  crop.className = 'name-crop';
  if (page.nameCrop) {
    crop.width = page.nameCrop.width;
    crop.height = page.nameCrop.height;
    crop.getContext('2d')?.drawImage(page.nameCrop, 0, 0);
  }
  el.appendChild(crop);

  const { roster } = store.state;
  const listId = `roster-list-${page.pageIndex}`;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'name-picker';
  input.placeholder = roster ? 'Assign student…' : 'No roster loaded';
  input.value = page.rosterName ?? '';
  input.setAttribute('list', listId);

  const datalist = document.createElement('datalist');
  datalist.id = listId;
  if (roster) {
    for (const r of roster) {
      const opt = document.createElement('option');
      opt.value = r.full;
      datalist.appendChild(opt);
    }
  }

  input.addEventListener('change', () => {
    const v = input.value.trim();
    store.setRosterAssignment(page.pageIndex, v.length > 0 ? v : null);
  });

  el.appendChild(input);
  el.appendChild(datalist);
  return el;
}

function renderScoreSummary(page: PageResult): HTMLElement {
  const el = document.createElement('div');
  el.className = 'score-summary';
  const { key, config } = store.state;
  if (!key) {
    el.textContent = 'No key loaded — load one to see score.';
    return el;
  }
  const { tfItems, fullyCorrect } = scoreStudent(page.editedAnswers, key, config);
  const max = maxPossibleTfItems(config);
  const pct = (tfItems / max) * 100;
  el.innerHTML = `
    <div><strong>Score:</strong> ${tfItems} / ${max} (${pct.toFixed(1)}%)</div>
    <div><strong>Fully correct:</strong> ${fullyCorrect} / ${config.numQuestions}</div>
  `;
  return el;
}

function renderAnswersTable(page: PageResult): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'answers-panel';
  const { key, config } = store.state;

  const table = document.createElement('table');
  table.className = 'answers-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr><th>Q</th><th>Key</th><th>Detected</th><th>Edited</th></tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');

  for (let q = 1; q <= config.numQuestions; q++) {
    const correct = key?.get(q) ?? null;
    const detected = page.detectedAnswers.get(q) ?? new Set<string>();
    const edited = page.editedAnswers.get(q) ?? new Set<string>();
    const correctStr = correct ? setToStr(correct) : '—';
    const detectedStr = setToStr(detected);
    const editedStr = setToStr(edited);
    const isEdited = !setsEqual(detected, edited);
    const matches = correct ? fullyMatches(edited, correct, config.numChoices) : null;

    const tr = document.createElement('tr');
    const cls: string[] = [];
    if (matches === true) cls.push('correct');
    else if (matches === false) cls.push('incorrect');
    if (isEdited) cls.push('edited');
    if (cls.length > 0) tr.className = cls.join(' ');
    tr.innerHTML = `
      <td>${q}</td>
      <td class="letter-cell">${escapeHtml(correctStr)}</td>
      <td class="letter-cell">${escapeHtml(detectedStr)}</td>
      <td class="letter-cell">${escapeHtml(editedStr)}</td>
    `;
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderFlags(page: PageResult): HTMLElement {
  const el = document.createElement('div');
  el.className = 'flag-list';
  const items = page.flags.map(f => {
    const q = f.question != null ? `Q${f.question}: ` : '';
    return `<li>${escapeHtml(q + f.message)}</li>`;
  }).join('');
  el.innerHTML = `<strong>Flags</strong><ul>${items}</ul>`;
  return el;
}

function renderPageNav(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'download-row';
  const { currentPage, pages } = store.state;
  const prev = document.createElement('button');
  prev.className = 'secondary';
  prev.textContent = '← Prev';
  prev.disabled = currentPage <= 0;
  prev.addEventListener('click', () => store.setCurrentPage(currentPage - 1));
  const next = document.createElement('button');
  next.className = 'secondary';
  next.textContent = 'Next →';
  next.disabled = currentPage >= pages.length - 1;
  next.addEventListener('click', () => store.setCurrentPage(currentPage + 1));
  el.appendChild(prev);
  el.appendChild(next);
  return el;
}

function setToStr(s: AnswerSet): string {
  return [...s].sort().join('').toUpperCase();
}

function setsEqual(a: AnswerSet, b: AnswerSet): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function fullyMatches(edited: AnswerSet, correct: AnswerSet, numChoices: number): boolean {
  for (let c = 0; c < numChoices; c++) {
    const letter = choiceLetter(c);
    if (edited.has(letter) !== correct.has(letter)) return false;
  }
  return true;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]!);
}
