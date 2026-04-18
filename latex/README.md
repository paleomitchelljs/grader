# latex/ — Bubble Sheet Template

LaTeX source for the A4 bubble sheet the grader reads.

**Status**: not yet written. This directory is a placeholder.

## Planned Features

- A4 paper.
- Configurable macros at top of `.tex`:
  - `\NumQuestions{50}`
  - `\NumChoices{6}`
  - `\NumColumns{3}`
- Name-and-date header with a generous handwriting region.
- **Robust fiducial markers** — the main reliability win over the current sheet:
  - Solid-filled corner squares at all four corners.
  - Solid-filled column anchor circles above the first bubble of each column.
  - Side-midpoint anchors so 1–2 clipped corners still leave enough markers for an affine fit.
  - Generous quiet zone around every marker.

The scanner self-calibrates from the markers, so there are no hardcoded geometric constants shared between the template and the grader — but the grader does need to be told the question/choice/column counts, which the user types in the web UI to match what the sheet was compiled with.
