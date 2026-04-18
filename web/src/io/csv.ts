/**
 * CSV I/O for answer keys, rosters, and graded output.
 *
 * All parsing uses PapaParse with headers on. Column-name matching is
 * case-insensitive and accepts a few reasonable aliases ("answers" vs "answer",
 * "first" vs "first_name", etc.) to match the desktop app's permissiveness.
 */

import Papa from 'papaparse';
import type { AnswerKey, AnswerSet, Roster } from '../types';

export type KeyParseResult = { key: AnswerKey; warnings: string[] };
export type RosterParseResult = { roster: Roster; warnings: string[] };

/** Read a File (from <input type=file>) as text. */
export async function readFileText(file: File): Promise<string> {
  return file.text();
}

function parseCsv(text: string): { fields: string[]; rows: Record<string, string>[] } {
  const out = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: h => h.trim(),
  });
  return { fields: out.meta.fields ?? [], rows: out.data };
}

function findField(fields: string[], candidates: string[]): string | null {
  const lower = fields.map(f => f.toLowerCase());
  for (const c of candidates) {
    const idx = lower.indexOf(c.toLowerCase());
    if (idx >= 0) return fields[idx] ?? null;
  }
  return null;
}

/** Parse an answer-key CSV. Accepts `question_number` + `answers`/`answer`. */
export function parseAnswerKey(text: string): KeyParseResult {
  const { fields, rows } = parseCsv(text);
  const warnings: string[] = [];

  const qCol = findField(fields, ['question_number', 'question', 'q', 'q_num']);
  const aCol = findField(fields, ['answers', 'answer', 'correct', 'key']);
  if (!qCol) throw new Error(`Answer key needs a column named "question_number". Found: ${fields.join(', ')}`);
  if (!aCol) throw new Error(`Answer key needs a column named "answers" or "answer". Found: ${fields.join(', ')}`);

  const key: AnswerKey = new Map();
  for (const row of rows) {
    const rawQ = (row[qCol] ?? '').trim().toLowerCase().replace(/^q/, '');
    const qNum = Number.parseInt(rawQ, 10);
    if (!Number.isFinite(qNum)) {
      warnings.push(`Skipping row with invalid question number: ${JSON.stringify(row)}`);
      continue;
    }
    const letters = (row[aCol] ?? '').trim().toLowerCase();
    const set: AnswerSet = new Set(letters.split('').filter(c => /[a-z]/.test(c)));
    key.set(qNum, set);
  }

  return { key, warnings };
}

/** Parse a roster CSV. Accepts first/last, last/first, or a single name column. */
export function parseRoster(text: string): RosterParseResult {
  const { fields, rows } = parseCsv(text);
  const warnings: string[] = [];

  const firstCol = findField(fields, ['first', 'first_name', 'firstname', 'given', 'given_name']);
  const lastCol = findField(fields, ['last', 'last_name', 'lastname', 'family', 'family_name', 'surname']);
  const nameCol = findField(fields, ['name', 'full_name', 'fullname', 'student', 'student_name']);

  const roster: Roster = [];
  for (const row of rows) {
    let first = '';
    let last = '';
    if (firstCol && lastCol) {
      first = (row[firstCol] ?? '').trim();
      last = (row[lastCol] ?? '').trim();
    } else if (nameCol) {
      const full = (row[nameCol] ?? '').trim();
      const parts = full.split(/\s+/);
      // Heuristic: if there's a comma, assume "Last, First"; otherwise "First Last".
      if (full.includes(',')) {
        const [l, f] = full.split(',').map(s => s.trim());
        last = l ?? '';
        first = f ?? '';
      } else {
        first = parts.slice(0, -1).join(' ');
        last = parts.slice(-1)[0] ?? '';
      }
    } else if (fields.length >= 1) {
      const raw = (row[fields[0]!] ?? '').trim();
      const parts = raw.split(/\s+/);
      first = parts.slice(0, -1).join(' ');
      last = parts.slice(-1)[0] ?? '';
    } else {
      continue;
    }

    const full = `${first} ${last}`.trim();
    if (!full) continue;
    // Skip header-like rows that slipped through.
    if (/^(name|student|student_name|first|last)$/i.test(full)) continue;

    roster.push({ first, last, full });
  }

  roster.sort((a, b) => a.full.toLowerCase().localeCompare(b.full.toLowerCase()));
  return { roster, warnings };
}

/** Emit a graded results CSV: first,last,q01,q02,...,qNN. */
export function emitResultsCsv(opts: {
  rows: Array<{ first: string; last: string; answers: Map<number, Set<string>> }>;
  numQuestions: number;
}): string {
  const { rows, numQuestions } = opts;
  const qCols: string[] = [];
  for (let i = 1; i <= numQuestions; i++) qCols.push(`q${i.toString().padStart(2, '0')}`);

  const header = ['first', 'last', ...qCols];
  const lines: string[] = [header.join(',')];

  for (const row of rows) {
    const cells: string[] = [csvQuote(row.first), csvQuote(row.last)];
    for (let i = 1; i <= numQuestions; i++) {
      const ans = row.answers.get(i);
      cells.push(ans ? [...ans].sort().join('') : '');
    }
    lines.push(cells.join(','));
  }

  return lines.join('\n') + '\n';
}

function csvQuote(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
