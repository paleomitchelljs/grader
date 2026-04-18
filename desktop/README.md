# Desktop OMR Scanner (Python / Tkinter)

This is the original Python + Tkinter application for grading BIO145-style bubble sheets. It remains functional but is superseded by the browser-based app in `../web/` — use that instead unless you have a specific reason to prefer the desktop version.

## Quick Start

```bash
# From the desktop/ directory:
python3.14 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python omr_gui.py
```

Or run the CLI directly:

```bash
python omr_scanner.py answers.pdf
```

## Dependencies

### Required
| Package | Purpose |
|---|---|
| `pymupdf` | PDF rendering |
| `opencv-python-headless` | Image processing |
| `numpy` | Array ops |
| `Pillow` | GUI image display |

### Optional
| Package | Purpose |
|---|---|
| `pyzbar` | QR-code orientation detection (needs `brew install zbar`) |
| `pytesseract` | Handwritten-name OCR (needs `brew install tesseract`) |

On macOS the name OCR also falls back to the Apple Vision API via a lazily-compiled Swift helper (requires Xcode Command Line Tools).

## CLI Usage

```bash
python omr_scanner.py answers.pdf                # basic
python omr_scanner.py answers.pdf --key key.csv  # + answer key overlays
python omr_scanner.py answers.pdf --debug        # + grid alignment image
python omr_scanner.py answers.pdf --threshold 0.12
```

Outputs (in the PDF's directory):
- `answers_results.csv` — one row per student, columns `q01`–`qNN`
- `answers_flags.txt` — items flagged for manual review
- `answers_results_key_summary.txt` — item analysis (when `--key` provided)
- `key_overlays/page_NN_overlay.png` — per-page annotated images

## GUI

```bash
python omr_gui.py
```

Two tabs:
- **Scanner** — file pickers, threshold slider, processing log, item-analysis table.
- **Review & Edit** — per-student navigation, editable answer table, editable name combobox (roster typeahead), CSV export.

## Sheet Format

The scanner expects:
- 50 questions in 3 columns (Q1-17, Q18-34, Q35-50) at 6 choices each, by default. Parameterized in `SheetConfig`.
- Four solid-black corner squares and three solid-black column-anchor circles for fiducial calibration. Missing-marker fallback uses the fractions in `SheetConfig`.

Key CSV format (required column: `question_number` + one of `answers` / `answer`):

```csv
question_number,answers
q01,a
q02,bc
```

Roster CSV: any of these column combinations work — `first,last` / `first_name,last_name` / a single `name` column / a single unlabeled column.

## Building a Standalone App

> PyInstaller can't cross-compile. Build on the target OS, or use the GitHub Actions recipe below.

### macOS (tested)

```bash
source venv/bin/activate
pyinstaller --clean -y --name "OMR Scanner" --windowed \
    --add-data "omr_scanner.py:." \
    --collect-all cv2 --collect-all fitz --collect-all pymupdf \
    --collect-all numpy --collect-all PIL \
    --exclude-module pyzbar --exclude-module pytesseract \
    --osx-bundle-identifier com.bio145.omrscanner \
    omr_gui.py
xattr -cr "dist/OMR Scanner.app"
```

Output: `dist/OMR Scanner.app` (~230 MB). Unsigned — distribution requires an Apple Developer ID, which is the main reason this app is being replaced by the web version.

### Windows (untested)

```cmd
pyinstaller --clean -y --name "OMR Scanner" --windowed ^
    --add-data "omr_scanner.py;." ^
    --collect-all cv2 --collect-all fitz --collect-all pymupdf ^
    --collect-all numpy --collect-all PIL ^
    --exclude-module pyzbar --exclude-module pytesseract ^
    omr_gui.py
```

### Cross-platform builds via GitHub Actions

A CI build matrix that produces both the `.app` and `.exe` from any push is a reasonable fallback if the web app ever fails to meet a need. See the project root CLAUDE.md for pointers.

## Notes

- **Dropbox + venv**: the venv hardcodes the path, so moving the parent folder breaks it. Delete and recreate if that happens.
- **Python 3.14** is what this was developed against; 3.10+ should work.
- **Name OCR is unreliable** — prefer manual assignment via the Review tab's roster dropdown.
