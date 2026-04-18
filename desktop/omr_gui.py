#!/usr/bin/env python3
"""
OMR Scanner GUI Application

A graphical interface for the OMR bubble sheet scanner.
Uses tkinter (built into Python) for cross-platform compatibility.

Usage:
    python omr_gui.py

Requirements:
    - Python 3.8+
    - tkinter (included with Python)
    - Dependencies from omr_scanner.py (pymupdf, opencv-python, numpy)
"""

import tkinter as tk
from tkinter import ttk, filedialog, messagebox, scrolledtext
import threading
import queue
import os
import sys
import csv
import copy
from pathlib import Path

from PIL import Image, ImageTk
import fitz  # PyMuPDF

# Import the OMR scanner module
try:
    import omr_scanner
except ImportError:
    if getattr(sys, 'frozen', False):
        base_dir = Path(sys._MEIPASS)
    else:
        base_dir = Path(__file__).parent
    sys.path.insert(0, str(base_dir))
    import omr_scanner


class OMRScannerGUI:
    """Main GUI application for OMR Scanner."""

    def __init__(self, root):
        self.root = root
        self.root.title("OMR Scanner - Exam Bubble Sheet Processor")
        self.root.geometry("1200x800")
        self.root.minsize(900, 600)

        # Processing state
        self.processing = False
        self.message_queue = queue.Queue()

        # Variables for form fields
        self.pdf_path = tk.StringVar()
        self.key_path = tk.StringVar()
        self.output_dir = tk.StringVar(value=str(Path.home()))
        self.threshold = tk.DoubleVar(value=0.14)
        self.generate_overlays = tk.BooleanVar(value=True)
        self.generate_debug = tk.BooleanVar(value=False)

        # Review & Edit data
        self.all_answers = None       # Original detected answers (list of dicts)
        self.edited_answers = None    # Editable copy
        self.answer_key = None        # Dict from load_answer_key
        self.config = None            # SheetConfig used during processing
        self.current_student = 0      # Index into edited_answers
        self.pdf_path_for_review = None  # Path to PDF for overlay rendering
        self._overlay_photo = None       # Keep reference to prevent GC

        # Student name data
        self.roster_path = tk.StringVar()
        self.roster = None              # list[str] of names from roster file
        self.student_names = None       # list[str] parallel to all_answers
        self.ocr_results = None         # list[(ocr_text, best_match)]
        self._name_crop_photo = None    # ImageTk reference for name crop
        self._current_page_name_crop = None  # PIL Image from render pass

        # Build the UI
        self._create_widgets()

        # Start message queue processor
        self._process_queue()

    def _create_widgets(self):
        """Create all UI widgets with tabbed layout."""
        # Notebook (tabs) as the root widget
        self.notebook = ttk.Notebook(self.root)
        self.notebook.pack(fill="both", expand=True, padx=5, pady=5)

        # === Tab 1: Scanner ===
        scanner_frame = ttk.Frame(self.notebook, padding="10")
        self.notebook.add(scanner_frame, text="Scanner")
        self._create_scanner_tab(scanner_frame)

        # === Tab 2: Review & Edit ===
        edit_frame = ttk.Frame(self.notebook, padding="10")
        self.notebook.add(edit_frame, text="Review & Edit", state="disabled")
        self._create_edit_tab(edit_frame)

    def _create_scanner_tab(self, main_frame):
        """Create the Scanner tab (all existing widgets)."""
        main_frame.columnconfigure(0, weight=1)

        # === File Selection Section ===
        file_frame = ttk.LabelFrame(main_frame, text="Input Files", padding="10")
        file_frame.grid(row=0, column=0, sticky="ew", pady=(0, 10))
        file_frame.columnconfigure(1, weight=1)

        # PDF file selection
        ttk.Label(file_frame, text="Scanned PDF:").grid(row=0, column=0, sticky="w", pady=2)
        ttk.Entry(file_frame, textvariable=self.pdf_path, width=60).grid(row=0, column=1, sticky="ew", padx=5)
        ttk.Button(file_frame, text="Browse...", command=self._browse_pdf).grid(row=0, column=2)

        # Key file selection
        ttk.Label(file_frame, text="Answer Key (optional):").grid(row=1, column=0, sticky="w", pady=2)
        ttk.Entry(file_frame, textvariable=self.key_path, width=60).grid(row=1, column=1, sticky="ew", padx=5)
        ttk.Button(file_frame, text="Browse...", command=self._browse_key).grid(row=1, column=2)

        # Student roster selection
        ttk.Label(file_frame, text="Student Roster (optional):").grid(row=2, column=0, sticky="w", pady=2)
        ttk.Entry(file_frame, textvariable=self.roster_path, width=60).grid(row=2, column=1, sticky="ew", padx=5)
        ttk.Button(file_frame, text="Browse...", command=self._browse_roster).grid(row=2, column=2)

        # Output directory
        ttk.Label(file_frame, text="Output Directory:").grid(row=3, column=0, sticky="w", pady=2)
        ttk.Entry(file_frame, textvariable=self.output_dir, width=60).grid(row=3, column=1, sticky="ew", padx=5)
        ttk.Button(file_frame, text="Browse...", command=self._browse_output).grid(row=3, column=2)

        # === Settings Section ===
        settings_frame = ttk.LabelFrame(main_frame, text="Settings", padding="10")
        settings_frame.grid(row=1, column=0, sticky="ew", pady=(0, 10))
        settings_frame.columnconfigure(1, weight=1)

        # Threshold slider
        ttk.Label(settings_frame, text="Fill Threshold:").grid(row=0, column=0, sticky="w")
        threshold_frame = ttk.Frame(settings_frame)
        threshold_frame.grid(row=0, column=1, sticky="ew", padx=5)
        threshold_frame.columnconfigure(0, weight=1)

        self.threshold_slider = ttk.Scale(
            threshold_frame, from_=0.05, to=0.35, variable=self.threshold,
            orient="horizontal", command=self._on_threshold_change
        )
        self.threshold_slider.grid(row=0, column=0, sticky="ew")
        self.threshold_label = ttk.Label(threshold_frame, text="0.14", width=6)
        self.threshold_label.grid(row=0, column=1, padx=(5, 0))

        # Threshold help text
        ttk.Label(
            settings_frame,
            text="(Lower = more sensitive to light marks, Higher = requires darker marks)",
            foreground="gray"
        ).grid(row=1, column=1, sticky="w", padx=5)

        # Checkboxes
        ttk.Checkbutton(
            settings_frame, text="Generate overlay images (requires answer key)",
            variable=self.generate_overlays
        ).grid(row=2, column=0, columnspan=2, sticky="w", pady=(10, 0))

        ttk.Checkbutton(
            settings_frame, text="Generate debug grid image",
            variable=self.generate_debug
        ).grid(row=3, column=0, columnspan=2, sticky="w")

        # === Action Buttons ===
        button_frame = ttk.Frame(main_frame)
        button_frame.grid(row=2, column=0, sticky="ew", pady=(0, 10))

        self.run_button = ttk.Button(
            button_frame, text="Process PDF", command=self._run_processing
        )
        self.run_button.pack(side="left", padx=(0, 10))

        self.stop_button = ttk.Button(
            button_frame, text="Stop", command=self._stop_processing, state="disabled"
        )
        self.stop_button.pack(side="left")

        # Progress bar
        self.progress = ttk.Progressbar(button_frame, mode="indeterminate", length=200)
        self.progress.pack(side="right")

        # === Output Section ===
        output_frame = ttk.LabelFrame(main_frame, text="Output", padding="10")
        output_frame.grid(row=3, column=0, sticky="nsew", pady=(0, 10))
        output_frame.columnconfigure(0, weight=1)
        output_frame.rowconfigure(0, weight=1)
        main_frame.rowconfigure(3, weight=1)

        self.output_text = scrolledtext.ScrolledText(
            output_frame, height=15, font=("Courier", 10), state="disabled"
        )
        self.output_text.grid(row=0, column=0, sticky="nsew")

        # === Summary Statistics Section ===
        stats_frame = ttk.LabelFrame(main_frame, text="Summary Statistics", padding="10")
        stats_frame.grid(row=4, column=0, sticky="nsew")
        stats_frame.columnconfigure(0, weight=1)
        stats_frame.rowconfigure(0, weight=1)
        main_frame.rowconfigure(4, weight=1)

        # Create treeview for statistics table
        columns = ("Q#", "Key", "Correct", "%", "r_pb", "Entropy", "Wrong", "Missed")
        self.stats_tree = ttk.Treeview(stats_frame, columns=columns, show="headings", height=8)

        for col in columns:
            self.stats_tree.heading(col, text=col)
            width = 60 if col in ("Q#", "Key", "%") else 80
            self.stats_tree.column(col, width=width, anchor="center")

        # Scrollbar for treeview
        stats_scroll = ttk.Scrollbar(stats_frame, orient="vertical", command=self.stats_tree.yview)
        self.stats_tree.configure(yscrollcommand=stats_scroll.set)

        self.stats_tree.grid(row=0, column=0, sticky="nsew")
        stats_scroll.grid(row=0, column=1, sticky="ns")

    def _create_edit_tab(self, parent):
        """Create the Review & Edit tab."""
        parent.columnconfigure(0, weight=1)
        parent.rowconfigure(2, weight=1)  # PanedWindow gets the stretch

        # === Navigation Bar ===
        nav_frame = ttk.Frame(parent)
        nav_frame.grid(row=0, column=0, sticky="ew", pady=(0, 5))

        self.prev_btn = ttk.Button(nav_frame, text="< Prev", command=self._prev_student)
        self.prev_btn.pack(side="left")

        self.student_label = ttk.Label(nav_frame, text="No data loaded", font=("TkDefaultFont", 12, "bold"))
        self.student_label.pack(side="left", padx=20)

        self.next_btn = ttk.Button(nav_frame, text="Next >", command=self._next_student)
        self.next_btn.pack(side="left")

        # === Name Display Area ===
        name_frame = ttk.LabelFrame(parent, text="Student Name", padding="5")
        name_frame.grid(row=1, column=0, sticky="ew", pady=(0, 5))
        name_frame.columnconfigure(1, weight=1)

        # Cropped name image
        self.name_canvas = tk.Canvas(name_frame, height=50, bg="#f5f5f5")
        self.name_canvas.grid(row=0, column=0, columnspan=4, sticky="ew", pady=(0, 5))

        # Name combobox
        ttk.Label(name_frame, text="Student Name:").grid(row=1, column=0, sticky="w", padx=(0, 5))
        self.name_var = tk.StringVar()
        self.name_combo = ttk.Combobox(name_frame, textvariable=self.name_var, state="normal", width=30)
        self.name_combo.grid(row=1, column=1, sticky="w", padx=(0, 10))
        self.name_combo.bind("<<ComboboxSelected>>", self._on_name_selected)
        self.name_combo.bind("<KeyRelease>", self._on_name_keyrelease)
        self.name_combo.bind("<Return>", self._on_name_selected)
        self.name_combo.bind("<FocusOut>", self._on_name_selected)

        # OCR label
        ttk.Label(name_frame, text="OCR:").grid(row=1, column=2, sticky="w", padx=(0, 5))
        self.ocr_label = ttk.Label(name_frame, text="", foreground="gray")
        self.ocr_label.grid(row=1, column=3, sticky="w")

        # === PanedWindow: overlay image (left) + treeview (right) ===
        paned = ttk.PanedWindow(parent, orient="horizontal")
        paned.grid(row=2, column=0, sticky="nsew")

        # --- Left pane: overlay image canvas ---
        overlay_frame = ttk.Frame(paned)
        overlay_frame.columnconfigure(0, weight=1)
        overlay_frame.rowconfigure(0, weight=1)

        self.overlay_canvas = tk.Canvas(overlay_frame, bg="#e0e0e0", width=350)
        overlay_vscroll = ttk.Scrollbar(overlay_frame, orient="vertical",
                                        command=self.overlay_canvas.yview)
        self.overlay_canvas.configure(yscrollcommand=overlay_vscroll.set)

        self.overlay_canvas.grid(row=0, column=0, sticky="nsew")
        overlay_vscroll.grid(row=0, column=1, sticky="ns")

        # Placeholder text (shown until an image loads)
        self.overlay_canvas.create_text(
            175, 80, text="No overlay available",
            font=("TkDefaultFont", 11), fill="#888", tags="placeholder"
        )

        paned.add(overlay_frame, weight=1)

        # --- Right pane: treeview + controls ---
        right_frame = ttk.Frame(paned)
        right_frame.columnconfigure(0, weight=1)
        right_frame.rowconfigure(0, weight=1)

        tree_frame = ttk.Frame(right_frame)
        tree_frame.grid(row=0, column=0, sticky="nsew")
        tree_frame.columnconfigure(0, weight=1)
        tree_frame.rowconfigure(0, weight=1)

        edit_columns = ("Q#", "Key", "Detected", "Edited", "Status")
        self.edit_tree = ttk.Treeview(tree_frame, columns=edit_columns, show="headings", height=20)

        self.edit_tree.heading("Q#", text="Q#")
        self.edit_tree.heading("Key", text="Key")
        self.edit_tree.heading("Detected", text="Detected")
        self.edit_tree.heading("Edited", text="Edited")
        self.edit_tree.heading("Status", text="Status")

        self.edit_tree.column("Q#", width=50, anchor="center")
        self.edit_tree.column("Key", width=80, anchor="center")
        self.edit_tree.column("Detected", width=100, anchor="center")
        self.edit_tree.column("Edited", width=100, anchor="center")
        self.edit_tree.column("Status", width=80, anchor="center")

        edit_scroll = ttk.Scrollbar(tree_frame, orient="vertical", command=self.edit_tree.yview)
        self.edit_tree.configure(yscrollcommand=edit_scroll.set)

        self.edit_tree.grid(row=0, column=0, sticky="nsew")
        edit_scroll.grid(row=0, column=1, sticky="ns")

        # Double-click to edit
        self.edit_tree.bind("<Double-1>", self._on_edit_double_click)

        # Tag colors
        self.edit_tree.tag_configure("correct", background="#ccffcc")
        self.edit_tree.tag_configure("incorrect", background="#ffcccc")
        self.edit_tree.tag_configure("edited", background="#ffffcc")
        self.edit_tree.tag_configure("edited_correct", background="#ddffcc")
        self.edit_tree.tag_configure("edited_incorrect", background="#ffddcc")
        self.edit_tree.tag_configure("no_key", background="#f0f0f0")

        paned.add(right_frame, weight=1)

        # === Summary Line ===
        self.edit_summary_label = ttk.Label(parent, text="", font=("TkDefaultFont", 11))
        self.edit_summary_label.grid(row=3, column=0, sticky="w", pady=(10, 5))

        # === Action Buttons ===
        action_frame = ttk.Frame(parent)
        action_frame.grid(row=4, column=0, sticky="ew", pady=(5, 0))

        ttk.Button(action_frame, text="Recalculate Stats", command=self._recalculate_stats).pack(side="left", padx=(0, 10))
        ttk.Button(action_frame, text="Export CSV", command=self._export_edited_csv).pack(side="left", padx=(0, 10))
        ttk.Button(action_frame, text="Reset All Edits", command=self._reset_edits).pack(side="left")

        # Entry widget for inline editing (created once, reused)
        self._edit_entry = None

    # ── Scanner tab callbacks ──────────────────────────────────────────

    def _on_threshold_change(self, value):
        """Update threshold label when slider moves."""
        self.threshold_label.config(text=f"{float(value):.2f}")

    def _browse_pdf(self):
        """Open file dialog for PDF selection."""
        path = filedialog.askopenfilename(
            title="Select Scanned PDF",
            filetypes=[("PDF Files", "*.pdf"), ("All Files", "*.*")]
        )
        if path:
            self.pdf_path.set(path)
            self.output_dir.set(os.path.dirname(path))

    def _browse_key(self):
        """Open file dialog for answer key selection."""
        path = filedialog.askopenfilename(
            title="Select Answer Key CSV",
            filetypes=[("CSV Files", "*.csv"), ("All Files", "*.*")]
        )
        if path:
            self.key_path.set(path)

    def _browse_roster(self):
        """Open file dialog for student roster selection."""
        path = filedialog.askopenfilename(
            title="Select Student Roster",
            filetypes=[("Text/CSV Files", "*.txt *.csv"), ("All Files", "*.*")]
        )
        if path:
            self.roster_path.set(path)

    def _browse_output(self):
        """Open directory dialog for output folder."""
        path = filedialog.askdirectory(title="Select Output Directory")
        if path:
            self.output_dir.set(path)

    def _log(self, message):
        """Add message to output log (thread-safe)."""
        self.message_queue.put(("log", message))

    def _update_stats(self, stats):
        """Update statistics table (thread-safe)."""
        self.message_queue.put(("stats", stats))

    def _processing_done(self, success, message=""):
        """Signal processing completion (thread-safe)."""
        self.message_queue.put(("done", (success, message)))

    def _process_queue(self):
        """Process messages from worker thread."""
        try:
            while True:
                msg_type, data = self.message_queue.get_nowait()

                if msg_type == "log":
                    self.output_text.config(state="normal")
                    self.output_text.insert("end", data + "\n")
                    self.output_text.see("end")
                    self.output_text.config(state="disabled")

                elif msg_type == "stats":
                    self._populate_stats_table(data)

                elif msg_type == "answers_data":
                    all_answers, key, config, pdf_path, roster, ocr_results = data
                    self.all_answers = all_answers
                    self.edited_answers = copy.deepcopy(all_answers)
                    self.answer_key = key
                    self.config = config
                    self.pdf_path_for_review = pdf_path
                    self.current_student = 0
                    # Initialize name data
                    self.roster = roster
                    self.ocr_results = ocr_results
                    if ocr_results:
                        self.student_names = [match for (_, match) in ocr_results]
                    else:
                        self.student_names = [""] * len(all_answers)
                    # Enable the Review & Edit tab
                    self.notebook.tab(1, state="normal")
                    self._refresh_edit_tab()

                elif msg_type == "done":
                    success, message = data
                    self.processing = False
                    self.progress.stop()
                    self.run_button.config(state="normal")
                    self.stop_button.config(state="disabled")
                    if success:
                        self._log(f"\n{message}")
                    else:
                        self._log(f"\nError: {message}")
                        messagebox.showerror("Processing Error", message)

        except queue.Empty:
            pass

        # Schedule next check
        self.root.after(100, self._process_queue)

    def _populate_stats_table(self, stats):
        """Populate the statistics treeview with data."""
        for item in self.stats_tree.get_children():
            self.stats_tree.delete(item)

        if 'error' in stats:
            return

        for s in stats['question_stats']:
            wrong_str = f"{s['most_wrong']}({s['most_wrong_count']})" if s['most_wrong'] != '-' else "-"
            missed_str = f"{s['most_missed']}({s['most_missed_count']})" if s['most_missed'] != '-' else "-"

            values = (
                f"Q{s['q_num']}",
                s['correct_key'],
                s['num_correct'],
                f"{s['pct_correct']:.1f}%",
                f"{s['correlation']:.3f}",
                f"{s['entropy']:.2f}",
                wrong_str,
                missed_str
            )

            tags = ()
            if s['pct_correct'] < 30:
                tags = ("low",)
            elif s['correlation'] < 0:
                tags = ("negative",)
            elif s['pct_correct'] > 95:
                tags = ("high",)

            self.stats_tree.insert("", "end", values=values, tags=tags)

        self.stats_tree.tag_configure("low", background="#ffcccc")
        self.stats_tree.tag_configure("negative", background="#ffeecc")
        self.stats_tree.tag_configure("high", background="#ccffcc")

    def _run_processing(self):
        """Start PDF processing in background thread."""
        pdf_path = self.pdf_path.get().strip()
        if not pdf_path:
            messagebox.showerror("Error", "Please select a PDF file.")
            return
        if not os.path.exists(pdf_path):
            messagebox.showerror("Error", f"PDF file not found:\n{pdf_path}")
            return

        key_path = self.key_path.get().strip() or None
        if key_path and not os.path.exists(key_path):
            messagebox.showerror("Error", f"Answer key file not found:\n{key_path}")
            return

        output_dir = self.output_dir.get().strip()
        if not output_dir:
            output_dir = os.path.dirname(pdf_path)
        if not os.path.isdir(output_dir):
            messagebox.showerror("Error", f"Output directory not found:\n{output_dir}")
            return

        # Clear previous output
        self.output_text.config(state="normal")
        self.output_text.delete(1.0, "end")
        self.output_text.config(state="disabled")

        for item in self.stats_tree.get_children():
            self.stats_tree.delete(item)

        # Start processing
        self.processing = True
        self.run_button.config(state="disabled")
        self.stop_button.config(state="normal")
        self.progress.start()

        thread = threading.Thread(
            target=self._process_worker,
            args=(pdf_path, key_path, output_dir),
            daemon=True
        )
        thread.start()

    def _stop_processing(self):
        """Request processing stop."""
        self.processing = False
        self._log("Stopping...")

    def _process_worker(self, pdf_path, key_path, output_dir):
        """Worker thread for PDF processing."""
        try:
            base_name = Path(pdf_path).stem
            output_csv = os.path.join(output_dir, f"{base_name}_results.csv")
            output_flags = os.path.join(output_dir, f"{base_name}_flags.txt")

            config = omr_scanner.SheetConfig(
                fill_threshold=self.threshold.get()
            )

            # Load roster if provided
            roster_path = self.roster_path.get().strip()
            roster = None
            if roster_path and os.path.exists(roster_path):
                try:
                    roster = omr_scanner.load_roster(roster_path)
                    self._log(f"Loaded roster: {len(roster)} students")
                except Exception as e:
                    self._log(f"Warning: Could not load roster: {e}")

            self._log(f"Loading PDF: {pdf_path}")
            self._log(f"Threshold: {self.threshold.get():.2f}")

            images = omr_scanner.load_pdf_pages(pdf_path)
            self._log(f"Loaded {len(images)} pages")

            if not self.processing:
                self._processing_done(False, "Cancelled by user")
                return

            if self.generate_debug.get() and images:
                debug_path = os.path.join(output_dir, "debug_grid.png")
                omr_scanner.save_debug_image(images[0], config, debug_path)
                self._log(f"Debug image saved: {debug_path}")

            if key_path and self.generate_overlays.get() and images:
                overlay_out = os.path.join(output_dir, "key_overlays")
                os.makedirs(overlay_out, exist_ok=True)
                self._log("Generating overlay images...")
                for i, img in enumerate(images):
                    if not self.processing:
                        break
                    overlay_path = os.path.join(overlay_out, f"page_{i+1:02d}_overlay.png")
                    omr_scanner.save_key_overlay(img, config, key_path, overlay_path)
                self._log(f"Generated {len(images)} overlay images in {overlay_out}")

            if not self.processing:
                self._processing_done(False, "Cancelled by user")
                return

            all_answers = []
            all_flags = []
            ocr_results = []

            self._log("\nProcessing pages...")
            for i, image in enumerate(images):
                if not self.processing:
                    break

                page_num = i + 1
                answers, flags, orientation_ok = omr_scanner.process_single_page(image, config, page_num)
                all_answers.append(answers)

                # OCR name region from the oriented image
                oriented, _ = omr_scanner.orient_image(image)
                _, ocr_text, best_match = omr_scanner.ocr_name_region(oriented, config, roster)
                ocr_results.append((ocr_text, best_match))

                page_flags = [f"Page {page_num}, {flag}" for flag in flags]
                all_flags.extend(page_flags)

                status = "OK" if orientation_ok else "NO QR"
                num_answered = len([a for a in answers.values() if a])
                name_info = f" [{best_match}]" if best_match else ""
                self._log(f"  Page {page_num}/{len(images)} [{status}] - {num_answered} answers{name_info}")

            if not self.processing:
                self._processing_done(False, "Cancelled by user")
                return

            # Write CSV
            self._log(f"\nWriting CSV: {output_csv}")
            with open(output_csv, 'w', newline='') as f:
                writer = csv.writer(f)
                q_cols = [f"q{i:02d}" for i in range(1, config.num_questions + 1)]
                has_names = bool(roster and ocr_results)
                header = (["first", "last"] + q_cols) if has_names else q_cols
                writer.writerow(header)
                for i, answers in enumerate(all_answers):
                    row = [answers.get(q, '') for q in range(1, config.num_questions + 1)]
                    if has_names:
                        _, best_match = ocr_results[i] if i < len(ocr_results) else ('', '')
                        first, last = self._split_name(best_match)
                        row = [first, last] + row
                    writer.writerow(row)

            # Write flags
            self._log(f"Writing flags: {output_flags}")
            with open(output_flags, 'w') as f:
                if all_flags:
                    f.write("OMR Processing Flags\n")
                    f.write("=" * 50 + "\n\n")
                    for flag in all_flags:
                        f.write(f"  - {flag}\n")
                    f.write(f"\nTotal: {len(all_flags)} flags\n")
                else:
                    f.write("No flags - all pages processed cleanly.\n")

            # Generate summary stats and send answers data if key provided
            key = None
            if key_path:
                summary_path = os.path.join(output_dir, f"{base_name}_key_summary.txt")
                key = omr_scanner.load_answer_key(key_path)
                stats = omr_scanner.compute_summary_stats(all_answers, key, config)

                self._update_stats(stats)

                omr_scanner.generate_key_summary(all_answers, key_path, config, summary_path)
                self._log(f"Key summary: {summary_path}")

                if 'error' not in stats:
                    self._log(f"\nOverall: {stats['num_students']} students, "
                             f"mean score {stats['mean_pct']:.1f}%")
                    if stats['flags']:
                        self._log(f"Flagged items: {len(stats['flags'])}")

            # Send answers data to main thread for Review & Edit tab
            self.message_queue.put(("answers_data", (all_answers, key, config, pdf_path, roster, ocr_results)))

            self._processing_done(
                True,
                f"Done! Processed {len(images)} students.\n"
                f"Output: {output_csv}"
            )

        except Exception as e:
            self._processing_done(False, str(e))

    # ── Review & Edit tab ──────────────────────────────────────────────

    def _refresh_edit_tab(self):
        """Refresh the edit treeview for the current student."""
        if self.edited_answers is None:
            return

        num_students = len(self.edited_answers)
        idx = self.current_student

        # Update navigation label (with student name if available)
        label = f"Student {idx + 1} of {num_students}"
        if self.student_names and idx < len(self.student_names) and self.student_names[idx]:
            label += f" - {self.student_names[idx]}"
        self.student_label.config(text=label)
        self.prev_btn.config(state="normal" if idx > 0 else "disabled")
        self.next_btn.config(state="normal" if idx < num_students - 1 else "disabled")

        # Clear and repopulate treeview
        for item in self.edit_tree.get_children():
            self.edit_tree.delete(item)

        num_q = self.config.num_questions if self.config else 50
        student_original = self.all_answers[idx]
        student_edited = self.edited_answers[idx]

        original_score = 0
        edited_score = 0

        for q_num in range(1, num_q + 1):
            detected = student_original.get(q_num, '')
            edited = student_edited.get(q_num, '')
            was_edited = (detected != edited)

            if self.answer_key and q_num in self.answer_key:
                key_str = ''.join(sorted(self.answer_key[q_num])).upper()
                correct_set = self.answer_key[q_num]

                # Check correctness (all 6 T/F items must match)
                choice_letters = set('abcdef')
                detected_set = set(detected.lower())
                edited_set = set(edited.lower())

                detected_correct = all(
                    (letter in correct_set) == (letter in detected_set)
                    for letter in choice_letters
                )
                edited_correct = all(
                    (letter in correct_set) == (letter in edited_set)
                    for letter in choice_letters
                )

                if detected_correct:
                    original_score += 1
                if edited_correct:
                    edited_score += 1

                status = "+" if edited_correct else "-"

                if was_edited:
                    tag = "edited_correct" if edited_correct else "edited_incorrect"
                else:
                    tag = "correct" if edited_correct else "incorrect"
            else:
                key_str = "-"
                status = ""
                tag = "no_key" if not was_edited else "edited"

            self.edit_tree.insert("", "end", values=(
                f"Q{q_num}",
                key_str,
                detected.upper(),
                edited.upper(),
                status
            ), tags=(tag,))

        # Update summary
        if self.answer_key:
            self.edit_summary_label.config(
                text=f"Original: {original_score}/{num_q}  |  Edited: {edited_score}/{num_q}"
            )
        else:
            self.edit_summary_label.config(text="No answer key loaded — scores not available")

        # Update overlay image and name display
        self._load_overlay_image(idx)
        self._update_name_display(idx)

    def _load_overlay_image(self, page_idx):
        """Render one PDF page with overlay markers and display on the canvas."""
        self.overlay_canvas.delete("all")
        self._overlay_photo = None

        if not self.pdf_path_for_review or not os.path.exists(self.pdf_path_for_review):
            self.overlay_canvas.create_text(
                175, 80, text="No overlay available",
                font=("TkDefaultFont", 11), fill="#888"
            )
            return

        try:
            import numpy as np

            # Render single page from PDF at 200 DPI
            doc = fitz.open(self.pdf_path_for_review)
            if page_idx >= len(doc):
                doc.close()
                self.overlay_canvas.create_text(
                    175, 80, text="Page not found in PDF",
                    font=("TkDefaultFont", 11), fill="#888"
                )
                return

            page = doc[page_idx]
            zoom = 200 / 72
            mat = fitz.Matrix(zoom, zoom)
            pix = page.get_pixmap(matrix=mat)
            img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                pix.height, pix.width, pix.n
            )
            # Convert to BGR for OpenCV overlay drawing
            import cv2
            if pix.n == 3:
                img_bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
            elif pix.n == 4:
                img_bgr = cv2.cvtColor(img, cv2.COLOR_RGBA2BGR)
            else:
                img_bgr = img
            doc.close()

            # Crop name region before drawing overlay
            if self.config:
                h, w = img_bgr.shape[:2]
                y1 = int(h * self.config.name_region_top)
                y2 = int(h * self.config.name_region_bottom)
                x1 = int(w * self.config.name_region_left)
                x2 = int(w * self.config.name_region_right)
                name_crop_bgr = img_bgr[y1:y2, x1:x2]
                self._current_page_name_crop = Image.fromarray(
                    cv2.cvtColor(name_crop_bgr, cv2.COLOR_BGR2RGB)
                )
            else:
                self._current_page_name_crop = None

            # Draw overlay markers using detected answers for this student
            student_answers = self.all_answers[page_idx] if self.all_answers else {}
            overlay_bgr = omr_scanner.create_answer_overlay(
                img_bgr, self.config, self.answer_key, student_answers
            )

            # Convert BGR -> RGB for PIL
            overlay_rgb = cv2.cvtColor(overlay_bgr, cv2.COLOR_BGR2RGB)
            pil_img = Image.fromarray(overlay_rgb)

            # Scale to fit canvas width
            canvas_width = self.overlay_canvas.winfo_width()
            if canvas_width < 50:
                canvas_width = 350  # fallback before widget is mapped
            scale = canvas_width / pil_img.width
            new_w = canvas_width
            new_h = int(pil_img.height * scale)
            pil_img = pil_img.resize((new_w, new_h), Image.LANCZOS)

            self._overlay_photo = ImageTk.PhotoImage(pil_img)
            self.overlay_canvas.create_image(0, 0, anchor="nw", image=self._overlay_photo)
            self.overlay_canvas.configure(scrollregion=(0, 0, new_w, new_h))

        except Exception as e:
            self.overlay_canvas.create_text(
                175, 80, text=f"Overlay error:\n{e}",
                font=("TkDefaultFont", 10), fill="#cc0000", width=300
            )

    @staticmethod
    def _split_name(full_name: str) -> tuple[str, str]:
        """Split 'First Last' into (first, last). Extra words go into last."""
        name = (full_name or "").strip()
        if not name or name == "(unassigned)":
            return "", ""
        parts = name.split(" ", 1)
        return parts[0], parts[1] if len(parts) > 1 else ""

    def _on_name_selected(self, event=None):
        """Handle name combobox selection or free-typed name commit."""
        if self.student_names is None:
            return
        idx = self.current_student
        selected = self.name_var.get().strip()
        if selected == "(unassigned)":
            self.student_names[idx] = ""
        else:
            self.student_names[idx] = selected
        # Update nav label to reflect new name
        num_students = len(self.edited_answers)
        name = self.student_names[idx]
        label = f"Student {idx + 1} of {num_students}"
        if name:
            label += f" - {name}"
        self.student_label.config(text=label)

    def _on_name_keyrelease(self, event=None):
        """Filter roster dropdown list as user types."""
        if not self.roster or event is None:
            return
        # Don't filter on navigation/control keys
        if event.keysym in ('Up', 'Down', 'Return', 'Escape', 'Tab',
                             'Left', 'Right', 'Home', 'End'):
            return
        typed = self.name_var.get().strip().lower()
        if typed:
            filtered = [n for n in self.roster if typed in n.lower()]
        else:
            filtered = list(self.roster)
        self.name_combo.configure(values=["(unassigned)"] + filtered)

    def _update_name_display(self, page_idx):
        """Update the name display area for the current student."""
        # Show cropped name image
        self.name_canvas.delete("all")
        self._name_crop_photo = None

        if self._current_page_name_crop is not None:
            crop = self._current_page_name_crop
            canvas_width = self.name_canvas.winfo_width()
            if canvas_width < 50:
                canvas_width = 600
            scale = min(canvas_width / crop.width, 50 / crop.height)
            new_w = int(crop.width * scale)
            new_h = int(crop.height * scale)
            if new_w > 0 and new_h > 0:
                resized = crop.resize((new_w, new_h), Image.LANCZOS)
                self._name_crop_photo = ImageTk.PhotoImage(resized)
                self.name_canvas.create_image(0, 0, anchor="nw", image=self._name_crop_photo)

        # Populate combobox
        if self.roster:
            values = ["(unassigned)"] + self.roster
            self.name_combo.configure(values=values, state="normal")
            current_name = self.student_names[page_idx] if self.student_names else ""
            if current_name:
                self.name_var.set(current_name)
            else:
                self.name_var.set("(unassigned)")
        else:
            self.name_combo.configure(values=[], state="disabled")
            self.name_var.set("")

        # Show OCR text
        if self.ocr_results and page_idx < len(self.ocr_results):
            ocr_text, _ = self.ocr_results[page_idx]
            if ocr_text:
                self.ocr_label.config(text=f'"{ocr_text}"')
            else:
                self.ocr_label.config(text="(no text detected)")
        else:
            self.ocr_label.config(text="")

    def _prev_student(self):
        """Navigate to previous student."""
        if self.current_student > 0:
            self._commit_edit()
            self.current_student -= 1
            self._refresh_edit_tab()

    def _next_student(self):
        """Navigate to next student."""
        if self.edited_answers and self.current_student < len(self.edited_answers) - 1:
            self._commit_edit()
            self.current_student += 1
            self._refresh_edit_tab()

    def _on_edit_double_click(self, event):
        """Handle double-click on Edited column to start inline editing."""
        region = self.edit_tree.identify_region(event.x, event.y)
        if region != "cell":
            return

        column = self.edit_tree.identify_column(event.x)
        # column is '#1', '#2', etc. — we want '#4' (Edited)
        if column != "#4":
            return

        item = self.edit_tree.identify_row(event.y)
        if not item:
            return

        # Get cell bounding box
        bbox = self.edit_tree.bbox(item, column)
        if not bbox:
            return

        x, y, w, h = bbox
        current_value = self.edit_tree.set(item, "Edited")

        # Destroy previous edit entry if any
        self._commit_edit()

        # Create entry widget over the cell
        entry = tk.Entry(self.edit_tree, justify="center")
        entry.place(x=x, y=y, width=w, height=h)
        entry.insert(0, current_value.lower())
        entry.select_range(0, "end")
        entry.focus_set()

        # Store reference for cleanup
        self._edit_entry = entry
        self._edit_item = item

        # Bind commit events
        entry.bind("<Return>", lambda e: self._commit_edit())
        entry.bind("<Tab>", lambda e: self._commit_edit())
        entry.bind("<FocusOut>", lambda e: self._commit_edit())
        entry.bind("<Escape>", lambda e: self._cancel_edit())

        # Validate input: only allow a-f characters
        def _validate_key(event):
            if event.char and event.char.isalpha():
                if event.char.lower() not in 'abcdef':
                    return "break"
            return None

        entry.bind("<KeyPress>", _validate_key)

    def _commit_edit(self):
        """Commit the current inline edit."""
        if self._edit_entry is None:
            return

        try:
            new_value = self._edit_entry.get().strip().lower()
            item = self._edit_item

            # Validate: only a-f characters allowed
            filtered = ''.join(c for c in new_value if c in 'abcdef')
            # Sort and deduplicate
            filtered = ''.join(sorted(set(filtered)))

            # Get question number from the row
            q_str = self.edit_tree.set(item, "Q#")  # e.g. "Q1"
            q_num = int(q_str.replace("Q", ""))

            # Update edited_answers
            idx = self.current_student
            self.edited_answers[idx][q_num] = filtered

        except (tk.TclError, ValueError):
            pass

        # Destroy entry
        try:
            self._edit_entry.destroy()
        except tk.TclError:
            pass
        self._edit_entry = None
        self._edit_item = None

        # Refresh display
        self._refresh_edit_tab()

    def _cancel_edit(self):
        """Cancel the current inline edit without saving."""
        if self._edit_entry is not None:
            try:
                self._edit_entry.destroy()
            except tk.TclError:
                pass
            self._edit_entry = None
            self._edit_item = None

    def _recalculate_stats(self):
        """Recalculate summary statistics using edited answers."""
        if self.edited_answers is None or self.answer_key is None:
            messagebox.showinfo("Info", "No data to recalculate. Process a PDF with an answer key first.")
            return

        stats = omr_scanner.compute_summary_stats(self.edited_answers, self.answer_key, self.config)
        self._populate_stats_table(stats)

        if 'error' not in stats:
            self._log(f"\n[Recalculated] {stats['num_students']} students, "
                     f"mean score {stats['mean_pct']:.1f}%")
            messagebox.showinfo("Stats Updated",
                f"Statistics recalculated with edited answers.\n"
                f"Mean: {stats['mean_pct']:.1f}%")

    def _export_edited_csv(self):
        """Export edited answers to a new CSV file."""
        if self.edited_answers is None:
            messagebox.showinfo("Info", "No data to export. Process a PDF first.")
            return

        path = filedialog.asksaveasfilename(
            title="Export Edited CSV",
            defaultextension=".csv",
            filetypes=[("CSV Files", "*.csv"), ("All Files", "*.*")],
            initialfile="edited_results.csv"
        )
        if not path:
            return

        num_q = self.config.num_questions if self.config else 50
        has_names = bool(self.student_names and any(n for n in self.student_names))

        with open(path, 'w', newline='') as f:
            writer = csv.writer(f)
            q_cols = [f"q{i:02d}" for i in range(1, num_q + 1)]
            header = (["first", "last"] + q_cols) if has_names else q_cols
            writer.writerow(header)
            for i, answers in enumerate(self.edited_answers):
                row = [answers.get(q, '') for q in range(1, num_q + 1)]
                if has_names:
                    name = self.student_names[i] if i < len(self.student_names) else ""
                    first, last = self._split_name(name)
                    row = [first, last] + row
                writer.writerow(row)

        self._log(f"\nExported edited CSV: {path}")
        messagebox.showinfo("Export Complete", f"Edited results saved to:\n{path}")

    def _reset_edits(self):
        """Reset all edits back to original detected answers."""
        if self.all_answers is None:
            return

        if not messagebox.askyesno("Confirm Reset", "Reset all edits back to original detected answers?"):
            return

        self.edited_answers = copy.deepcopy(self.all_answers)
        # Reset names to original OCR matches
        if self.ocr_results:
            self.student_names = [match for (_, match) in self.ocr_results]
        else:
            self.student_names = [""] * len(self.all_answers)
        self._refresh_edit_tab()
        self._log("\n[Reset] All edits reverted to original detected answers.")


def main():
    """Entry point for the GUI application."""
    root = tk.Tk()
    app = OMRScannerGUI(root)

    # On macOS, force the window to the foreground on launch.
    # Without this, bundled .app windows can appear behind other apps.
    if sys.platform == 'darwin':
        root.lift()
        root.attributes('-topmost', True)
        root.after(200, lambda: root.attributes('-topmost', False))

    root.mainloop()


if __name__ == "__main__":
    main()
