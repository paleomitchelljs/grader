# web/ — Browser-Based OMR Grader

Static single-page app that grades scanned bubble sheets entirely in the browser. Hosted at [jonsmitchell.com/grader/](https://jonsmitchell.com/grader/) via GitHub Pages.

**Status**: not yet scaffolded. This directory is a placeholder.

## Planned Stack

- **Vite + vanilla TypeScript** — minimal build tooling, no framework lock-in.
- **PDF.js** — renders uploaded PDFs to canvases.
- **OpenCV.js** — fiducial marker detection and contour analysis.
- **pdf-lib** — stitches annotated page images into a downloadable overlay PDF.

## Design Principles

- **Local-only.** No `fetch()` to external APIs after page load. No cookies. No persistent storage of student data.
- **Edit flow is the centerpiece.** Clickable bubble overlay — toggle any detected answer to fix CV mistakes. Edits feed the downloaded CSV directly.
- **No OCR.** Show the cropped name-handwriting region next to a type-to-filter roster dropdown. Manual assignment is faster and more accurate than the current OCR approach.
- **Configurable**. `num_questions`, `num_choices`, `num_columns` as UI inputs, defaulting to 50/6/3.
