/* ═══════════════════════════════════════════════════════════
   agent.js  —  Bridges Node.js ↔ mcq_to_anki.py
   ───────────────────────────────────────────────────────────
   generateAnki  — runs mcq_to_anki.py on the uploaded file
                   and returns the .apkg bytes as a Buffer.

   generateMCQs  — parses the questions out of the file first
                   (same Python parser) and returns them as JSON
                   so the browser can render the interactive MCQs.
═══════════════════════════════════════════════════════════ */

const { execFile } = require('child_process');
const fs            = require('fs');
const os            = require('os');
const path          = require('path');

// ── Config ────────────────────────────────────────────────
// Override via PYTHON_BIN env var if `python`/`python3` isn't on PATH, e.g.:
//   PYTHON_BIN=C:\\Python312\\python.exe
const PYTHON     = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const SCRIPT     = path.join(__dirname, 'mcq_to_anki.py');

// ── Helpers ───────────────────────────────────────────────

/**
 * Write a multer file Buffer to a temp file, run the Python
 * script on it, read back the .apkg, then clean up.
 * Returns the .apkg as a Buffer.
 */
async function runPythonScript(file) {
  const tmpDir  = os.tmpdir();
  const ext     = path.extname(file.originalname) || '.pdf';
  const inFile  = path.join(tmpDir, `studyforge_in_${Date.now()}${ext}`);
  const outFile = inFile.replace(ext, '.apkg');

  // Write uploaded bytes to disk
  fs.writeFileSync(inFile, file.buffer);

  try {
    await new Promise((resolve, reject) => {
      const deckName = path.basename(file.originalname, path.extname(file.originalname));
      execFile(
        PYTHON,
        [SCRIPT, inFile, '--output', outFile, '--deck-name', deckName],
        {
          timeout: 120_000,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
        },
        (err, stdout, stderr) => {
          if (err) {
            console.error('[agent] Python stdout:', stdout);
            console.error('[agent] Python stderr:', stderr);
            return reject(new Error(stderr || err.message));
          }
          resolve();
        }
      );
    });

    // Read the generated .apkg back into memory
    const apkgBuffer = fs.readFileSync(outFile);
    return apkgBuffer;

  } finally {
    // Clean up temp files regardless of success/failure
    for (const f of [inFile, outFile]) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
  }
}

/**
 * Run the Python parser in "parse only" mode using a small
 * inline helper script, and return the questions as a JS array.
 *
 * Each item:  { question, choices: [A, B, C, D, E], answer: <0-based index> }
 */
async function generateMCQs(file) {
  const tmpDir  = os.tmpdir();
  const ext     = path.extname(file.originalname) || '.pdf';
  const inFile  = path.join(tmpDir, `studyforge_in_${Date.now()}${ext}`);
  const outJson = inFile.replace(ext, '.json');

  fs.writeFileSync(inFile, file.buffer);

  // Inline Python that imports the parser and dumps JSON
  const pySnippet = `
import sys, json, os
sys.path.insert(0, r'${__dirname.replace(/\\/g, '\\\\')}')
from mcq_to_anki import parse_file
questions = parse_file(r'${inFile.replace(/\\/g, '\\\\')}')
output = []
LETTERS = ['A','B','C','D','E']
for q in questions:
    choices_list = [q['choices'].get(l, '') for l in LETTERS]
    # trim trailing empty choices
    while choices_list and not choices_list[-1]:
        choices_list.pop()
    correct = q.get('correct', [])
    # answers = list of 0-based indices for ALL correct letters
    answers = []
    for i, l in enumerate(LETTERS[:len(choices_list)]):
        if l in correct:
            answers.append(i)
    output.append({
        'question': q['stem'],
        'choices':  choices_list,
        'answers':  answers,
    })
with open(r'${outJson.replace(/\\/g, '\\\\')}', 'w', encoding='utf-8') as f:
    json.dump(output, f, ensure_ascii=False)
`;

  try {
    await new Promise((resolve, reject) => {
      execFile(
        PYTHON,
        ['-c', pySnippet],
        {
          timeout: 120_000,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
        },
        (err, stdout, stderr) => {
          if (err) {
            console.error('[agent] Python stdout:', stdout);
            console.error('[agent] Python stderr:', stderr);
            return reject(new Error(stderr || err.message));
          }
          resolve();
        }
      );
    });

    const raw  = fs.readFileSync(outJson, 'utf-8');
    const mcqs = JSON.parse(raw);

    if (!Array.isArray(mcqs) || mcqs.length === 0) {
      throw new Error(
        'No MCQs found in the document. ' +
        'Make sure questions are numbered (e.g. "1. Question text") ' +
        'and choices are labelled A) – E).'
      );
    }

    return mcqs;

  } finally {
    for (const f of [inFile, outJson]) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
  }
}

/**
 * Generate an Anki .apkg deck from the uploaded file.
 * Returns a Buffer of the binary .apkg content.
 */
async function generateAnki(file) {
  return runPythonScript(file);
}

module.exports = { generateMCQs, generateAnki };
