/**
 * Scoring model.
 *
 * Each question is treated as N independent true/false items, one per choice.
 * A student gets credit for every choice they correctly *include* or
 * correctly *exclude*. "Fully correct" on a question means all N choices
 * match the key.
 *
 * Matches the desktop app (omr_scanner.py :: compute_summary_stats).
 */

import type { AnswerKey, AnswersByQuestion, SheetConfig } from '../types';
import { choiceLetter } from '../types';

export type StudentScore = {
  tfItems: number;       // count of correctly-answered T/F items (out of maxPossible)
  fullyCorrect: number;  // count of questions with all N choices matching key
};

/** Score a single student's answers against the key. */
export function scoreStudent(
  answers: AnswersByQuestion,
  key: AnswerKey,
  config: SheetConfig,
): StudentScore {
  let tfItems = 0;
  let fullyCorrect = 0;
  for (let q = 1; q <= config.numQuestions; q++) {
    const correct = key.get(q) ?? new Set<string>();
    const student = answers.get(q) ?? new Set<string>();
    let allMatch = true;
    for (let c = 0; c < config.numChoices; c++) {
      const letter = choiceLetter(c);
      const shouldSelect = correct.has(letter);
      const didSelect = student.has(letter);
      if (shouldSelect === didSelect) tfItems++;
      else allMatch = false;
    }
    if (allMatch) fullyCorrect++;
  }
  return { tfItems, fullyCorrect };
}

export function maxPossibleTfItems(config: SheetConfig): number {
  return config.numQuestions * config.numChoices;
}
