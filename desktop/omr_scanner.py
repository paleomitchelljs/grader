#!/usr/bin/env python3
"""
OMR (Optical Mark Recognition) Scanner for Exam Bubble Sheets

Processes a multi-page PDF of scanned bubble sheets and extracts answers to CSV.
Designed for sheets with 50 questions in 3 columns.

The new sheet format includes fiducial markers for automatic calibration:
  - Four solid black corner squares marking the corners of the bubble reading area
  - Three solid black circles above the "a" bubble in each column (column anchors)
When detected, these markers override the hardcoded SheetConfig layout fractions.

Usage:
    python omr_scanner.py answers.pdf [output.csv] [flags.txt]

Requirements:
    pip install pymupdf opencv-python numpy

Optional (for QR code orientation detection):
    brew install zbar && pip install pyzbar
"""

import argparse
import csv
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional

import cv2
import numpy as np
import fitz  # PyMuPDF - no external dependencies needed

# pyzbar is optional - used for QR code orientation detection
try:
    from pyzbar.pyzbar import decode as decode_qr
    PYZBAR_AVAILABLE = True
except ImportError:
    PYZBAR_AVAILABLE = False
    decode_qr = None

# pytesseract is optional - used for OCR of handwritten student names
try:
    import pytesseract
    PYTESSERACT_AVAILABLE = True
except ImportError:
    PYTESSERACT_AVAILABLE = False
    pytesseract = None

# macOS Vision OCR: compiled lazily on first use when pytesseract is unavailable.
# Requires swiftc (ships with Xcode Command Line Tools).
_VISION_BINARY: Optional[str] = None
_VISION_TRIED: bool = False

_VISION_SWIFT_SRC = """\
import Vision
import AppKit
import Foundation

guard CommandLine.arguments.count > 1 else { exit(1) }
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let img = NSImage(contentsOf: url),
      let cg  = img.cgImage(forProposedRect: nil, context: nil, hints: nil)
else { exit(1) }

let sem = DispatchSemaphore(value: 0)
let req = VNRecognizeTextRequest { r, _ in
    let obs = r.results as? [VNRecognizedTextObservation] ?? []
    let text = obs.compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
    print(text)
    sem.signal()
}
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false
try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
sem.wait()
"""


def _get_vision_binary() -> Optional[str]:
    """Lazily compile the macOS Vision OCR helper and return its path, or None."""
    global _VISION_BINARY, _VISION_TRIED
    if _VISION_TRIED:
        return _VISION_BINARY
    _VISION_TRIED = True

    if sys.platform != 'darwin':
        return None

    try:
        src = tempfile.NamedTemporaryFile(mode='w', suffix='.swift', delete=False)
        src.write(_VISION_SWIFT_SRC)
        src.close()
        out = tempfile.mktemp(suffix='_omr_vision')
        result = subprocess.run(
            ['swiftc', '-o', out, src.name],
            capture_output=True, timeout=60
        )
        os.unlink(src.name)
        if result.returncode == 0 and os.path.exists(out):
            _VISION_BINARY = out
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass

    return _VISION_BINARY


# =============================================================================
# CONFIGURATION - Adjust these values based on your specific bubble sheet layout
# =============================================================================

@dataclass
class SheetConfig:
    """Configuration for the bubble sheet layout."""

    # Number of questions and answer choices
    num_questions: int = 50
    num_choices: int = 6  # A, B, C, D, E, F

    # Column layout: which questions are in each column
    # Format: [(start_q, end_q), ...]  (1-indexed, inclusive)
    columns: tuple = ((1, 17), (18, 34), (35, 50))

    # Bubble detection parameters
    fill_threshold: float = 0.14    # How dark a bubble must be to count as filled (0-1)
    bubble_radius: int = 15         # Approximate radius of bubbles in pixels at 200 DPI

    # Layout parameters (as fractions of page dimensions).
    # Used as fallback when fiducial marker detection fails.
    # Calibrated from the 2026 sheet at 200 DPI (1700×2200 px):
    #   Q1 center at y=481 (0.219), Q17 center at y=1556 (0.707)
    bubble_area_top: float = 0.219      # Center of first row (Q1/Q18/Q35)
    bubble_area_bottom: float = 0.707   # Center of row 17 (Q17/Q34)

    # Column X positions (edges of bubble area, as fraction of width).
    # Fallback values; marker detection replaces these when available.
    # Col 1: "a" at x=224, "f" at x=519; col 2: 718–1013; col 3: 1206–1501
    col1_left: float = 0.115   # ~30px before col 1 "a"
    col1_right: float = 0.323  # ~30px after  col 1 "f"
    col2_left: float = 0.405   # ~30px before col 2 "a"
    col2_right: float = 0.614  # ~30px after  col 2 "f"
    col3_left: float = 0.693   # ~30px before col 3 "a"
    col3_right: float = 0.901  # ~30px after  col 3 "f"

    # Name region (handwritten name area in sheet header)
    name_region_top: float = 0.085
    name_region_bottom: float = 0.12
    name_region_left: float = 0.06
    name_region_right: float = 0.65


# =============================================================================
# CORE OMR FUNCTIONS
# =============================================================================

def load_pdf_pages(pdf_path: str, dpi: int = 200) -> list:
    """Convert PDF pages to numpy arrays (images) using PyMuPDF."""
    print(f"Loading PDF: {pdf_path}")
    doc = fitz.open(pdf_path)
    images = []
    zoom = dpi / 72  # 72 is the default PDF resolution
    matrix = fitz.Matrix(zoom, zoom)

    for i, page in enumerate(doc):
        # Render page to pixmap
        pix = page.get_pixmap(matrix=matrix)
        # Convert to numpy array
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
            pix.height, pix.width, pix.n
        )
        # Convert RGB to BGR for OpenCV (if needed)
        if pix.n == 3:
            img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
        elif pix.n == 4:
            img = cv2.cvtColor(img, cv2.COLOR_RGBA2BGR)
        images.append(img)
        print(f"  Loaded page {i + 1}/{len(doc)}")

    doc.close()
    return images


def _find_marker_candidates(image: np.ndarray) -> tuple[list, list]:
    """
    Find corner-square and anchor-circle candidates in an image.
    Returns (corner_candidates, anchor_candidates) sorted by cy.
    """
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 60, 255, cv2.THRESH_BINARY_INV)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    corners = []
    anchors = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < 300 or area > 1200:
            continue
        x, y, cw, ch = cv2.boundingRect(cnt)
        cx, cy = x + cw // 2, y + ch // 2
        aspect = max(cw, ch) / max(min(cw, ch), 1)
        fill = area / (cw * ch)
        perim = cv2.arcLength(cnt, True)
        circ = 4 * np.pi * area / (perim ** 2) if perim > 0 else 0
        if fill > 0.65 and aspect < 1.5 and cw < 40 and ch < 40 and 0.10 * h < cy < 0.90 * h:
            entry = {'cx': cx, 'cy': cy, 'circ': circ, 'fill': fill}
            if circ < 0.82 and fill > 0.80:
                corners.append(entry)
            elif circ > 0.82:
                anchors.append(entry)

    corners.sort(key=lambda m: m['cy'])
    anchors.sort(key=lambda m: m['cy'])
    return corners, anchors


def orient_image(image: np.ndarray) -> tuple[np.ndarray, bool]:
    """
    Detect and correct image orientation using fiducial markers.

    Strategy: the sheet has corner squares and anchor circles.  In the correct
    orientation the anchor circles sit near the TOP of the sheet (same row as
    the top corner squares).  If we find anchors clustered near the bottom
    instead, the page is upside-down and we rotate 180°.

    Falls back to QR-code detection if markers are insufficient.
    Returns (oriented_image, orientation_detected).
    """
    h, w = image.shape[:2]

    # --- Try marker-based orientation first ---
    corners, anchors = _find_marker_candidates(image)

    if len(corners) >= 2 and len(anchors) >= 3:
        # Top 2 corners by cy → expected top-corner row
        top2 = corners[:2]
        top_corner_y = (top2[0]['cy'] + top2[1]['cy']) / 2.0

        # Anchor circles cluster – compute mean y
        # Take the 3 anchors closest to each other vertically (they share a row)
        anchors_by_cy = sorted(anchors, key=lambda m: m['cy'])
        best_group = anchors_by_cy[:3]
        if len(anchors_by_cy) > 3:
            best_spread = max(a['cy'] for a in best_group) - min(a['cy'] for a in best_group)
            for i in range(1, len(anchors_by_cy) - 2):
                group = anchors_by_cy[i:i+3]
                spread = group[-1]['cy'] - group[0]['cy']
                if spread < best_spread:
                    best_spread = spread
                    best_group = group
        anchor_mean_y = sum(a['cy'] for a in best_group) / 3.0

        # In correct orientation, anchors are near the top corners (within ~5% of h).
        # If anchors are well below the top corners, the sheet is upside-down.
        anchors_near_top = abs(anchor_mean_y - top_corner_y) < 0.08 * h
        anchors_in_bottom_half = anchor_mean_y > h * 0.5

        if anchors_near_top and not anchors_in_bottom_half:
            # Already correct orientation
            return image, True
        elif anchors_in_bottom_half:
            # Upside-down – rotate 180°
            return cv2.rotate(image, cv2.ROTATE_180), True

    # --- Fallback: QR-code detection ---
    if PYZBAR_AVAILABLE:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        qr_codes = decode_qr(gray)

        if len(qr_codes) >= 2:
            positions = [(qr.rect.left + qr.rect.width/2,
                         qr.rect.top + qr.rect.height/2) for qr in qr_codes]
            top_qr = min(positions, key=lambda p: p[1])

            if top_qr[0] > w * 0.6:
                image = cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
            elif top_qr[0] < w * 0.4 and top_qr[1] > h * 0.5:
                image = cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
            elif all(p[1] > h * 0.5 for p in positions[:2]):
                image = cv2.rotate(image, cv2.ROTATE_180)

            return image, True

    return image, False


def detect_sheet_markers(image: np.ndarray) -> Optional[dict]:
    """
    Detect the fiducial markers printed on the new sheet format.

    Markers:
      - 4 solid black corner squares (~27×28 px) at the corners of the reading area
      - 3 solid black circles (~30×31 px) above the "a" bubble in each column

    Corner squares have high fill (>0.80) and low circularity (<0.82).
    Anchor circles have high circularity (>0.82) and moderate fill.
    Both are smaller than unfilled answer bubbles (~46 px).

    Returns a dict with keys:
        'tl', 'tr', 'bl', 'br'  – (cx, cy) of each corner square
        'anchors'                – [(cx, cy), ...] for col 1/2/3 anchor circles
    Returns None if fewer than 2 top corners or 3 anchor circles are found.
    """
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 60, 255, cv2.THRESH_BINARY_INV)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    candidates = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < 300 or area > 1200:
            continue
        x, y, cw, ch = cv2.boundingRect(cnt)
        cx, cy = x + cw // 2, y + ch // 2
        aspect = max(cw, ch) / max(min(cw, ch), 1)
        fill = area / (cw * ch)
        perim = cv2.arcLength(cnt, True)
        circ = 4 * np.pi * area / (perim ** 2) if perim > 0 else 0
        # Small solid shapes inside the reading-area band (avoids QR codes)
        if fill > 0.65 and aspect < 1.5 and cw < 40 and ch < 40 and 0.10 * h < cy < 0.90 * h:
            candidates.append({'cx': cx, 'cy': cy, 'w': cw, 'h': ch, 'circ': circ, 'fill': fill})

    # Corner squares: squarish (low circularity), very solid fill
    corner_cands = sorted(
        [m for m in candidates if m['circ'] < 0.82 and m['fill'] > 0.80],
        key=lambda m: m['cy']
    )
    # Anchor circles: circular (high circularity)
    anchor_cands = [m for m in candidates if m['circ'] > 0.82]

    if len(corner_cands) < 2 or len(anchor_cands) < 3:
        return None

    # Top two corners (smallest cy)
    top_corners = sorted(corner_cands[:2], key=lambda m: m['cx'])
    if len(top_corners) < 2:
        return None
    tl, tr = top_corners[0], top_corners[1]
    top_y_mean = (tl['cy'] + tr['cy']) / 2.0

    # Bottom corners (largest cy), tolerate one missing (e.g. obscured by student ink)
    bot_corners = sorted(corner_cands[-2:], key=lambda m: m['cx'])
    bl = bot_corners[0] if len(bot_corners) >= 1 else None
    br = bot_corners[1] if len(bot_corners) >= 2 else None

    # Determine bl_y (needed for row calibration).
    # BL is below col-1 Q17; BR is below col-3 Q50 (one row earlier).
    # If BL is missing, estimate from BR: BL_y ≈ BR_y + 1 row_height + ~2 px
    # At 200 DPI (h=2200), that offset is ~69 px.
    if bl is not None and bl['cy'] > top_y_mean + 0.3 * h:
        bl_y = float(bl['cy'])
        br_y = float(br['cy']) if br is not None and br['cy'] > top_y_mean + 0.3 * h else None
    elif br is not None and br['cy'] > top_y_mean + 0.3 * h:
        br_y = float(br['cy'])
        bl_y = br_y + 69.0 * (h / 2200.0)   # estimated
        bl = None                              # mark as estimated
    else:
        return None  # no usable bottom corner

    # Anchor circles near the top corners (same header row)
    top_anchors = sorted(
        [m for m in anchor_cands if abs(m['cy'] - top_y_mean) < 50],
        key=lambda m: m['cx']
    )
    if len(top_anchors) < 3:
        return None

    return {
        'tl': (tl['cx'], tl['cy']),
        'tr': (tr['cx'], tr['cy']),
        'bl': (bl['cx'], bl['cy']) if bl is not None else None,
        'br': (br['cx'], br['cy']) if br is not None else None,
        'bl_y': bl_y,
        'anchors': [(a['cx'], a['cy']) for a in top_anchors[:3]],
    }


def _compute_grid_params(image: np.ndarray, config: SheetConfig) -> dict:
    """
    Return calibrated bubble-grid parameters, using detected markers when available.

    Calibration constants (derived from blank 2026 sheet at 200 DPI, h=2200):
      FIRST_ROW_FRAC  – fraction of (bl_y − top_corner_y) where Q1 row center lies
      LAST_ROW_FRAC   – same fraction for Q17 row center
      BUBBLE_X_PITCH  – inter-bubble x spacing as fraction of image width (59/1700)

    Returns a dict with:
        top_y        – y of first bubble row (Q1/Q18/Q35)
        bottom_y     – y of 17th bubble row (Q17/Q34 baseline for row spacing)
        col_bounds   – list of (col_left, col_right) in pixels for each column
        anchor_xs    – list of "a"-bubble x-centers (from markers, else None)
        bubble_pitch – inter-bubble x spacing in pixels (from markers, else None)
        markers_used – True if marker-based calibration was applied
    """
    h, w = image.shape[:2]
    markers = detect_sheet_markers(image)

    BUBBLE_X_PITCH = 59.0 / 1700.0   # inter-bubble spacing as fraction of width
    # Row height as a fraction of the horizontal TL–TR span.  This ratio is
    # a physical constant of the printed sheet and immune to per-scan vertical
    # misdetection of bottom corners.  Calibrated from the blank 2026 sheet:
    #   row_height ≈ 69.3 px when TL–TR span ≈ 1387 px  →  ratio ≈ 0.04997
    ROW_HEIGHT_RATIO = 0.04831

    if markers:
        anchor_y = np.mean([a[1] for a in markers['anchors']])
        h_span = markers['tr'][0] - markers['tl'][0]   # always ~1387 px
        row_height = ROW_HEIGHT_RATIO * h_span

        top_y    = int(anchor_y + row_height)          # Q1 = 1 row below anchor
        bottom_y = int(anchor_y + 17 * row_height)     # Q17 = 17 rows below anchor

        pitch      = BUBBLE_X_PITCH * w
        anchor_xs  = [a[0] for a in markers['anchors']]
        margin     = 0.4 * pitch
        col_bounds = [
            (int(ax - margin), int(ax + 5 * pitch + margin))
            for ax in anchor_xs
        ]
        return dict(top_y=top_y, bottom_y=bottom_y, col_bounds=col_bounds,
                    anchor_xs=anchor_xs, bubble_pitch=pitch, markers_used=True)
    else:
        top_y    = int(h * config.bubble_area_top)
        bottom_y = int(h * config.bubble_area_bottom)
        col_bounds = [
            (int(w * config.col1_left), int(w * config.col1_right)),
            (int(w * config.col2_left), int(w * config.col2_right)),
            (int(w * config.col3_left), int(w * config.col3_right)),
        ]
        return dict(top_y=top_y, bottom_y=bottom_y, col_bounds=col_bounds,
                    anchor_xs=None, bubble_pitch=None, markers_used=False)


def analyze_bubble_grid(image: np.ndarray, config: SheetConfig) -> tuple[dict, list]:
    """
    Analyze the bubble grid using a template-based approach.

    Instead of detecting bubble contours, we sample expected bubble locations
    and measure their darkness to determine if they're filled.

    Returns (answers_dict, flags_list).
    """
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Apply slight blur to reduce noise
    gray = cv2.GaussianBlur(gray, (3, 3), 0)

    answers = {}
    flags = []
    choice_letters = 'abcdef'

    # Compute grid positions (marker-based if fiducials are detected, else config)
    gp = _compute_grid_params(image, config)
    top_y      = gp['top_y']
    bottom_y   = gp['bottom_y']
    col_bounds = gp['col_bounds']
    anchor_xs  = gp['anchor_xs']
    pitch      = gp['bubble_pitch']

    if not gp['markers_used']:
        flags.append("WARNING: Sheet markers not detected — using default layout config")

    # Row spacing: 17 rows, 16 gaps (all columns share the same y-positions)
    max_questions_per_col = 17
    row_height = (bottom_y - top_y) / (max_questions_per_col - 1)

    # Process each column
    for col_idx, (q_start, q_end) in enumerate(config.columns):
        num_questions = q_end - q_start + 1
        col_left, col_right = col_bounds[col_idx]
        col_width = col_right - col_left

        # Bubble x-positions: use detected anchor + pitch when available,
        # otherwise distribute evenly within the column bounds.
        if anchor_xs is not None and pitch is not None:
            ax = anchor_xs[col_idx]
            choice_positions = [int(ax + c * pitch) for c in range(config.num_choices)]
        else:
            choice_positions = [
                col_left + int(col_width * (c + 0.5) / config.num_choices)
                for c in range(config.num_choices)
            ]

        for row_idx in range(num_questions):
            question_num = q_start + row_idx
            # Center y of this row (top_y is center of row 0, bottom_y is center of row 16)
            y = top_y + int(row_height * row_idx)

            # Sample each bubble position
            fill_values = []
            for c, x in enumerate(choice_positions):
                # Sample a region around the bubble center
                r = config.bubble_radius
                # Ensure we stay within image bounds
                x1 = max(0, x - r)
                x2 = min(w, x + r)
                y1 = max(0, y - r)
                y2 = min(h, y + r)

                # Extract region and calculate mean darkness
                region = gray[y1:y2, x1:x2]
                if region.size > 0:
                    # Invert so darker = higher value
                    darkness = 1.0 - (np.mean(region) / 255.0)
                else:
                    darkness = 0

                fill_values.append(darkness)

            # Determine which bubbles are filled
            selected = []
            for c, darkness in enumerate(fill_values):
                if darkness >= config.fill_threshold:
                    selected.append(choice_letters[c])

            answers[question_num] = ''.join(selected)

            # Flag potential issues
            max_fill = max(fill_values)

            # Flag if no answer but there's partial marking
            if not selected and max_fill > config.fill_threshold * 0.7:
                flags.append(
                    f"Q{question_num:02d}: Possible faint mark "
                    f"(max darkness: {max_fill:.2f}, threshold: {config.fill_threshold:.2f})"
                )

            # Flag multiple selections (informational - may be intentional)
            if len(selected) > 1:
                flags.append(f"Q{question_num:02d}: Multiple selections: {answers[question_num]}")

            # Flag ambiguous values near threshold
            for c, darkness in enumerate(fill_values):
                if config.fill_threshold * 0.8 <= darkness < config.fill_threshold:
                    flags.append(
                        f"Q{question_num:02d}: Choice {choice_letters[c]} near threshold "
                        f"(darkness: {darkness:.2f})"
                    )

    return answers, flags


def process_single_page(
    image: np.ndarray,
    config: SheetConfig,
    page_num: int
) -> tuple[dict, list, bool]:
    """
    Process a single page and extract answers.
    Returns (answers, flags, orientation_detected).
    """
    # Orient the image using QR codes
    oriented, orientation_ok = orient_image(image)

    # Analyze the bubble grid
    answers, flags = analyze_bubble_grid(oriented, config)

    # Add page-level flags
    if not orientation_ok:
        flags.insert(0, "WARNING: orientation markers not detected - orientation may be wrong")

    return answers, flags, orientation_ok


# =============================================================================
# CALIBRATION HELPER
# =============================================================================

def save_debug_image(image: np.ndarray, config: SheetConfig, output_path: str):
    """Save an annotated debug image showing detected bubble positions and markers."""
    debug_img = image.copy()

    gp = _compute_grid_params(image, config)
    top_y      = gp['top_y']
    bottom_y   = gp['bottom_y']
    col_bounds = gp['col_bounds']
    anchor_xs  = gp['anchor_xs']
    pitch      = gp['bubble_pitch']

    # Draw column bounding boxes (green)
    for col_left, col_right in col_bounds:
        cv2.rectangle(debug_img, (col_left, top_y), (col_right, bottom_y), (0, 255, 0), 2)

    max_questions_per_col = 17
    row_height = (bottom_y - top_y) / (max_questions_per_col - 1)

    # Draw expected bubble centres (red circles)
    for col_idx, (q_start, q_end) in enumerate(config.columns):
        num_questions = q_end - q_start + 1
        col_left, col_right = col_bounds[col_idx]
        col_width = col_right - col_left

        if anchor_xs is not None and pitch is not None:
            ax = anchor_xs[col_idx]
            choice_xs = [int(ax + c * pitch) for c in range(config.num_choices)]
        else:
            choice_xs = [
                col_left + int(col_width * (c + 0.5) / config.num_choices)
                for c in range(config.num_choices)
            ]

        for row_idx in range(num_questions):
            y = top_y + int(row_height * row_idx)
            for x in choice_xs:
                cv2.circle(debug_img, (x, y), config.bubble_radius, (0, 0, 255), 1)

    # Highlight detected markers if available
    markers = detect_sheet_markers(image)
    if markers:
        for key_name, color in [('tl', (255, 0, 0)), ('tr', (255, 0, 0)),
                                 ('bl', (255, 0, 0)), ('br', (255, 0, 0))]:
            pt = markers.get(key_name)
            if pt:
                cv2.drawMarker(debug_img, pt, color, cv2.MARKER_SQUARE, 20, 2)
        for ax, ay in markers['anchors']:
            cv2.circle(debug_img, (ax, ay), 8, (0, 165, 255), 2)  # orange

    label = "MARKERS DETECTED" if gp['markers_used'] else "FALLBACK: no markers"
    cv2.putText(debug_img, label, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                (0, 200, 0) if gp['markers_used'] else (0, 0, 200), 2)

    cv2.imwrite(output_path, debug_img)
    print(f"Debug image saved to: {output_path}")


def create_answer_overlay(image: np.ndarray, config: SheetConfig, key: dict, student_answers: dict) -> np.ndarray:
    """
    Return annotated image showing key (green open circles) and student answers (red dots).

    Args:
        image: scanned page (numpy BGR array)
        config: SheetConfig
        key: dict mapping q_num -> set/str of correct letters (from load_answer_key),
             or None to skip key markers
        student_answers: dict mapping q_num -> answer string (from detection)
    Returns:
        numpy array (BGR) with overlay drawn
    """
    overlay_img = image.copy()

    gp = _compute_grid_params(image, config)
    top_y      = gp['top_y']
    bottom_y   = gp['bottom_y']
    col_bounds = gp['col_bounds']
    anchor_xs  = gp['anchor_xs']
    pitch      = gp['bubble_pitch']

    choice_letters = 'abcdef'
    max_questions_per_col = 17
    row_height = (bottom_y - top_y) / (max_questions_per_col - 1)

    for col_idx, (q_start, q_end) in enumerate(config.columns):
        num_questions = q_end - q_start + 1
        col_left, col_right = col_bounds[col_idx]
        col_width = col_right - col_left

        if anchor_xs is not None and pitch is not None:
            ax = anchor_xs[col_idx]
            choice_xs = [int(ax + c * pitch) for c in range(config.num_choices)]
        else:
            choice_xs = [
                col_left + int(col_width * (c + 0.5) / config.num_choices)
                for c in range(config.num_choices)
            ]

        for row_idx in range(num_questions):
            q_num = q_start + row_idx
            y = top_y + int(row_height * row_idx)

            correct = key.get(q_num, '') if key else ''
            student_answer = student_answers.get(q_num, '')

            for c, x in enumerate(choice_xs):
                letter = choice_letters[c]

                # Red dot for detected answers
                if letter in student_answer:
                    cv2.circle(overlay_img, (x, y), 6, (0, 0, 255), -1)

                # Green open circle for correct answers (drawn on top)
                if key and letter in correct:
                    cv2.circle(overlay_img, (x, y), 12, (0, 200, 0), 2)

    return overlay_img


def _get_answers_column(fieldnames) -> Optional[str]:
    """Return the answer-column name from a CSV header, accepting 'answers' or 'answer'."""
    for name in (fieldnames or []):
        if name.strip().lower() in ('answers', 'answer'):
            return name
    return None


def save_key_overlay(image: np.ndarray, config: SheetConfig, key_path: str, output_path: str):
    """
    Save an annotated image with green open circles on correct answers and red dots on detected answers.

    Args:
        image: The scanned page image
        config: Sheet configuration
        key_path: Path to CSV file with answer key
        output_path: Where to save the annotated image
    """
    import csv as csv_module

    key = {}
    with open(key_path, 'r') as f:
        reader = csv_module.DictReader(f)
        ans_col = _get_answers_column(reader.fieldnames)
        for row in reader:
            if ans_col is None:
                continue
            q_num = int(row['question_number'].strip().lower().replace('q', ''))
            key[q_num] = row[ans_col].strip().lower()

    detected, _ = analyze_bubble_grid(image, config)
    overlay_img = create_answer_overlay(image, config, key, detected)
    cv2.imwrite(output_path, overlay_img)


def load_answer_key(key_path: str) -> dict:
    """Load answer key from CSV file.

    Accepts 'answers' or 'answer' as the column name (case-insensitive).
    Returns dict mapping question number (int) to set of correct lowercase letters.
    """
    import csv as csv_module
    key = {}
    with open(key_path, 'r') as f:
        reader = csv_module.DictReader(f)
        ans_col = _get_answers_column(reader.fieldnames)
        if ans_col is None:
            raise ValueError(
                f"Answer key CSV '{key_path}' must have a column named 'answers' or 'answer'. "
                f"Found columns: {list(reader.fieldnames or [])}"
            )
        for row in reader:
            q_num = int(row['question_number'].strip().lower().replace('q', ''))
            key[q_num] = set(row[ans_col].strip().lower())
    return key


def load_roster(roster_path: str) -> list[str]:
    """Load student roster from a text file (one name per line) or CSV.

    CSV format: auto-detects column names.
    - If columns named 'first'/'last' (or 'first_name'/'last_name') exist,
      combines them as "First Last" (full name).
    - Otherwise uses the first column as the full name.

    Returns a sorted list of full student names.
    """
    import csv as csv_module

    _SKIP = {'name', 'student', 'student_name', 'first', 'last',
             'first_name', 'last_name', 'firstname', 'lastname'}

    path = Path(roster_path)
    names = []

    with open(path, 'r', newline='', encoding='utf-8') as f:
        sample = f.read(2048)
        f.seek(0)

        if ',' in sample.split('\n')[0]:
            reader = csv_module.DictReader(f)
            raw_fields = reader.fieldnames or []
            # Build mapping: normalized fieldname → original fieldname
            fn_map = {fn.strip().lower(): fn for fn in raw_fields}

            first_col = (fn_map.get('first') or fn_map.get('first_name')
                         or fn_map.get('firstname'))
            last_col  = (fn_map.get('last')  or fn_map.get('last_name')
                         or fn_map.get('lastname'))

            for row in reader:
                if first_col and last_col:
                    first = row.get(first_col, '').strip()
                    last  = row.get(last_col,  '').strip()
                    full  = f"{first} {last}".strip() if (first or last) else ''
                elif last_col:
                    full = row.get(last_col, '').strip()
                elif raw_fields:
                    full = row.get(raw_fields[0], '').strip()
                else:
                    continue

                if full and full.lower() not in _SKIP:
                    names.append(full)
        else:
            for line in f:
                name = line.strip()
                if name:
                    names.append(name)

    names.sort(key=lambda n: n.lower())
    return names


def ocr_name_region(
    image: np.ndarray,
    config: SheetConfig,
    roster: Optional[list[str]] = None
) -> tuple[np.ndarray, str, str]:
    """Crop the name region from a scan and OCR it.

    Tries OCR engines in order:
      1. pytesseract (if installed)
      2. macOS Vision API via lazily-compiled Swift helper (macOS only,
         requires Xcode Command Line Tools; compiled once per session)

    Args:
        image: Oriented BGR numpy array (same orientation used for bubble detection)
        config: SheetConfig with name region coordinates
        roster: Optional list of student names for fuzzy matching

    Returns:
        (cropped_image, ocr_text, best_match)
        - cropped_image: BGR numpy array of the name region
        - ocr_text: Raw OCR text (empty if all OCR engines unavailable)
        - best_match: Best roster match (empty if no match or no roster)
    """
    import difflib

    h, w = image.shape[:2]
    y1 = int(h * config.name_region_top)
    y2 = int(h * config.name_region_bottom)
    x1 = int(w * config.name_region_left)
    x2 = int(w * config.name_region_right)
    cropped = image[y1:y2, x1:x2]

    ocr_text = ''
    best_match = ''

    if cropped.size == 0:
        return cropped, ocr_text, best_match

    if PYTESSERACT_AVAILABLE:
        gray = cv2.cvtColor(cropped, cv2.COLOR_BGR2GRAY)
        _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        ocr_text = pytesseract.image_to_string(thresh, config='--psm 7').strip()

    if not ocr_text:
        # Fallback: macOS Vision API via compiled Swift helper
        vision_bin = _get_vision_binary()
        if vision_bin:
            try:
                tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
                tmp.close()
                cv2.imwrite(tmp.name, cropped)
                result = subprocess.run(
                    [vision_bin, tmp.name],
                    capture_output=True, text=True, timeout=10
                )
                ocr_text = result.stdout.strip()
            except (subprocess.TimeoutExpired, OSError):
                pass
            finally:
                try:
                    os.unlink(tmp.name)
                except OSError:
                    pass

    # Strip printed "Name:" label if the OCR picked it up
    for prefix in ('name:', 'name'):
        if ocr_text.lower().startswith(prefix):
            ocr_text = ocr_text[len(prefix):].lstrip(':').strip()
            break

    if ocr_text and roster:
        # Case-insensitive full-name fuzzy match
        ocr_lower = ocr_text.lower()
        roster_lower = [n.lower() for n in roster]
        matches = difflib.get_close_matches(ocr_lower, roster_lower, n=1, cutoff=0.4)
        if matches:
            best_match = roster[roster_lower.index(matches[0])]
        else:
            # Fallback: OCR may have read only the last name — try exact then
            # fuzzy match against just the last word of each roster entry.
            last_words = [n.split()[-1].lower() if n.split() else n.lower()
                          for n in roster]
            # Exact match first
            for i, lw in enumerate(last_words):
                if ocr_lower == lw:
                    best_match = roster[i]
                    break
            # Fuzzy match against last words if still unmatched
            if not best_match:
                lw_matches = difflib.get_close_matches(
                    ocr_lower, last_words, n=1, cutoff=0.6
                )
                if lw_matches:
                    best_match = roster[last_words.index(lw_matches[0])]

    return cropped, ocr_text, best_match


def compute_summary_stats(all_answers: list[dict], key: dict, config: SheetConfig) -> dict:
    """
    Compute item analysis statistics. Returns a dict with summary data.

    For questions with multiple correct answers, each question is treated as
    6 independent true/false items (one per choice A-F).
    """
    from collections import Counter
    import math

    choice_letters = set('abcdef')
    num_students = len(all_answers)

    if num_students == 0:
        return {'error': 'No students to analyze', 'num_students': 0}

    # Calculate scores for each student (treating each Q as 6 T/F items)
    student_scores = []
    for student_answers in all_answers:
        score = 0
        for q_num in range(1, config.num_questions + 1):
            correct_set = key.get(q_num, set())
            student_set = set(student_answers.get(q_num, '').lower())
            for letter in choice_letters:
                should_select = letter in correct_set
                did_select = letter in student_set
                if should_select == did_select:
                    score += 1
        student_scores.append(score)

    max_possible = config.num_questions * 6
    mean_score = sum(student_scores) / num_students

    # Calculate stats for each question
    question_stats = []

    for q_num in range(1, config.num_questions + 1):
        correct_set = key.get(q_num, set())
        responses = []
        fully_correct = 0

        for i, student_answers in enumerate(all_answers):
            student_set = set(student_answers.get(q_num, '').lower())
            responses.append(student_set)

            all_correct = True
            for letter in choice_letters:
                should_select = letter in correct_set
                did_select = letter in student_set
                if should_select != did_select:
                    all_correct = False
                    break
            if all_correct:
                fully_correct += 1

        # Point-biserial correlation
        correct_indices = [i for i, r in enumerate(responses) if r == correct_set]
        incorrect_indices = [i for i, r in enumerate(responses) if r != correct_set]

        if correct_indices and incorrect_indices:
            m1 = sum(student_scores[i] for i in correct_indices) / len(correct_indices)
            m0 = sum(student_scores[i] for i in incorrect_indices) / len(incorrect_indices)
            p = len(correct_indices) / num_students
            q = 1 - p
            variance = sum((s - mean_score) ** 2 for s in student_scores) / num_students
            std_dev = math.sqrt(variance) if variance > 0 else 1
            r_pb = ((m1 - m0) / std_dev) * math.sqrt(p * q) if std_dev > 0 else 0
        else:
            r_pb = 0.0

        # Entropy
        response_strings = [''.join(sorted(r)) for r in responses]
        response_counts = Counter(response_strings)
        entropy = 0.0
        for count in response_counts.values():
            if count > 0:
                prob = count / num_students
                entropy -= prob * math.log2(prob)

        # Most frequently selected incorrect answer
        incorrect_selections = Counter()
        for student_set in responses:
            for letter in student_set:
                if letter not in correct_set:
                    incorrect_selections[letter] += 1

        if incorrect_selections:
            most_common_wrong = incorrect_selections.most_common(1)[0]
            most_wrong_letter = most_common_wrong[0].upper()
            most_wrong_count = most_common_wrong[1]
        else:
            most_wrong_letter = "-"
            most_wrong_count = 0

        # Most commonly missed correct answer
        missed_correct = Counter()
        for student_set in responses:
            for letter in correct_set:
                if letter not in student_set:
                    missed_correct[letter] += 1

        if missed_correct:
            most_missed = missed_correct.most_common(1)[0]
            most_missed_letter = most_missed[0].upper()
            most_missed_count = most_missed[1]
        else:
            most_missed_letter = "-"
            most_missed_count = 0

        question_stats.append({
            'q_num': q_num,
            'correct_key': ''.join(sorted(correct_set)).upper(),
            'num_correct': fully_correct,
            'pct_correct': fully_correct / num_students * 100,
            'correlation': r_pb,
            'entropy': entropy,
            'most_wrong': most_wrong_letter,
            'most_wrong_count': most_wrong_count,
            'most_missed': most_missed_letter,
            'most_missed_count': most_missed_count,
        })

    # Identify flags
    flags = []
    for s in question_stats:
        if s['pct_correct'] < 30:
            flags.append(f"Q{s['q_num']}: Very low success rate ({s['pct_correct']:.1f}%)")
        if s['correlation'] < 0:
            flags.append(f"Q{s['q_num']}: Negative correlation ({s['correlation']:.3f})")
        if s['pct_correct'] > 95:
            flags.append(f"Q{s['q_num']}: Very high success rate ({s['pct_correct']:.1f}%)")

    return {
        'num_students': num_students,
        'num_questions': config.num_questions,
        'max_possible': max_possible,
        'mean_score': mean_score,
        'mean_pct': mean_score / max_possible * 100,
        'question_stats': question_stats,
        'flags': flags,
    }


def generate_key_summary(all_answers: list[dict], key_path: str, config: SheetConfig, output_path: str):
    """
    Generate a summary file with item analysis statistics.

    For questions with multiple correct answers, each question is treated as
    6 independent true/false items (one per choice A-F).

    Stats calculated:
    - Number of students who got the question fully correct
    - Point-biserial correlation with overall score
    - Entropy of the answer distribution
    - Most frequently selected incorrect answer
    """
    key = load_answer_key(key_path)
    stats = compute_summary_stats(all_answers, key, config)

    if 'error' in stats:
        with open(output_path, 'w') as f:
            f.write(f"{stats['error']}\n")
        return

    # Write summary file
    with open(output_path, 'w') as f:
        f.write("OMR Key Summary - Item Analysis\n")
        f.write("=" * 70 + "\n\n")
        f.write(f"Total students: {stats['num_students']}\n")
        f.write(f"Total questions: {stats['num_questions']}\n")
        f.write(f"Max possible score (T/F items): {stats['max_possible']}\n")
        f.write(f"Mean score: {stats['mean_score']:.1f} ({stats['mean_pct']:.1f}%)\n\n")

        f.write("Note: Questions treated as 6 T/F items (A-F). 'Correct' means all 6 correct.\n")
        f.write("      Correlation is point-biserial with total score.\n")
        f.write("      Entropy measures response distribution diversity (higher = more varied).\n\n")

        f.write("-" * 70 + "\n")
        f.write(f"{'Q#':<4} {'Key':<8} {'Correct':>8} {'%':>6} {'r_pb':>7} {'Entropy':>8} {'Wrong':>8} {'Missed':>8}\n")
        f.write("-" * 70 + "\n")

        for s in stats['question_stats']:
            wrong_str = f"{s['most_wrong']}({s['most_wrong_count']})" if s['most_wrong'] != '-' else "-"
            missed_str = f"{s['most_missed']}({s['most_missed_count']})" if s['most_missed'] != '-' else "-"
            f.write(f"Q{s['q_num']:<3} {s['correct_key']:<8} {s['num_correct']:>8} {s['pct_correct']:>5.1f}% {s['correlation']:>7.3f} {s['entropy']:>8.2f} {wrong_str:>8} {missed_str:>8}\n")

        f.write("-" * 70 + "\n")

        f.write("\nFlags:\n")
        if stats['flags']:
            for flag in stats['flags']:
                f.write(f"  {flag}\n")
        else:
            f.write("  No flagged items.\n")

    print(f"Key summary: {output_path}")


# =============================================================================
# MAIN PROCESSING
# =============================================================================

def process_pdf(
    pdf_path: str,
    output_csv: str,
    output_flags: str,
    config: SheetConfig,
    debug: bool = False,
    key_path: str = None,
    output_dir: str = None
) -> None:
    """Process entire PDF and generate output files."""
    import os

    if output_dir is None:
        output_dir = os.path.dirname(os.path.abspath(pdf_path))

    if not PYZBAR_AVAILABLE:
        print("Note: pyzbar not installed - QR code orientation detection disabled.")
        print("      (Install with: brew install zbar && pip install pyzbar)")
        print()

    # Load PDF
    images = load_pdf_pages(pdf_path)

    # Optionally save debug image of first page
    if debug and images:
        debug_path = os.path.join(output_dir, "debug_grid.png")
        save_debug_image(images[0], config, debug_path)

    # Optionally save key overlay images
    if key_path and images:
        overlay_dir = os.path.join(output_dir, "key_overlays")
        os.makedirs(overlay_dir, exist_ok=True)
        print(f"\nGenerating key overlays in {overlay_dir}/...")
        for i, img in enumerate(images):
            overlay_path = os.path.join(overlay_dir, f"page_{i+1:02d}_overlay.png")
            save_key_overlay(img, config, key_path, overlay_path)
        print(f"Generated {len(images)} overlay images")

    all_answers = []
    all_flags = []

    print(f"\nProcessing {len(images)} pages...")

    for i, image in enumerate(images):
        page_num = i + 1
        print(f"  Processing page {page_num}/{len(images)}...", end=" ")

        answers, flags, orientation_ok = process_single_page(image, config, page_num)

        all_answers.append(answers)

        # Add page number to flags
        page_flags = [f"Page {page_num}, {flag}" for flag in flags]
        all_flags.extend(page_flags)

        status = "OK" if orientation_ok else "NO QR"
        num_answered = len([a for a in answers.values() if a])
        print(f"[{status}] - {num_answered} answers detected")

    # Write CSV
    print(f"\nWriting CSV: {output_csv}")
    with open(output_csv, 'w', newline='') as f:
        writer = csv.writer(f)

        # Header row
        header = [f"q{i:02d}" for i in range(1, config.num_questions + 1)]
        writer.writerow(header)

        # Data rows
        for answers in all_answers:
            row = [answers.get(i, '') for i in range(1, config.num_questions + 1)]
            writer.writerow(row)

    # Write flags file
    print(f"Writing flags: {output_flags}")
    with open(output_flags, 'w') as f:
        if all_flags:
            f.write("OMR Processing Flags\n")
            f.write("=" * 50 + "\n\n")
            f.write("These items may need manual review:\n\n")
            for flag in all_flags:
                f.write(f"  - {flag}\n")
            f.write(f"\nTotal flags: {len(all_flags)}\n")
        else:
            f.write("No flags - all pages processed cleanly.\n")

    # Generate key summary if key provided
    if key_path:
        summary_path = output_csv.replace('.csv', '_key_summary.txt')
        if summary_path == output_csv:
            summary_path = output_csv + '_key_summary.txt'
        generate_key_summary(all_answers, key_path, config, summary_path)

    print(f"\nDone! Processed {len(images)} students.")
    print(f"  CSV output: {output_csv}")
    print(f"  Flags file: {output_flags}")
    if key_path:
        print(f"  Key summary: {summary_path}")
    if all_flags:
        print(f"  WARNING: {len(all_flags)} items flagged for review")


def main():
    parser = argparse.ArgumentParser(
        description="OMR Scanner for Exam Bubble Sheets",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python omr_scanner.py answers.pdf
    python omr_scanner.py answers.pdf results.csv flags.txt
    python omr_scanner.py answers.pdf --threshold 0.5 --debug

The script will:
  1. Convert each PDF page to an image
  2. Detect QR codes for orientation (if present)
  3. Sample bubble locations and measure darkness
  4. Output answers to CSV (one row per student)
  5. Flag ambiguous marks for manual review
        """
    )

    parser.add_argument("pdf", help="Input PDF file with scanned bubble sheets")
    parser.add_argument("output", nargs="?", default=None,
                        help="Output CSV file (default: <pdf_name>_results.csv)")
    parser.add_argument("flags", nargs="?", default=None,
                        help="Output flags file (default: <pdf_name>_flags.txt)")
    parser.add_argument("--threshold", type=float, default=0.14,
                        help="Fill threshold for bubble detection (default: 0.14)")
    parser.add_argument("--dpi", type=int, default=200,
                        help="DPI for PDF rendering (default: 200)")
    parser.add_argument("--debug", action="store_true",
                        help="Save debug image showing grid overlay")
    parser.add_argument("--key", type=str, default=None,
                        help="Path to answer key CSV to generate verification overlay")

    args = parser.parse_args()

    # Set up file paths
    pdf_path = Path(args.pdf)
    if not pdf_path.exists():
        print(f"Error: PDF file not found: {pdf_path}")
        sys.exit(1)

    base_name = pdf_path.stem
    output_csv = args.output or f"{base_name}_results.csv"
    output_flags = args.flags or f"{base_name}_flags.txt"

    # Configure
    config = SheetConfig(
        fill_threshold=args.threshold,
    )

    # Process
    process_pdf(str(pdf_path), output_csv, output_flags, config, debug=args.debug, key_path=args.key)


if __name__ == "__main__":
    main()
