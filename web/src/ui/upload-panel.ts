/**
 * Upload panel — file pickers for PDF/key/roster, sheet-layout knobs,
 * the "Grade" button, and a live processing log.
 */

import { parseAnswerKey, parseRoster, readFileText } from '../io/csv';
import { runProcessing } from '../processor';
import { store } from '../state';
import { defaultColumns } from '../types';

export function mountUploadPanel(root: HTMLElement): () => void {
  const wrap = document.createElement('div');
  wrap.innerHTML = renderMarkup();
  root.appendChild(wrap);

  const unsubs: Array<() => void> = [];
  wireFilePickers(wrap);
  wireConfigInputs(wrap);
  wireProcessButton(wrap);
  unsubs.push(wireLog(wrap));
  unsubs.push(wireRender(wrap));

  // Initial render with current state.
  rerender(wrap);

  return () => unsubs.forEach(u => u());
}

function renderMarkup(): string {
  return `
    <div class="panel">
      <h2>1. Upload files</h2>
      <div class="form-row">
        <label for="pdf-input">Scanned PDF:</label>
        <input type="file" id="pdf-input" accept=".pdf,application/pdf" />
        <span class="file-display" data-role="pdf-name"></span>
      </div>
      <div class="form-row">
        <label for="key-input">Answer key (CSV):</label>
        <input type="file" id="key-input" accept=".csv,text/csv" />
        <span class="file-display" data-role="key-name"></span>
      </div>
      <div class="form-row">
        <label for="roster-input">Roster (CSV, optional):</label>
        <input type="file" id="roster-input" accept=".csv,text/csv" />
        <span class="file-display" data-role="roster-name"></span>
      </div>
      <p class="small-note">
        All files stay in this browser tab. Nothing is uploaded anywhere.
        Answer key needs a <code>question_number</code> column plus
        <code>answers</code> or <code>answer</code>. Roster can have
        <code>first</code>/<code>last</code>, <code>name</code>, or a single
        column of names.
      </p>
    </div>

    <div class="panel">
      <h2>2. Sheet layout</h2>
      <div class="form-row">
        <label for="cfg-numq">Number of questions:</label>
        <input type="number" id="cfg-numq" min="1" max="500" />
      </div>
      <div class="form-row">
        <label for="cfg-numc">Choices per question:</label>
        <input type="number" id="cfg-numc" min="2" max="26" />
      </div>
      <div class="form-row">
        <label for="cfg-numcol">Number of columns:</label>
        <input type="number" id="cfg-numcol" min="1" max="6" />
      </div>
      <div class="form-row">
        <label for="cfg-thresh">Fill threshold (0–1):</label>
        <input type="number" id="cfg-thresh" min="0.02" max="0.9" step="0.01" />
      </div>
      <p class="small-note">
        Defaults are the BIO145 layout: 50 questions, 6 choices (A–F), 3 columns. Lower the threshold if students mark lightly.
      </p>
    </div>

    <div class="panel">
      <h2>3. Grade</h2>
      <button class="primary" data-role="process-btn">Grade exams</button>
      <span data-role="process-status" class="small-note" style="margin-left:12px;"></span>
      <h3 style="margin-top:20px;">Log</h3>
      <div class="progress-log" data-role="log"></div>
    </div>
  `;
}

function wireFilePickers(wrap: HTMLElement) {
  const pdfInput = wrap.querySelector<HTMLInputElement>('#pdf-input')!;
  const keyInput = wrap.querySelector<HTMLInputElement>('#key-input')!;
  const rosterInput = wrap.querySelector<HTMLInputElement>('#roster-input')!;

  pdfInput.addEventListener('change', () => {
    const file = pdfInput.files?.[0] ?? null;
    store.setPdfFile(file);
    if (file) store.appendLog(`Selected PDF: ${file.name}`);
  });

  keyInput.addEventListener('change', async () => {
    const file = keyInput.files?.[0];
    if (!file) { store.setKey(null, null); return; }
    try {
      const text = await readFileText(file);
      const { key, warnings } = parseAnswerKey(text);
      store.setKey(key, file.name);
      store.appendLog(`Loaded key from ${file.name}: ${key.size} question${key.size === 1 ? '' : 's'}`);
      warnings.forEach(w => store.appendLog(w, 'warn'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.appendLog(`Key parse error: ${msg}`, 'err');
      store.setKey(null, null);
    }
  });

  rosterInput.addEventListener('change', async () => {
    const file = rosterInput.files?.[0];
    if (!file) { store.setRoster(null, null); return; }
    try {
      const text = await readFileText(file);
      const { roster, warnings } = parseRoster(text);
      store.setRoster(roster, file.name);
      store.appendLog(`Loaded roster from ${file.name}: ${roster.length} name${roster.length === 1 ? '' : 's'}`);
      warnings.forEach(w => store.appendLog(w, 'warn'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.appendLog(`Roster parse error: ${msg}`, 'err');
      store.setRoster(null, null);
    }
  });
}

function wireConfigInputs(wrap: HTMLElement) {
  const numq = wrap.querySelector<HTMLInputElement>('#cfg-numq')!;
  const numc = wrap.querySelector<HTMLInputElement>('#cfg-numc')!;
  const numcol = wrap.querySelector<HTMLInputElement>('#cfg-numcol')!;
  const thresh = wrap.querySelector<HTMLInputElement>('#cfg-thresh')!;

  const syncFromState = () => {
    numq.value = String(store.state.config.numQuestions);
    numc.value = String(store.state.config.numChoices);
    numcol.value = String(store.state.config.numColumns);
    thresh.value = String(store.state.config.fillThreshold);
  };
  syncFromState();

  const applyConfig = () => {
    const nq = clampInt(numq.value, 1, 500, store.state.config.numQuestions);
    const nc = clampInt(numc.value, 2, 26, store.state.config.numChoices);
    const ncol = clampInt(numcol.value, 1, 6, store.state.config.numColumns);
    const thr = clampFloat(thresh.value, 0.02, 0.9, store.state.config.fillThreshold);
    store.config({
      numQuestions: nq,
      numChoices: nc,
      numColumns: ncol,
      fillThreshold: thr,
      columns: defaultColumns(nq, ncol),
    });
  };

  [numq, numc, numcol, thresh].forEach(el => el.addEventListener('change', applyConfig));
}

function wireProcessButton(wrap: HTMLElement) {
  const btn = wrap.querySelector<HTMLButtonElement>('[data-role="process-btn"]')!;
  btn.addEventListener('click', async () => {
    console.log('[grader] Grade button clicked');
    if (!store.state.pdfFile) {
      store.appendLog('Select a PDF first.', 'warn');
      return;
    }
    if (!store.state.key) {
      store.appendLog('Select an answer key CSV first.', 'warn');
      return;
    }
    btn.disabled = true;
    console.log('[grader] Calling runProcessing()');
    try {
      await runProcessing();
      console.log('[grader] runProcessing completed');
    } catch (err) {
      console.error('[grader] runProcessing threw:', err);
      store.appendLog(`Click-handler error: ${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      btn.disabled = false;
    }
  });
}

function wireLog(wrap: HTMLElement): () => void {
  const logEl = wrap.querySelector<HTMLElement>('[data-role="log"]')!;
  const renderLog = () => {
    logEl.innerHTML = '';
    for (const { kind, text } of store.state.log) {
      const line = document.createElement('div');
      line.textContent = text;
      if (kind === 'err') line.className = 'line-err';
      else if (kind === 'warn') line.className = 'line-warn';
      logEl.appendChild(line);
    }
    logEl.scrollTop = logEl.scrollHeight;
  };
  const unsub = store.subscribe(renderLog);
  renderLog();
  return unsub;
}

function wireRender(wrap: HTMLElement): () => void {
  return store.subscribe(() => rerender(wrap));
}

function rerender(wrap: HTMLElement) {
  const pdfName = wrap.querySelector<HTMLElement>('[data-role="pdf-name"]')!;
  const keyName = wrap.querySelector<HTMLElement>('[data-role="key-name"]')!;
  const rosterName = wrap.querySelector<HTMLElement>('[data-role="roster-name"]')!;
  pdfName.textContent = store.state.pdfFile?.name ?? '';
  keyName.textContent = store.state.keyFilename ?? '';
  rosterName.textContent = store.state.rosterFilename ?? '';

  const status = wrap.querySelector<HTMLElement>('[data-role="process-status"]')!;
  const p = store.state.processing;
  if (p.kind === 'processing') {
    status.textContent = `${p.message} (${Math.round(p.progress * 100)}%)`;
  } else if (p.kind === 'error') {
    status.textContent = `Error: ${p.message}`;
    status.style.color = 'var(--err)';
  } else {
    status.textContent = '';
    status.style.color = '';
  }
}

function clampInt(s: string, lo: number, hi: number, fallback: number): number {
  const v = parseInt(s, 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}
function clampFloat(s: string, lo: number, hi: number, fallback: number): number {
  const v = parseFloat(s);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}
