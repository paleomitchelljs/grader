/**
 * Central state store with a tiny pub/sub.
 *
 * The store holds all ephemeral grading state: the uploaded key/roster, the
 * per-page results (detected + edited answers), and the currently-selected
 * page for review. Nothing here is persisted to localStorage — by design,
 * closing the tab throws everything away (FERPA constraint).
 */

import type {
  AnswerKey, AnswerSet, Flag, PageResult, Roster, SheetConfig,
} from './types';
import { DEFAULT_CONFIG } from './types';

export type ProcessingStatus =
  | { kind: 'idle' }
  | { kind: 'processing'; message: string; progress: number }
  | { kind: 'error'; message: string };

export type Store = {
  readonly state: StoreState;
  subscribe(listener: () => void): () => void;
  config(partial: Partial<SheetConfig>): void;
  setKey(key: AnswerKey | null, filename: string | null): void;
  setRoster(roster: Roster | null, filename: string | null): void;
  setPdfFile(file: File | null): void;
  setProcessing(status: ProcessingStatus): void;
  setPages(pages: PageResult[]): void;
  setCurrentPage(index: number): void;
  toggleBubble(pageIndex: number, qNum: number, letter: string): void;
  clearEditsForPage(pageIndex: number): void;
  setRosterAssignment(pageIndex: number, name: string | null): void;
  appendLog(line: string, kind?: 'info' | 'warn' | 'err'): void;
  clearLog(): void;
  clearJustProcessed(): void;
  reset(): void;
};

export type LogLine = { kind: 'info' | 'warn' | 'err'; text: string };

export type StoreState = {
  config: SheetConfig;
  keyFilename: string | null;
  key: AnswerKey | null;
  rosterFilename: string | null;
  roster: Roster | null;
  pdfFile: File | null;
  processing: ProcessingStatus;
  pages: PageResult[];
  currentPage: number;
  log: LogLine[];
  /** Flash flag: true in the tick after processing finishes, so the app shell can switch tabs. */
  justProcessed: boolean;
  /** All flags from all pages, flattened — useful for the stats panel. */
  allFlags: Array<Flag & { pageIndex: number }>;
};

function initialState(): StoreState {
  return {
    config: structuredClone(DEFAULT_CONFIG) as SheetConfig,
    keyFilename: null,
    key: null,
    rosterFilename: null,
    roster: null,
    pdfFile: null,
    processing: { kind: 'idle' },
    pages: [],
    currentPage: 0,
    log: [],
    justProcessed: false,
    allFlags: [],
  };
}

class StoreImpl implements Store {
  state: StoreState = initialState();
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach(l => l());
  }

  config(partial: Partial<SheetConfig>): void {
    this.state.config = { ...this.state.config, ...partial };
    this.notify();
  }

  setKey(key: AnswerKey | null, filename: string | null): void {
    this.state.key = key;
    this.state.keyFilename = filename;
    this.notify();
  }

  setRoster(roster: Roster | null, filename: string | null): void {
    this.state.roster = roster;
    this.state.rosterFilename = filename;
    this.notify();
  }

  setPdfFile(file: File | null): void {
    this.state.pdfFile = file;
    this.notify();
  }

  setProcessing(status: ProcessingStatus): void {
    this.state.processing = status;
    this.notify();
  }

  setPages(pages: PageResult[]): void {
    this.state.pages = pages;
    this.state.currentPage = 0;
    this.state.justProcessed = pages.length > 0;
    this.state.allFlags = pages.flatMap((p, i) =>
      p.flags.map(f => ({ ...f, pageIndex: i }))
    );
    this.notify();
  }

  setCurrentPage(index: number): void {
    this.state.currentPage = Math.max(0, Math.min(index, this.state.pages.length - 1));
    this.notify();
  }

  toggleBubble(pageIndex: number, qNum: number, letter: string): void {
    const page = this.state.pages[pageIndex];
    if (!page) return;
    const existing: AnswerSet = page.editedAnswers.get(qNum) ?? new Set();
    const next = new Set(existing);
    if (next.has(letter)) next.delete(letter);
    else next.add(letter);
    page.editedAnswers.set(qNum, next);
    this.notify();
  }

  clearEditsForPage(pageIndex: number): void {
    const page = this.state.pages[pageIndex];
    if (!page) return;
    for (const k of page.editedAnswers.keys()) {
      page.editedAnswers.set(k, new Set());
    }
    this.notify();
  }

  setRosterAssignment(pageIndex: number, name: string | null): void {
    const page = this.state.pages[pageIndex];
    if (!page) return;
    page.rosterName = name;
    this.notify();
  }

  appendLog(line: string, kind: 'info' | 'warn' | 'err' = 'info'): void {
    this.state.log.push({ text: line, kind });
    // Keep log bounded so we don't eat memory on big runs.
    if (this.state.log.length > 500) this.state.log.splice(0, this.state.log.length - 500);
    this.notify();
  }

  clearLog(): void {
    this.state.log = [];
    this.notify();
  }

  clearJustProcessed(): void {
    this.state.justProcessed = false;
    // Do not notify — this is just consuming a transient flag.
  }

  reset(): void {
    this.state = initialState();
    this.notify();
  }
}

export const store: Store = new StoreImpl();
