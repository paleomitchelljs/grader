/**
 * Item analysis.
 *
 * Computes per-question statistics across a batch of students:
 *   - % fully correct
 *   - Point-biserial correlation with overall score
 *   - Shannon entropy of the response distribution
 *   - Most frequently selected wrong choice (with count)
 *   - Most frequently missed correct choice (with count)
 *
 * Ports omr_scanner.py :: compute_summary_stats().
 */

import type {
  AnswerKey, AnswersByQuestion, QuestionStat, SheetConfig, SummaryStats,
} from '../types';
import { choiceLetter } from '../types';
import { scoreStudent, maxPossibleTfItems } from './scoring';

export function computeSummaryStats(
  allAnswers: AnswersByQuestion[],
  key: AnswerKey,
  config: SheetConfig,
): SummaryStats {
  const numStudents = allAnswers.length;
  const maxPossible = maxPossibleTfItems(config);

  if (numStudents === 0) {
    return {
      numStudents: 0,
      numQuestions: config.numQuestions,
      maxPossible,
      meanScore: 0,
      meanPct: 0,
      questionStats: [],
      flags: [],
    };
  }

  // Per-student T/F-item scores.
  const studentScores = allAnswers.map(a => scoreStudent(a, key, config).tfItems);
  const meanScore = studentScores.reduce((s, v) => s + v, 0) / numStudents;
  const variance = studentScores.reduce((s, v) => s + (v - meanScore) ** 2, 0) / numStudents;
  const stdDev = variance > 0 ? Math.sqrt(variance) : 1;

  const questionStats: QuestionStat[] = [];

  for (let qNum = 1; qNum <= config.numQuestions; qNum++) {
    const correctSet = key.get(qNum) ?? new Set<string>();
    const correctKey = [...correctSet].sort().join('').toUpperCase();

    // Collect per-student response sets and the fully-correct flag.
    const responses: Set<string>[] = [];
    const fullyCorrectMask: boolean[] = [];
    for (const answers of allAnswers) {
      const s = answers.get(qNum) ?? new Set<string>();
      responses.push(s);

      let allMatch = true;
      for (let c = 0; c < config.numChoices; c++) {
        const letter = choiceLetter(c);
        if (correctSet.has(letter) !== s.has(letter)) { allMatch = false; break; }
      }
      fullyCorrectMask.push(allMatch);
    }

    const numFullyCorrect = fullyCorrectMask.filter(Boolean).length;
    const pctCorrect = numFullyCorrect / numStudents * 100;

    // Point-biserial correlation using "fully correct" as the binary grouping.
    let r_pb = 0;
    const correctIdx: number[] = [];
    const incorrectIdx: number[] = [];
    fullyCorrectMask.forEach((ok, i) => (ok ? correctIdx : incorrectIdx).push(i));
    if (correctIdx.length > 0 && incorrectIdx.length > 0) {
      const m1 = correctIdx.reduce((s, i) => s + studentScores[i]!, 0) / correctIdx.length;
      const m0 = incorrectIdx.reduce((s, i) => s + studentScores[i]!, 0) / incorrectIdx.length;
      const p = correctIdx.length / numStudents;
      const q = 1 - p;
      r_pb = stdDev > 0 ? ((m1 - m0) / stdDev) * Math.sqrt(p * q) : 0;
    }

    // Response entropy.
    const responseCounts = new Map<string, number>();
    for (const r of responses) {
      const k = [...r].sort().join('');
      responseCounts.set(k, (responseCounts.get(k) ?? 0) + 1);
    }
    let entropy = 0;
    for (const count of responseCounts.values()) {
      if (count > 0) {
        const prob = count / numStudents;
        entropy -= prob * Math.log2(prob);
      }
    }

    // Most-selected wrong choice.
    const wrongCounts = new Map<string, number>();
    for (const r of responses) {
      for (const letter of r) {
        if (!correctSet.has(letter)) wrongCounts.set(letter, (wrongCounts.get(letter) ?? 0) + 1);
      }
    }
    const mostWrong = pickMax(wrongCounts);

    // Most-missed correct choice.
    const missedCounts = new Map<string, number>();
    for (const r of responses) {
      for (const letter of correctSet) {
        if (!r.has(letter)) missedCounts.set(letter, (missedCounts.get(letter) ?? 0) + 1);
      }
    }
    const mostMissed = pickMax(missedCounts);

    questionStats.push({
      qNum,
      correctKey,
      numFullyCorrect,
      pctCorrect,
      pointBiserial: r_pb,
      entropy,
      mostWrong,
      mostMissed,
    });
  }

  const flags: string[] = [];
  for (const s of questionStats) {
    if (s.pctCorrect < 30) flags.push(`Q${s.qNum}: very low success rate (${s.pctCorrect.toFixed(1)}%)`);
    if (s.pointBiserial < 0) flags.push(`Q${s.qNum}: negative correlation (${s.pointBiserial.toFixed(3)})`);
    if (s.pctCorrect > 95) flags.push(`Q${s.qNum}: very high success rate (${s.pctCorrect.toFixed(1)}%)`);
  }

  return {
    numStudents,
    numQuestions: config.numQuestions,
    maxPossible,
    meanScore,
    meanPct: meanScore / maxPossible * 100,
    questionStats,
    flags,
  };
}

function pickMax(counts: Map<string, number>): { letter: string; count: number } | null {
  let best: { letter: string; count: number } | null = null;
  for (const [letter, count] of counts) {
    if (!best || count > best.count) best = { letter: letter.toUpperCase(), count };
  }
  return best;
}
