# CLAUDE.md — grader project

Context for Claude Code sessions working in this repo.

## What This Is

A toolkit for grading multiple-choice bubble-sheet exams. Originally a Python desktop app for BIO145 at Coe College; being rebuilt as a static web app hosted on GitHub Pages so it can be used without installation and without any student data leaving the browser.

**Owner**: Jonathan Mitchell (jmitchell@coe.edu, GitHub: paleomitchelljs).
**Repo**: https://github.com/paleomitchelljs/grader
**Deploy target**: https://jonsmitchell.com/grader/

## Three Components

```
web/       Static browser app — primary deliverable (Vite + TS + PDF.js + OpenCV.js)
latex/     A4 bubble-sheet template — TikZ, configurable question/choice/column counts
desktop/   Legacy Python + Tkinter app — still functional, kept as fallback
```

Plus:

```
examples/  Public-safe sample files (fictional roster, sample answer key)
samples/   Gitignored — real exam PDFs and rosters for local dev
```

## Hard Constraints (Do Not Violate)

1. **FERPA compliance.** The web app must be architecturally incapable of exfiltrating student data. That means:
   - No `fetch()` / `XMLHttpRequest` to external endpoints after page load. CDN loads for libraries at page-load are fine if they have no analytics.
   - No `localStorage` / `sessionStorage` writes of student data. UI preferences (thresholds, last-used paper size) may persist.
   - No analytics, telemetry, error-reporting services, or third-party tracking.
   - A visible "all processing is local; nothing is uploaded" banner in the UI.

2. **Static hosting only.** The web app runs on GitHub Pages. No backend, no Python server, no build-time secrets.

3. **Real student data never gets committed.** `roster.csv` and any real exam PDFs belong in the gitignored `samples/` directory. Anything checked in under `examples/` must use fictional names.

## Core Engine Behavior (unchanged between desktop and web)

- Renders each PDF page to an image.
- Detects fiducial markers on the sheet: four solid-black corner squares plus one solid-black anchor circle above the first bubble of each column.
- Uses the markers to compute a bubble grid; falls back to hardcoded geometry in `SheetConfig` if markers aren't found.
- Samples bubble darkness at each expected centre; flags multi-selects and near-threshold marks.
- Scoring model: each question treated as N independent true/false items (one per choice). A question is "fully correct" only if all N choices match the key (correct ones selected, incorrect ones not).
- Answer key CSV requires a `question_number` column plus one of `answers` / `answer` (case-insensitive). Multi-letter values (e.g. `abcde`) mean "any of these counts" for select-all-that-apply items.

## Critical UX Requirement

**The manual-edit flow is the centerpiece**, not a secondary feature. Students regularly mark A, cross it out, then mark B — the CV reads both. A fast, clickable override must land every fix directly in the downloaded CSV (no "apply" step, no separate save). Same for roster assignment: show the cropped handwriting and a type-to-filter dropdown — never rely on OCR for identity.

## Conventions

- No emojis in code or docs unless the user asks for them.
- No comments that merely restate what the code does. Save a comment for a non-obvious "why" — a hidden constraint, a subtle invariant, a surprising workaround.
- Prefer editing existing files to creating new ones.
- Don't add abstractions beyond what the task requires.
- When touching the scanner's marker detection or bubble sampling, re-run against a test PDF to verify nothing regressed before calling it done.

## Phase Status (as of 2026-04-17)

1. Codebase read-through — ✅ done
2. Repo cleanup + initial git commit — ✅ done (you are here)
3. Web app build-out — 🚧 not started
4. LaTeX template — 🚧 not started

Always verify this status by inspecting the repo before assuming — the web and latex dirs may contain real code by the time you read this.
