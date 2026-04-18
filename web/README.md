# web/ — Browser-Based OMR Grader

Static single-page app that grades scanned bubble sheets entirely in the browser. Hosted at [jonsmitchell.com/grader/](https://jonsmitchell.com/grader/) via GitHub Pages.

## Quickstart

```bash
cd web
npm install
npm run dev        # http://localhost:5173/grader/
npm run build      # typechecks, then emits ../docs/ (the Pages source)
npm run typecheck  # tsc --noEmit
```

## Stack

- **Vite + vanilla TypeScript** — minimal build tooling, no framework.
- **PDF.js** (`pdfjs-dist`) — rasterizes uploaded PDFs to canvases.
- **OpenCV.js** (`@techstark/opencv-js`) — fiducial-marker detection and contour analysis.
- **pdf-lib** — stitches annotated page images into a downloadable overlay PDF.
- **PapaParse** — CSV parsing.

## Design Principles

- **Local-only.** No `fetch()` after page load. No cookies. No persistent storage of student data. Closing the tab erases everything.
- **Edit flow is the centerpiece.** Click any bubble on the overlay to toggle it — edits feed both the downloaded CSV and the annotated PDF. A "Clear all edits" button on each page is the escape hatch when a scan is so noisy that manual entry beats correcting detection.
- **No OCR.** The cropped name-handwriting region sits next to a type-to-filter roster dropdown. Manual assignment is faster and more accurate than OCR.
- **Configurable.** `numQuestions`, `numChoices`, `numColumns`, `fillThreshold` are UI inputs, defaulting to 50 / 6 / 3 / 0.14.

## Layout

```
web/
├── index.html
├── vite.config.ts
├── src/
│   ├── main.ts              # entry — mounts the app shell
│   ├── types.ts             # shared types, DEFAULT_CONFIG, defaultColumns()
│   ├── state.ts             # pub/sub store (all transient state)
│   ├── processor.ts         # top-level grading pipeline orchestrator
│   ├── pdf/load.ts          # PDF.js wrapper → ImageBitmaps
│   ├── cv/                  # OpenCV.js wrappers: markers, orient, grid, bubbles, overlay, pipeline
│   ├── domain/              # scoring + item-analysis stats
│   ├── io/csv.ts            # answer-key / roster / results parsers
│   └── ui/                  # upload, review, stats panels + shared styles
```

## Deploying

GitHub Pages is configured to serve the `docs/` directory on `main`. `npm run build` emits directly into `../docs/` (see `outDir` in `vite.config.ts`), so deploying is: build, commit `docs/`, push. A `.nojekyll` file in `docs/` keeps Pages from running Jekyll on the output.

The `base` in `vite.config.ts` is `/grader/` to match the Pages URL.
