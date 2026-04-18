# Examples

Public-safe sample files for testing the grader. All names and identifiers here are fictional.

| File | Purpose |
|---|---|
| `sample_key.csv` | Answer key matching a 50-question, 6-choice exam. Columns `question_number`, `answers`. Multi-letter values (e.g. `abcde`) mean "any of these counts as correct" — a "select all that apply" style question treated as six T/F items. |
| `sample_roster.csv` | Fake student roster with `last,first` columns. |

A sample answer-sheet PDF is **not** committed here because the only real-world PDFs we have contain handwritten student names and are FERPA-protected. Once the LaTeX template in `../latex/` is in place, a blank sample sheet can be generated and committed.

For local testing, keep real exam PDFs in the repo-root `samples/` directory, which is gitignored.
