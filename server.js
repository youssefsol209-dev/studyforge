const express = require('express');
const multer  = require('multer');
const path    = require('path');
const agent   = require('./agent');

const app    = express();
const upload = multer({
  storage: multer.memoryStorage(),   // file lives in memory as a Buffer
  limits:  { fileSize: 50 * 1024 * 1024 }  // 50 MB cap
});

// ── Serve frontend ────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── POST /api/mcqs ────────────────────────────────────────
// Receives the uploaded file, asks the agent for MCQs,
// returns JSON array:
//   [{ question, choices: [...], answer: <0-based index> }, ...]
app.post('/api/mcqs', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }
  try {
    const mcqs = await agent.generateMCQs(req.file);
    res.json(mcqs);
  } catch (err) {
    console.error('[/api/mcqs]', err);
    res.status(500).json({ error: err.message || 'Agent failed to generate MCQs.' });
  }
});

// ── POST /api/anki ────────────────────────────────────────
// Receives the uploaded file, asks the agent for an Anki deck,
// streams the .apkg binary back to the browser.
app.post('/api/anki', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }
  try {
    const apkgBuffer = await agent.generateAnki(req.file);
    const baseName   = path.basename(req.file.originalname, path.extname(req.file.originalname));
    const outName    = `${baseName}.apkg`;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
    res.send(apkgBuffer);
  } catch (err) {
    console.error('[/api/anki]', err);
    res.status(500).json({ error: err.message || 'Agent failed to generate Anki deck.' });
  }
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`StudyForge running → http://localhost:${PORT}`);
});
