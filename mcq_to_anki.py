"""
mcq_to_anki.py — Convert MCQ files → Anki .apkg
=================================================
Reads MCQs from a .docx OR .pdf file that already contains written questions
and creates an Anki deck (.apkg) where:

  FRONT  → Question stem + all 5 choices (A–E)
  BACK   → Same layout with correct answers highlighted green + answer footer

Answer detection — THREE methods, tried in priority order:
  1. HIGHLIGHT COLOURS on choice lines (highest priority)
       • Yellow, green, cyan, bright-blue  → CORRECT
       • Red, magenta, dark-red            → WRONG  (explicitly marked wrong)
       • No highlight                      → neutral (not used as signal)
     Works for both .docx (w:highlight / w:shd) and .pdf (highlight annotations
     + background colour via PyMuPDF).
  2. ANSWER KEY SECTION at the end of the document ("ANSWER KEY" heading
     followed by rows like "1: A, C, E")
  3. No answer info found → card is still created, back shows "Not specified"

Supported input formats:
  • .docx  — any Word MCQ file with highlighted choices or an answer key
  • .pdf   — any PDF MCQ file with highlight annotations or an answer key

Usage:
    python mcq_to_anki.py Lecture3_MCQs.docx
    python mcq_to_anki.py Lecture3_MCQs.pdf
    python mcq_to_anki.py notes.pdf --output deck.apkg --deck-name "Endo L3"
    python mcq_to_anki.py *.docx *.pdf

Requirements:
    pip install python-docx genanki pymupdf pdfplumber
"""

from __future__ import annotations

import argparse
import glob
import html
import os
import re
import sys
from pathlib import Path

from docx import Document
import genanki

# PDF support (optional but expected)
try:
    import pdfplumber
    PDFPLUMBER_OK = True
except ImportError:
    PDFPLUMBER_OK = False

try:
    import fitz          # PyMuPDF fallback
    FITZ_OK = True
except ImportError:
    FITZ_OK = False


# ─────────────────────────────────────────────────────────────────────────────
# Anki model / CSS
# ─────────────────────────────────────────────────────────────────────────────

# Fixed model ID — large enough to avoid collisions with built-in Anki models.
# Must never change once decks have been imported, or Anki treats it as a new type.
_MODEL_ID = 1_604_291_847
_DECK_BASE = 2_059_400_000

CSS = """
.card {
  font-family: Arial, sans-serif;
  font-size: 16px;
  color: #1a1a1a;
  background-color: #fafafa;
  max-width: 740px;
  margin: 0 auto;
  padding: 16px 20px;
  line-height: 1.5;
}
.stem {
  font-weight: bold;
  font-size: 17px;
  margin-bottom: 14px;
  color: #1F3864;
}
.choices { list-style: none; padding: 0; margin: 0; }
.choices li {
  padding: 6px 10px;
  margin-bottom: 6px;
  border-radius: 6px;
  background: #eef2f7;
}
.correct {
  background-color: #d4edda !important;
  color: #155724;
  font-weight: bold;
}
.answer-label {
  margin-top: 18px;
  font-size: 14px;
  color: #555;
  border-top: 1px solid #ccc;
  padding-top: 10px;
}
"""

FRONT_TEMPLATE = """
<div class="card">
  <div class="stem">{{Stem}}</div>
  <ul class="choices">
    <li>{{A}}</li>
    <li>{{B}}</li>
    <li>{{C}}</li>
    <li>{{D}}</li>
    <li>{{E}}</li>
  </ul>
</div>
"""

BACK_TEMPLATE = """
{{FrontSide}}
<hr>
<div class="card">
  {{Back}}
</div>
"""


def make_model(deck_name: str) -> genanki.Model:
    return genanki.Model(
        _MODEL_ID,
        "StudyForge MCQ",          # fixed name — Anki matches by ID, not name
        fields=[
            {"name": "Stem"},
            {"name": "A"}, {"name": "B"}, {"name": "C"},
            {"name": "D"}, {"name": "E"},
            {"name": "Back"},
            {"name": "Tags"},
        ],
        templates=[{"name": "MCQ Card", "qfmt": FRONT_TEMPLATE, "afmt": BACK_TEMPLATE}],
        css=CSS,
    )


def make_deck(deck_name: str) -> genanki.Deck:
    # Use a stable hash of the deck name so the same deck name always
    # gets the same ID (avoids duplicating decks on re-import).
    import hashlib
    h = int(hashlib.md5(deck_name.encode()).hexdigest(), 16)
    deck_id = _DECK_BASE + (h % 900_000_000)   # stays in a safe range
    return genanki.Deck(deck_id, deck_name)


# ─────────────────────────────────────────────────────────────────────────────
# Highlight colour classification
# ─────────────────────────────────────────────────────────────────────────────

# Word's named highlight values that mean CORRECT
_DOCX_CORRECT_HIGHLIGHTS = {
    "yellow", "green", "cyan", "turquoise", "darkyellow",
    "pink", "magenta", "darkmagenta",
    "blue", "darkblue", "darkcyan",
}
# Word's named highlight values that mean WRONG (explicitly marked)
_DOCX_WRONG_HIGHLIGHTS = {
    "red", "darkred",
}

def _classify_docx_highlight(val: str | None) -> str:
    """Return 'correct', 'wrong', or 'none' for a w:highlight val string."""
    if val is None:
        return "none"
    v = val.lower()
    if v in _DOCX_CORRECT_HIGHLIGHTS:
        return "correct"
    if v in _DOCX_WRONG_HIGHLIGHTS:
        return "wrong"
    return "none"


def _hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    if len(h) == 6:
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return (0, 0, 0)


def _classify_hex_color(fill: str | None) -> str:
    """
    Classify a hex fill colour (from w:shd or PDF background) as
    'correct', 'wrong', or 'none'.
    Uses HSV-like rules:
      - Highly saturated + bright yellow/green/cyan  → correct
      - Highly saturated red/pink/magenta            → wrong
      - Near-white, near-black, or low saturation    → none
    """
    if not fill or fill.upper() in ("AUTO", "FFFFFF", "000000", "NONE", ""):
        return "none"
    try:
        r, g, b = _hex_to_rgb(fill)
    except ValueError:
        return "none"

    # Normalise to 0-1
    rf, gf, bf = r / 255, g / 255, b / 255
    cmax = max(rf, gf, bf)
    cmin = min(rf, gf, bf)
    delta = cmax - cmin

    # Too dark or too light → background noise, not a real highlight
    if cmax < 0.35 or cmin > 0.97:
        return "none"
    # Low saturation → not a highlight colour
    if delta < 0.10:
        return "none"

    # Hue calculation (0-360)
    if delta == 0:
        hue = 0.0
    elif cmax == rf:
        hue = 60 * (((gf - bf) / delta) % 6)
    elif cmax == gf:
        hue = 60 * (((bf - rf) / delta) + 2)
    else:
        hue = 60 * (((rf - gf) / delta) + 4)

    # Yellow (45-75), Green (75-165), Cyan (165-195)  → correct
    if 45 <= hue <= 195:
        return "correct"
    # Blue (195-265) → correct
    if 195 < hue <= 265:
        return "correct"
    # Purple / Violet / Magenta / Pink (265-345) → correct
    if 265 < hue <= 345:
        return "correct"
    # Orange (20-45) → correct
    if 20 < hue < 45:
        return "correct"
    # Red-ish (0-20 or 345-360) → wrong
    if hue <= 20 or hue > 345:
        return "wrong"

    return "none"


# ─────────────────────────────────────────────────────────────────────────────
# Regex patterns
# ─────────────────────────────────────────────────────────────────────────────

# Matches:  "1-", "1.", "1)", "Q1.", "Q1:"
_Q_RE      = re.compile(r"^(?:Q\s*)?(\d+)\s*[-\.\)]\s+(.+)", re.IGNORECASE)
# Matches:  "A)", "A.", "(A)", "A -"
_CHOICE_RE = re.compile(r"^(?:\()?([A-Ea-e])\)?[\.\)\-]\s*(.+)")
# Answer key row — "1: A", "1: A, C, E", "1- A", "1. (A)"
_ANS_RE    = re.compile(r"^(\d+)\s*[:\-\.\)]\s*(.+)$", re.IGNORECASE)
# "ANSWER KEY", "Answer Key:", "ANSWER KEY - Lecture 3"
_ANSWER_KEY_HEADER_RE = re.compile(
    r"^answer\s*keys?\s*(?:[:\-–—]|\s*$|\s+\S)", re.IGNORECASE
)


def _extract_answer_letters(text: str) -> list[str]:
    """Pull A–E letters from an answer-key value like 'A', '(A)', 'A, C', or 'AC'."""
    seen: set[str] = set()
    letters: list[str] = []
    for ch in re.findall(r"[A-Ea-e]", text):
        ch = ch.upper()
        if ch not in seen:
            seen.add(ch)
            letters.append(ch)
    return letters


def _parse_answer_key_line(line: str) -> list[tuple[int, list[str]]]:
    """Parse one line that may contain one or more 'N: letters' answer-key entries."""
    entries: list[tuple[int, list[str]]] = []
    parts = re.split(r"\t|  {2,}|(?<=\S)\s+(?=\d+\s*[:\-\.\)]\s*)", line)
    for part in parts:
        part = part.strip()
        if not part:
            continue
        m = _ANS_RE.match(part)
        if not m:
            continue
        letters = _extract_answer_letters(m.group(2))
        if letters:
            entries.append((int(m.group(1)), letters))
    return entries


def _apply_text_answer_key(
    questions: list[dict],
    answer_key: dict[int, list[str]],
    has_any_highlight: bool,
) -> None:
    """Merge a text answer key; use as fallback when highlights are missing."""
    if not answer_key:
        return
    for q in questions:
        if q["num"] not in answer_key:
            continue
        if not has_any_highlight or not q["correct"]:
            q["correct"] = answer_key[q["num"]]


# ─────────────────────────────────────────────────────────────────────────────
# .docx parser  — highlight-aware
# ─────────────────────────────────────────────────────────────────────────────

def _get_para_highlight(para) -> str:
    """
    Return 'correct', 'wrong', or 'none' for a python-docx Paragraph.
    Checks every run's w:highlight and w:shd; first non-neutral wins.
    Also checks paragraph-level w:shd.
    """
    from docx.oxml.ns import qn as _qn

    # Run-level
    for run in para.runs:
        rpr = run._r.find(_qn("w:rPr"))
        if rpr is None:
            continue
        hl = rpr.find(_qn("w:highlight"))
        if hl is not None:
            result = _classify_docx_highlight(hl.get(_qn("w:val")))
            if result != "none":
                return result
        shd = rpr.find(_qn("w:shd"))
        if shd is not None:
            result = _classify_hex_color(shd.get(_qn("w:fill")))
            if result != "none":
                return result

    # Paragraph-level shd fallback
    pPr = para._p.find(_qn("w:pPr"))
    if pPr is not None:
        shd = pPr.find(_qn("w:shd"))
        if shd is not None:
            result = _classify_hex_color(shd.get(_qn("w:fill")))
            if result != "none":
                return result

    return "none"


def parse_docx(path: str) -> list[dict]:
    """
    Parse a .docx MCQ file.
    Priority:
      1. If any choice lines have highlight colours → use those as the answer key.
      2. Otherwise fall back to a text-based ANSWER KEY section.
    """
    doc = Document(path)

    questions:   list[dict]           = []
    answer_key:  dict[int, list[str]] = {}
    current_section = ""
    in_answer_key   = False
    current_q: dict | None            = None
    has_any_highlight                 = False

    for para in doc.paragraphs:
        raw  = para.text
        line = raw.strip()
        if not line:
            continue

        highlight = _get_para_highlight(para)

        # ── Answer-key section header ────────────────────────────────────────
        if _ANSWER_KEY_HEADER_RE.match(line):
            if current_q and len(current_q["choices"]) == 5:
                questions.append(current_q)
                current_q = None
            in_answer_key = True
            continue

        # ── Text-based answer key rows ───────────────────────────────────────
        if in_answer_key:
            for num, letters in _parse_answer_key_line(line):
                answer_key[num] = letters
            continue

        # ── Section heading ──────────────────────────────────────────────────
        if (
            not _Q_RE.match(line)
            and not _CHOICE_RE.match(line)
            and len(line) < 120
            and (
                re.match(r"^\s{2}.{3,}\s{2}$", raw)
                or re.match(r"^[A-Z][^a-z]{4,}$", line)
                or re.match(r"^(PART|Section|Chapter)\s", line, re.IGNORECASE)
            )
        ):
            current_section = line
            continue

        # ── Question stem ────────────────────────────────────────────────────
        m_q = _Q_RE.match(line)
        if m_q:
            if current_q and len(current_q["choices"]) == 5:
                questions.append(current_q)
            current_q = {
                "num":     int(m_q.group(1)),
                "stem":    m_q.group(2).strip(),
                "choices": {},
                "correct": [],
                "section": current_section,
            }
            continue

        # ── Choice line ──────────────────────────────────────────────────────
        m_c = _CHOICE_RE.match(line)
        if m_c and current_q is not None:
            letter = m_c.group(1).upper()
            text   = m_c.group(2).strip()
            current_q["choices"][letter] = text

            # Record highlight signal directly on this choice
            if highlight == "correct":
                has_any_highlight = True
                if letter not in current_q["correct"]:
                    current_q["correct"].append(letter)
            elif highlight == "wrong":
                has_any_highlight = True
                # "wrong" just means don't add it — no action needed
            continue

        # ── Multi-line stem continuation ─────────────────────────────────────
        if current_q is not None and not current_q["choices"]:
            current_q["stem"] += " " + line

    # Flush last question
    if current_q and len(current_q["choices"]) == 5:
        questions.append(current_q)

    _apply_text_answer_key(questions, answer_key, has_any_highlight)

    return questions


# ─────────────────────────────────────────────────────────────────────────────
# .pdf parser  — highlight annotation-aware
# ─────────────────────────────────────────────────────────────────────────────

def _pdf_highlight_map(path: str) -> dict[int, str]:
    """
    Returns {page_index: set_of_highlighted_text_fragments} using PyMuPDF.
    Specifically returns a map: normalised_text_snippet → highlight_class
    so we can match against choice text later.

    Format: { "some choice text lower" : "correct" | "wrong" }
    """
    if not FITZ_OK:
        return {}

    result: dict[str, str] = {}
    doc = fitz.open(path)
    for page in doc:
        for annot in page.annots():
            # Highlight (8), Underline (9), StrikeOut (7), Squiggly (10)
            if annot.type[0] not in (8, 9, 10):
                continue
            color = annot.colors.get("stroke") or annot.colors.get("fill")
            if color is None:
                continue
            # color is (r, g, b) floats 0-1
            r, g, b  = [int(c * 255) for c in color]
            hex_fill = f"{r:02X}{g:02X}{b:02X}"
            cls      = _classify_hex_color(hex_fill)
            if cls == "none":
                continue
            # Get the text covered by this annotation
            text = page.get_textbox(annot.rect).strip().lower()
            if text:
                result[text] = cls

    doc.close()
    return result


def _pdf_to_lines(path: str) -> list[str]:
    """Extract text lines from a PDF."""
    lines: list[str] = []
    if PDFPLUMBER_OK:
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages:
                text = page.extract_text(x_tolerance=2, y_tolerance=3)
                if text:
                    lines.extend(text.splitlines())
                    lines.append("")
    elif FITZ_OK:
        doc = fitz.open(path)
        for page in doc:
            text = page.get_text("text")
            if text:
                lines.extend(text.splitlines())
                lines.append("")
        doc.close()
    else:
        raise RuntimeError(
            "No PDF library found.\n"
            "  pip install pdfplumber\n  pip install pymupdf"
        )
    return lines


def parse_pdf(path: str) -> list[dict]:
    """
    Parse a PDF MCQ file.
    Priority:
      1. Highlight annotations on choice lines → answer key.
      2. Text-based ANSWER KEY section.
    """
    # Build highlight map from annotations
    hl_map = _pdf_highlight_map(path)   # { lowercased_text: "correct"|"wrong" }

    lines = _pdf_to_lines(path)

    questions:   list[dict]           = []
    answer_key:  dict[int, list[str]] = {}
    current_section = ""
    in_answer_key   = False
    current_q: dict | None            = None
    has_any_highlight                 = bool(hl_map)

    for raw in lines:
        line = raw.strip()
        if not line:
            continue

        # ── Answer-key section header ────────────────────────────────────────
        if _ANSWER_KEY_HEADER_RE.match(line):
            if current_q and len(current_q["choices"]) == 5:
                questions.append(current_q)
                current_q = None
            in_answer_key = True
            continue

        if in_answer_key:
            for num, letters in _parse_answer_key_line(line):
                answer_key[num] = letters
            continue

        # ── Section heading ──────────────────────────────────────────────────
        if (
            not _Q_RE.match(line)
            and not _CHOICE_RE.match(line)
            and len(line) < 120
            and (
                re.match(r"^\s{2}.{3,}\s{2}$", raw)
                or re.match(r"^[A-Z][^a-z]{4,}$", line)
                or re.match(r"^(PART|Section|Chapter)\s", line, re.IGNORECASE)
            )
        ):
            current_section = line
            continue

        # ── Question stem ────────────────────────────────────────────────────
        m_q = _Q_RE.match(line)
        if m_q:
            if current_q and len(current_q["choices"]) == 5:
                questions.append(current_q)
            current_q = {
                "num":     int(m_q.group(1)),
                "stem":    m_q.group(2).strip(),
                "choices": {},
                "correct": [],
                "section": current_section,
            }
            continue

        # ── Choice line ──────────────────────────────────────────────────────
        m_c = _CHOICE_RE.match(line)
        if m_c and current_q is not None:
            letter = m_c.group(1).upper()
            text   = m_c.group(2).strip()
            current_q["choices"][letter] = text

            # Check if this line's text matches any highlight annotation
            if hl_map:
                # Try matching the full line or just the choice text
                for candidate in (line.lower(), text.lower()):
                    for hl_text, cls in hl_map.items():
                        if candidate in hl_text or hl_text in candidate:
                            if cls == "correct" and letter not in current_q["correct"]:
                                current_q["correct"].append(letter)
                            break
            continue

        # ── Multi-line stem continuation ─────────────────────────────────────
        if current_q is not None and not current_q["choices"]:
            current_q["stem"] += " " + line

    # Flush last
    if current_q and len(current_q["choices"]) == 5:
        questions.append(current_q)

    _apply_text_answer_key(questions, answer_key, has_any_highlight)

    return questions


# ─────────────────────────────────────────────────────────────────────────────
# Dispatcher — pick parser by extension
# ─────────────────────────────────────────────────────────────────────────────

def parse_file(path: str) -> list[dict]:
    ext = Path(path).suffix.lower()
    if ext == ".docx":
        return parse_docx(path)
    elif ext == ".pdf":
        return parse_pdf(path)
    else:
        raise ValueError(f"Unsupported file type: {ext}  (use .docx or .pdf)")


def _answer_source(questions: list[dict]) -> str:
    """Return a human-readable summary of where answers came from."""
    with_answers    = [q for q in questions if q["correct"]]
    without_answers = [q for q in questions if not q["correct"]]
    if not with_answers:
        return "no answers found"
    return (
        f"{len(with_answers)} with answers"
        + (f", {len(without_answers)} without" if without_answers else "")
    )


# ─────────────────────────────────────────────────────────────────────────────
# Anki note builder
# ─────────────────────────────────────────────────────────────────────────────

LETTERS = ["A", "B", "C", "D", "E"]


def _esc(text: str) -> str:
    return html.escape(text, quote=False)


def build_back_html(q: dict) -> str:
    correct_set = set(q["correct"])
    items = []
    for letter in LETTERS:
        text  = q["choices"].get(letter, "—")
        label = f"<b>{letter})</b> {_esc(text)}"
        if letter in correct_set:
            items.append(f'<li class="correct">{label}</li>')
        else:
            items.append(f"<li>{label}</li>")

    correct_str = ", ".join(sorted(correct_set)) if correct_set else "Not specified"
    return (
        f'<div class="stem">{_esc(q["stem"])}</div>\n'
        f'<ul class="choices">\n' + "\n".join(items) + "\n</ul>\n"
        f'<div class="answer-label">✅ Correct: <b>{correct_str}</b></div>'
    )


def question_to_note(q: dict, model: genanki.Model) -> genanki.Note:
    choices  = q["choices"]
    sec_tag  = re.sub(r"[^\w]", "_", q.get("section", "General"))[:40]
    guid     = genanki.guid_for(str(q["num"]) + q["stem"][:60])

    return genanki.Note(
        model=model,
        fields=[
            _esc(q["stem"]),
            f"<b>A)</b> {_esc(choices.get('A', ''))}",
            f"<b>B)</b> {_esc(choices.get('B', ''))}",
            f"<b>C)</b> {_esc(choices.get('C', ''))}",
            f"<b>D)</b> {_esc(choices.get('D', ''))}",
            f"<b>E)</b> {_esc(choices.get('E', ''))}",
            build_back_html(q),
            sec_tag,
        ],
        tags=[sec_tag] if sec_tag else [],
        guid=guid,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Convert MCQ .docx or .pdf files into Anki .apkg decks.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python mcq_to_anki.py Lecture3_MCQs.docx
  python mcq_to_anki.py Lecture3_MCQs.pdf
  python mcq_to_anki.py notes.pdf --deck-name "Endo — Lecture 3" --output L3.apkg
  python mcq_to_anki.py *.docx *.pdf
""",
    )
    parser.add_argument("inputs", nargs="+", help="Input .docx or .pdf file(s) / glob patterns")
    parser.add_argument("--output",    "-o", default="", help="Output .apkg (single file only)")
    parser.add_argument("--deck-name", "-d", default="", help="Anki deck name")
    args = parser.parse_args()

    # Expand globs
    files: list[str] = []
    for pattern in args.inputs:
        expanded = [f for f in glob.glob(pattern) if f.lower().endswith((".docx", ".pdf"))]
        if expanded:
            files.extend(expanded)
        elif os.path.isfile(pattern):
            files.append(pattern)
        else:
            print(f"⚠  No files matched: {pattern}")

    if not files:
        sys.exit("ERROR: No input files found.")

    if args.output and len(files) > 1:
        sys.exit("ERROR: --output can only be used with a single input file.")

    grand_total = 0
    errors: list[tuple[str, str]] = []

    for fpath in files:
        stem       = Path(fpath).stem
        out_path   = args.output or str(Path(fpath).parent / (stem + ".apkg"))
        deck_name  = args.deck_name or stem.replace("_", " ").replace("-", " ")

        print(f"\n{'─'*60}")
        print(f"Input : {fpath}")
        print(f"Output: {out_path}")
        print(f"Deck  : {deck_name}")

        try:
            questions = parse_file(fpath)
        except Exception as exc:
            print(f"  ❌ Parse error: {exc}")
            errors.append((fpath, str(exc)))
            continue

        if not questions:
            print("  ⚠  No MCQs found — check the file format.")
            continue

        answered  = sum(1 for q in questions if q["correct"])
        no_answer = len(questions) - answered
        src       = _answer_source(questions)
        print(f"  Found {len(questions)} question(s) — {src}.")
        if no_answer:
            print(f"  ⚠  {no_answer} card(s) without answers — back will show 'Not specified'.")

        model = make_model(deck_name)
        deck  = make_deck(deck_name)

        for q in questions:
            deck.add_note(question_to_note(q, model))

        genanki.Package(deck).write_to_file(out_path)
        grand_total += len(questions)
        print(f"  ✅ Saved — {len(questions)} cards → {out_path}")

    print(f"\n{'='*60}")
    print(f"Done. Total cards written: {grand_total}")
    if errors:
        print(f"\nFailed ({len(errors)}):")
        for fp, err in errors:
            print(f"  • {fp}: {err}")
    print(f"\nImport into Anki: File → Import → select the .apkg file")


if __name__ == "__main__":
    main()
