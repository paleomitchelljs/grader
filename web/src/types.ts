/**
 * Shared types for the grader web app.
 *
 * Terminology:
 *   - "choice" is a single letter (a, b, c, d, e, f)
 *   - "answer set" is the set of choices selected for one question
 *   - "detected" = what the CV found; "edited" = what the grader has since clicked
 *   - "fully correct" = the student's edited answer set exactly matches the key's set
 */

export type Choice = string;                    // single lowercase letter
export type AnswerSet = Set<Choice>;            // set of chosen letters
export type AnswersByQuestion = Map<number, AnswerSet>;

export type SheetConfig = {
  numQuestions: number;          // default 50
  numChoices: number;            // default 6 (A-F)
  numColumns: number;            // default 3
  /** How dark a bubble must be (0-1) to count as filled. */
  fillThreshold: number;         // default 0.14
  /** Approximate radius of a bubble at the rendering DPI, in pixels. */
  bubbleRadius: number;          // default 15
  /** Per-column question ranges, 1-indexed inclusive. Derived from numQuestions/numColumns. */
  columns: ReadonlyArray<readonly [number, number]>;
  /** Layout fallback fractions used when fiducial markers can't be found. */
  fallback: LayoutFallback;
  /** Name-region crop coordinates (fractions of the oriented page). */
  nameRegion: { top: number; bottom: number; left: number; right: number };
};

export type LayoutFallback = {
  bubbleAreaTop: number;         // center y of first row, as fraction of height
  bubbleAreaBottom: number;      // center y of last row (17th for 50q/3col)
  colFractions: ReadonlyArray<readonly [number, number]>; // (left, right) per column
};

export type Flag = { question?: number; message: string };

export type Markers = {
  tl: [number, number];
  tr: [number, number];
  bl: [number, number] | null;
  br: [number, number] | null;
  blY: number;
  anchors: ReadonlyArray<readonly [number, number]>; // column anchor circles, one per column
};

export type GridParams = {
  topY: number;                  // center y of row 0
  bottomY: number;               // center y of the last row in a full column
  colBounds: ReadonlyArray<readonly [number, number]>; // (left, right) in pixels
  anchorXs: ReadonlyArray<number> | null; // x-centre of the "a" bubble per column, if markers used
  bubblePitch: number | null;    // inter-bubble spacing in px, if markers used
  markersUsed: boolean;
};

export type PageResult = {
  pageIndex: number;             // 0-based
  orientedImage: ImageBitmap;    // rotated to correct orientation
  width: number;
  height: number;
  detectedAnswers: AnswersByQuestion;
  editedAnswers: AnswersByQuestion;
  flags: Flag[];
  gridParams: GridParams;
  nameCrop: ImageBitmap | null;
  /** Assigned roster full name ("First Last"), or null if not yet assigned. */
  rosterName: string | null;
};

export type AnswerKey = Map<number, AnswerSet>;

export type Roster = Array<{ first: string; last: string; full: string }>;

export type QuestionStat = {
  qNum: number;
  correctKey: string;           // upper-case letters, e.g. "AC"
  numFullyCorrect: number;
  pctCorrect: number;
  pointBiserial: number;
  entropy: number;
  mostWrong: { letter: string; count: number } | null;
  mostMissed: { letter: string; count: number } | null;
};

export type SummaryStats = {
  numStudents: number;
  numQuestions: number;
  maxPossible: number;
  meanScore: number;
  meanPct: number;
  questionStats: QuestionStat[];
  flags: string[];
};

export const DEFAULT_CONFIG: SheetConfig = {
  numQuestions: 50,
  numChoices: 6,
  numColumns: 3,
  fillThreshold: 0.14,
  bubbleRadius: 15,
  columns: [[1, 17], [18, 34], [35, 50]] as const,
  fallback: {
    bubbleAreaTop: 0.219,
    bubbleAreaBottom: 0.707,
    colFractions: [[0.115, 0.323], [0.405, 0.614], [0.693, 0.901]] as const,
  },
  nameRegion: { top: 0.085, bottom: 0.12, left: 0.06, right: 0.65 },
};

/**
 * Compute default column ranges for a given total question count and column count.
 * Distributes extra questions to the earliest columns so each column is within 1 of the average.
 */
export function defaultColumns(numQuestions: number, numColumns: number): ReadonlyArray<readonly [number, number]> {
  const base = Math.floor(numQuestions / numColumns);
  const extra = numQuestions % numColumns;
  const result: Array<readonly [number, number]> = [];
  let start = 1;
  for (let i = 0; i < numColumns; i++) {
    const size = base + (i < extra ? 1 : 0);
    result.push([start, start + size - 1] as const);
    start += size;
  }
  return result;
}

export const CHOICE_LETTERS = 'abcdefghijklmnopqrstuvwxyz';

export function choiceLetter(i: number): string {
  return CHOICE_LETTERS[i] ?? '?';
}
