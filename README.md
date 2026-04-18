# grader

Tools for grading multiple-choice bubble-sheet exams, originally built for BIO145 at Coe College.

Three components, each in its own directory:

| Directory | What it is |
|---|---|
| [`web/`](web/) | **Primary tool.** Browser-based OMR grader — drop in a scanned PDF, a key, and a roster; get a graded CSV and an annotated overlay PDF back. Everything runs locally in the browser. Hosted at [jonsmitchell.com/grader/](https://jonsmitchell.com/grader/). |
| [`latex/`](latex/) | LaTeX source for the bubble-sheet template the grader reads. A4, configurable number of questions / choices / columns, with robust fiducial markers. |
| [`desktop/`](desktop/) | Original Python + Tkinter app. Still works; kept as a reference and fallback. |

## FERPA and Privacy

The web app is deliberately architected so student data **cannot** leave your browser:

- Hosted as pure static files on GitHub Pages — no backend, no server, no API to exfiltrate to.
- No uploads of any kind. Your PDF, roster, and answer key never leave your machine.
- No `localStorage` or `sessionStorage` writes for student data — closing the tab wipes everything.
- No analytics, telemetry, or third-party services.

The real student roster file and real exam PDFs are kept in a gitignored `samples/` directory in this repo and must never be committed. The `examples/` directory contains fictional sample data safe for public use.

## Quick Start

The web app is the intended entry point for most users — just visit [jonsmitchell.com/grader/](https://jonsmitchell.com/grader/). For development or the desktop fallback, see the per-directory READMEs.

## Workflow

1. Print blank bubble sheets from `latex/` (or your own sheets that match its marker layout).
2. Students fill them out during the exam.
3. Scan the stack to a single PDF.
4. Open [jonsmitchell.com/grader/](https://jonsmitchell.com/grader/), choose your PDF + key CSV + roster CSV.
5. Scanner reads each page, produces an overlay; you review and click any bubbles it got wrong.
6. Assign a roster name to each sheet (pick from a type-to-filter dropdown — no OCR).
7. Download the graded CSV and the annotated overlay PDF.

## Repository Layout

```
.
├── README.md                  (this file)
├── CLAUDE.md                  context for Claude Code sessions
├── .gitignore
├── web/                       browser app (phase 3 — in progress)
├── latex/                     bubble-sheet template (phase 4 — in progress)
├── desktop/                   legacy Python/Tkinter app
├── examples/                  public-safe fixtures (fake roster, sample key)
└── samples/                   gitignored; real PDFs and roster live here
```

## License

TBD. Likely MIT or similar permissive.
