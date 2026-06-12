/* ── StudyForge — public/app.js ──────────────────────────────
   Frontend logic. Calls the Node.js backend at /api/mcqs
   and /api/anki. No agent code lives here.
──────────────────────────────────────────────────────────── */

// ── DOM refs ──────────────────────────────────────────────
const dropZone       = document.getElementById('dropZone');
const fileInput      = document.getElementById('fileInput');
const filePreview    = document.getElementById('filePreview');
const fileNameEl     = document.getElementById('fileName');
const fileSizeEl     = document.getElementById('fileSize');
const fileThumbEl    = document.getElementById('fileThumb');
const removeFileBtn  = document.getElementById('removeFile');
const actionRow      = document.getElementById('actionRow');

const generateBtn    = document.getElementById('generateMCQ');
const ankiBtn        = document.getElementById('downloadAnki');
const ankiBtn2       = document.getElementById('downloadAnki2');
const processing     = document.getElementById('processing');
const processingText = document.getElementById('processingText');

const mcqSection     = document.getElementById('mcqSection');
const mcqList        = document.getElementById('mcqList');
const mcqCountEl     = document.getElementById('mcqCount');
const resetBtn       = document.getElementById('resetBtn');

// ── State ─────────────────────────────────────────────────
let currentFile  = null;
let currentDeckName = null;  // filename of the active deck (set on load/import)
let currentMCQs  = [];      // original from server (never mutated)
let shuffledMCQs = [];      // what's currently rendered (shuffled copy)
let currentIdx   = 0;       // which question is active
let score        = 0;       // how many answered correctly
let wrongIndices = [];      // indices into shuffledMCQs that were wrong

// ── Drag & drop / file picker ─────────────────────────────
dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('dragging');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  if (f) setFile(f);
});
// clicking anywhere in the drop zone (including the Browse button) opens the picker
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) setFile(fileInput.files[0]);
});
removeFileBtn.addEventListener('click', e => { e.stopPropagation(); clearFile(); });

function setFile(file) {
  const validTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];
  if (!validTypes.includes(file.type) && !/\.(pdf|docx)$/i.test(file.name)) {
    showToast('Please upload a PDF or DOCX file.', 'error');
    return;
  }
  currentFile            = file;
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = formatBytes(file.size);
  fileThumbEl.textContent = /\.pdf$/i.test(file.name) ? '📕' : '📘';
  dropZone.hidden    = true;
  filePreview.hidden = false;
  actionRow.hidden   = false;
}

function clearFile() {
  currentFile = null;
  fileInput.value    = '';
  dropZone.hidden    = false;
  filePreview.hidden = true;
  actionRow.hidden   = true;
}

function formatBytes(b) {
  if (b < 1024)        return b + ' B';
  if (b < 1048576)     return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

// ── LocalStorage helpers ──────────────────────────────────
const LS_KEY = 'mcqflush_edits';

function loadEdits() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
  catch { return {}; }
}

function saveEdits(edits) {
  localStorage.setItem(LS_KEY, JSON.stringify(edits));
}

// Stable key = the question's index in the original server array (_origIdx)
function qKey(mcq) {
  return String(mcq._origIdx);
}

// Apply any saved edits onto an MCQ array — returns new objects
function applyEdits(mcqs) {
  const edits = loadEdits();
  return mcqs.map(mcq => {
    const key = qKey(mcq);
    if (!edits[key]) return { ...mcq };
    const e = edits[key];
    return {
      ...mcq,
      question:   e.question  ?? mcq.question,
      choices:    mcq.choices.map((c, i) => e.choices?.[i] ?? c),
      answers:    e.answers   != null ? [...e.answers] : mcq.answers,
      _reasoning: e.reasoning ?? mcq._reasoning ?? {},
    };
  });
}
// ── Library (localStorage) ────────────────────────────────
const LIB_KEY = 'mcqflush_library';

function loadLibrary() {
  try { return JSON.parse(localStorage.getItem(LIB_KEY) || '[]'); }
  catch { return []; }
}

function saveLibrary(lib) {
  localStorage.setItem(LIB_KEY, JSON.stringify(lib));
}

function saveToLibrary(filename, mcqs) {
  const lib = loadLibrary();
  const existing = lib.findIndex(e => e.filename === filename);
  const entry = {
    filename,
    savedAt: Date.now(),
    count: mcqs.length,
    mcqs: mcqs.map(q => ({ ...q }))
  };
  if (existing >= 0) lib[existing] = entry;
  else lib.unshift(entry);
  saveLibrary(lib);
  renderLibrary();
}

function renderLibrary() {
  const lib   = loadLibrary();
  const grid  = document.getElementById('libraryGrid');
  const empty = document.getElementById('libraryEmpty');
  grid.innerHTML = '';
  if (lib.length === 0) { empty.hidden = false; return; }
  empty.hidden = true;

  lib.forEach((entry, i) => {
    const card = document.createElement('div');
    card.className = 'lib-card';
    const date = new Date(entry.savedAt).toLocaleDateString(undefined, {
      day: '2-digit', month: 'short', year: 'numeric'
    });
    card.innerHTML = `
      <div class="lib-card-icon">${entry.filename.endsWith('.pdf') ? '📕' : '📘'}</div>
      <div class="lib-card-body">
        <p class="lib-card-name">${escapeHtml(entry.filename)}</p>
        <p class="lib-card-meta">${entry.count} questions · ${date}</p>
      </div>
      <div class="lib-card-actions">
        <button class="btn btn-sm btn-primary lib-load-btn">Load</button>
        <button class="btn-icon lib-delete-btn" title="Remove">
          <svg viewBox="0 0 20 20" fill="currentColor" width="13"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
        </button>
      </div>`;

    card.querySelector('.lib-load-btn').addEventListener('click', () => {
      const fresh = loadLibrary()[i];
      if (!fresh) return;
      currentMCQs  = fresh.mcqs.map((q, idx) => ({ ...q, _origIdx: q._origIdx ?? idx }));
      currentMCQs  = applyEdits(currentMCQs);
      shuffledMCQs = shuffleMCQs(currentMCQs);
      currentDeckName = fresh.filename;
      currentIdx   = 0; score = 0; wrongIndices = [];
      renderMCQs(shuffledMCQs);
      document.getElementById('mcqSection').scrollIntoView({ behavior: 'smooth' });
      showToast(`Loaded "${fresh.filename}"`, 'success');
    });

    card.querySelector('.lib-delete-btn').addEventListener('click', () => {
      const lib = loadLibrary();
      lib.splice(i, 1);
      saveLibrary(lib);
      renderLibrary();
    });

    grid.appendChild(card);
  });
}

document.getElementById('clearLibraryBtn').addEventListener('click', () => {
  if (!loadLibrary().length) return;
  localStorage.removeItem(LIB_KEY);
  renderLibrary();
  showToast('Library cleared.', 'info');
});

// Import a .deckagent.json file into the library
document.getElementById('importJsonInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data._deckagent || !Array.isArray(data.questions)) {
        showToast('Not a valid DeckAgent file.', 'error');
        return;
      }
      const mcqs = data.questions.map((q, i) => ({ ...q, _origIdx: q._origIdx ?? i }));
      saveToLibrary(data.filename ?? file.name, mcqs);
      showToast(`Imported "${data.filename ?? file.name}"`, 'success');
    } catch {
      showToast('Could not read the file.', 'error');
    }
    e.target.value = '';
  };
  reader.readAsText(file);
});

renderLibrary();

// ── Create Deck ───────────────────────────────────────────
const LETTERS = ['A','B','C','D','E'];
let createQuestions = [];

function createBlankQuestion() {
  return { question: '', choices: ['','','','',''], answers: [] };
}

function renderCreateDeck() {
  const list = document.getElementById('createQuestionsList');
  list.innerHTML = '';

  createQuestions.forEach((q, qi) => {
    const block = document.createElement('div');
    block.className = 'cq-block';

    // ── Header (always visible, click to fold) ──
    const blockHead = document.createElement('div');
    blockHead.className = 'cq-block-head';

    const headLeft = document.createElement('div');
    headLeft.className = 'cq-block-head-left';

    const chevron = document.createElement('span');
    chevron.className   = 'cq-chevron';
    chevron.innerHTML   = `<svg viewBox="0 0 20 20" fill="currentColor" width="14"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>`;

    const numLabel = document.createElement('span');
    numLabel.className   = 'cq-block-num';
    numLabel.textContent = `Q${qi + 1}`;

    const preview = document.createElement('span');
    preview.className   = 'cq-preview';
    preview.textContent = q.question.trim() || 'Untitled question';

    headLeft.appendChild(chevron);
    headLeft.appendChild(numLabel);
    headLeft.appendChild(preview);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-icon cq-delete-btn';
    deleteBtn.title     = 'Delete question';
    deleteBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor" width="13"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>`;
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      createQuestions.splice(qi, 1);
      renderCreateDeck();
    });

    blockHead.appendChild(headLeft);
    blockHead.appendChild(deleteBtn);
    block.appendChild(blockHead);

    // ── Collapsible body ──
    const body = document.createElement('div');
    body.className = 'cq-body';

    // Start collapsed if question already has content, expanded if blank
    const isNew = !q.question.trim();
    if (!isNew) {
      block.classList.add('cq-collapsed');
      body.style.display = 'none';
    }

    // Toggle on header click
    blockHead.style.cursor = 'pointer';
    blockHead.addEventListener('click', (e) => {
      if (e.target.closest('.cq-delete-btn')) return;
      const collapsed = block.classList.toggle('cq-collapsed');
      body.style.display = collapsed ? 'none' : 'block';
    });

    // Question textarea
    const qTA = document.createElement('textarea');
    qTA.className   = 'cq-question-input';
    qTA.placeholder = 'Write your question here…';
    qTA.rows        = 2;
    qTA.value       = q.question;
    qTA.addEventListener('input', () => {
      createQuestions[qi].question = qTA.value;
      preview.textContent = qTA.value.trim() || 'Untitled question';
    });
    body.appendChild(qTA);

    // Choices
    const choicesWrap = document.createElement('div');
    choicesWrap.className = 'cq-choices';

    q.choices.forEach((c, ci) => {
      const row = document.createElement('div');
      row.className = 'cq-choice-row';

      const toggle = document.createElement('label');
      toggle.className = 'edit-correct-toggle';
      toggle.title = 'Mark as correct';
      const cb = document.createElement('input');
      cb.type    = 'checkbox';
      cb.checked = q.answers.includes(ci);
      cb.addEventListener('change', () => {
        if (cb.checked) {
          if (!createQuestions[qi].answers.includes(ci)) createQuestions[qi].answers.push(ci);
        } else {
          createQuestions[qi].answers = createQuestions[qi].answers.filter(a => a !== ci);
        }
      });
      const indicator = document.createElement('span');
      indicator.className = 'edit-check-indicator';
      toggle.appendChild(cb);
      toggle.appendChild(indicator);

      const letter = document.createElement('span');
      letter.className   = 'cq-letter';
      letter.textContent = LETTERS[ci] ?? ci;

      const input = document.createElement('input');
      input.type        = 'text';
      input.className   = 'cq-choice-input';
      input.placeholder = `Choice ${LETTERS[ci] ?? ci}`;
      input.value       = c;
      input.addEventListener('input', () => { createQuestions[qi].choices[ci] = input.value; });

      row.appendChild(toggle);
      row.appendChild(letter);
      row.appendChild(input);
      choicesWrap.appendChild(row);
    });

    body.appendChild(choicesWrap);
    block.appendChild(body);
    list.appendChild(block);
  });
}

document.getElementById('addQuestionBtn').addEventListener('click', () => {
  createQuestions.push(createBlankQuestion());
  renderCreateDeck();
  document.querySelectorAll('.cq-block').forEach((b, i, arr) => {
    if (i === arr.length - 1) b.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
});

function buildDeckFromCreate() {
  const name  = document.getElementById('createDeckName').value.trim() || 'My Deck';
  const valid = createQuestions.filter(q => q.question.trim() && q.choices.some(c => c.trim()));
  if (valid.length === 0) { showToast('Add at least one question with choices.', 'error'); return null; }
  const mcqs = valid.map((q, i) => {
    const filledChoices = q.choices.filter(c => c.trim());
    const answers = q.answers.filter(a => a < filledChoices.length);
    return { question: q.question.trim(), choices: filledChoices, answers, _reasoning: {}, _origIdx: i };
  });
  return { name, mcqs };
}

document.getElementById('saveDeckBtn').addEventListener('click', () => {
  const deck = buildDeckFromCreate();
  if (!deck) return;
  saveToLibrary(deck.name, deck.mcqs);
  showToast(`"${deck.name}" saved to library!`, 'success');
});

document.getElementById('studyDeckBtn').addEventListener('click', () => {
  const deck = buildDeckFromCreate();
  if (!deck) return;
  saveToLibrary(deck.name, deck.mcqs);
  currentMCQs     = deck.mcqs;
  currentDeckName = deck.name;
  shuffledMCQs    = shuffleMCQs(currentMCQs);
  currentIdx      = 0; score = 0; wrongIndices = [];
  renderMCQs(shuffledMCQs);
  document.getElementById('mcqSection').scrollIntoView({ behavior: 'smooth' });
});

createQuestions.push(createBlankQuestion());
renderCreateDeck();

// Reveal create section on button click
document.getElementById('openCreateBtn').addEventListener('click', (e) => {
  e.preventDefault();
  const section = document.getElementById('create');
  section.hidden = false;
  section.scrollIntoView({ behavior: 'smooth' });
});

generateBtn.addEventListener('click', async () => {
  if (!currentFile) { showToast('Please upload a file first.', 'error'); return; }

  await withProcessing('Generating your MCQs…', async () => {
    const form = new FormData();
    form.append('file', currentFile);

    const res = await fetch('/api/mcqs', { method: 'POST', body: form });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${res.status}`);
    }

    currentMCQs  = (await res.json()).map((q, i) => ({ ...q, _origIdx: i }));
    currentMCQs  = applyEdits(currentMCQs);
    shuffledMCQs = shuffleMCQs(currentMCQs);
    currentIdx   = 0;
    score        = 0;
    wrongIndices = [];
    currentDeckName = currentFile.name;
    saveToLibrary(currentFile.name, currentMCQs);
    renderMCQs(shuffledMCQs);
  });
});

// ── Download Anki ─────────────────────────────────────────
async function handleAnkiDownload() {
  if (!currentFile) { showToast('Please upload a file first.', 'error'); return; }

  await withProcessing('Building your Anki deck…', async () => {
    const form = new FormData();
    form.append('file', currentFile);

    const res = await fetch('/api/anki', { method: 'POST', body: form });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${res.status}`);
    }

    const blob = await res.blob();
    // Use the filename the server set in Content-Disposition
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const match       = disposition.match(/filename="?([^"]+)"?/);
    const filename    = match ? match[1] : `${currentFile.name.replace(/\.[^.]+$/, '')}.apkg`;
    triggerDownload(blob, filename);
    showToast('Anki deck downloaded!', 'success');
  });
}

ankiBtn.addEventListener('click',  handleAnkiDownload);
ankiBtn2.addEventListener('click', handleAnkiDownload);

// ── Export / Import JSON deck ─────────────────────────────
function exportDeckJson() {
  if (!currentMCQs.length) { showToast('Generate MCQs first.', 'error'); return; }
  const sourceName = currentDeckName ?? currentFile?.name ?? 'deck';
  const stem = sourceName.replace(/\.[^.]+$/, '');
  const data = {
    _deckagent: true,
    version: 1,
    filename: sourceName,
    exportedAt: new Date().toISOString(),
    questions: currentMCQs.map(q => ({
      question:   q.question,
      choices:    q.choices,
      answers:    q.answers,
      _reasoning: q._reasoning ?? {},
      _origIdx:   q._origIdx,
    }))
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  triggerDownload(blob, `${stem}.deckagent.json`);
  showToast('Deck exported!', 'success');
}

document.getElementById('exportJsonUpload')?.addEventListener('click', exportDeckJson);
document.getElementById('exportJsonResults')?.addEventListener('click', exportDeckJson);

// ── Reshuffle ─────────────────────────────────────────────
document.getElementById('reshuffleBtn').addEventListener('click', () => {
  if (!currentMCQs.length) return;
  // Reshuffle from currentMCQs but re-apply any saved edits first
  // so locally edited questions/answers are preserved
  const base   = applyEdits(currentMCQs);
  shuffledMCQs = shuffleMCQs(base);
  currentIdx   = 0;
  score        = 0;
  wrongIndices = [];
  renderMCQs(shuffledMCQs);
  showToast('Choices reshuffled!', 'info');
});

// ── Reset ─────────────────────────────────────────────────
resetBtn.addEventListener('click', () => {
  mcqSection.hidden = true;
  currentMCQs  = [];
  shuffledMCQs = [];
  currentIdx   = 0;
  score        = 0;
  wrongIndices = [];
  clearFile();
  document.getElementById('upload').scrollIntoView({ behavior: 'smooth' });
});

// ── Shuffle ───────────────────────────────────────────────
// Returns a deep copy where each question's choices are
// randomly reordered and `answers` (array of indices) is
// remapped to match the new positions.
function shuffleMCQs(mcqs) {
  return mcqs.map(mcq => {
    const origChoices = [...mcq.choices];
    const paired = mcq.choices.map((text, idx) => ({
      text,
      origIdx: idx,
      isCorrect: (mcq.answers ?? []).includes(idx)
    }));

    // Fisher-Yates shuffle
    for (let i = paired.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [paired[i], paired[j]] = [paired[j], paired[i]];
    }

    // _origMap[origIdx] = shuffledIdx
    // _revMap[shuffledIdx] = origIdx
    const origMap = {};
    const revMap  = {};
    paired.forEach((p, shuffledIdx) => {
      origMap[p.origIdx]   = shuffledIdx;
      revMap[shuffledIdx]  = p.origIdx;
    });

    return {
      ...mcq,
      _origIdx:    mcq._origIdx,
      _origChoices: origChoices,
      _origMap:    origMap,
      _revMap:     revMap,
      choices: paired.map(p => p.text),
      answers: paired.map((p, i) => p.isCorrect ? i : -1).filter(i => i !== -1)
    };
  });
}

// ── Quiz navigation helpers ───────────────────────────────

/** Show only the card at `idx`, hide all others */
function showCard(idx) {
  const cards = mcqList.querySelectorAll('.mcq-card');
  cards.forEach((c, i) => c.classList.toggle('card-active', i === idx));

  // update progress bar & counter
  const total = shuffledMCQs.length;
  document.getElementById('progressFill').style.width = `${((idx) / total) * 100}%`;
  document.getElementById('progressLabel').textContent = `${idx + 1} / ${total}`;
}

/** Reveal answers on a card, return true if answered correctly */
function revealCard(card, mcq) {
  const correctSet = new Set(mcq.answers ?? []);
  let gotItRight = true;

  card.querySelectorAll('.mcq-choice').forEach(choice => {
    const idx        = parseInt(choice.dataset.index, 10);
    const isCorrect  = correctSet.has(idx);
    const isSelected = choice.classList.contains('selected');

    if (isCorrect)       choice.classList.add('correct');
    else if (isSelected) { choice.classList.add('wrong'); gotItRight = false; }

    // if a correct answer was not selected, still mark it wrong-side
    if (isCorrect && !isSelected && correctSet.size > 0) gotItRight = false;

    choice.style.pointerEvents = 'none';
  });

  // if nothing was selected treat as wrong
  const anySelected = card.querySelector('.mcq-choice.selected');
  if (!anySelected) gotItRight = false;

  return gotItRight;
}

/** Draw a pure-SVG donut pie chart. Returns an SVG string. */
function buildPieChart(correct, wrong, total) {
  const r   = 54;          // radius
  const cx  = 70;          // centre x (extra left space for legend)
  const cy  = 70;
  const tau = 2 * Math.PI;
  const stroke = 14;       // donut thickness

  // angles
  const correctAngle = (correct / total) * tau;
  const wrongAngle   = (wrong   / total) * tau;
  // remaining = skipped (no selection) – same colour as wrong

  function arc(startAngle, sweepAngle, color, id) {
    if (sweepAngle <= 0) return '';
    const x1 = cx + r * Math.sin(startAngle);
    const y1 = cy - r * Math.cos(startAngle);
    const endAngle = startAngle + sweepAngle;
    const x2 = cx + r * Math.sin(endAngle);
    const y2 = cy - r * Math.cos(endAngle);
    const large = sweepAngle > Math.PI ? 1 : 0;
    return `<path id="${id}" d="M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}"
      fill="none" stroke="${color}" stroke-width="${stroke}"
      stroke-linecap="butt"
      style="transition: stroke-dashoffset 0.8s ease"/>`;
  }

  const correctArc = arc(0,             correctAngle,              '#34d399', 'arc-correct');
  const wrongArc   = arc(correctAngle,  wrongAngle + (tau - correctAngle - wrongAngle), '#ff6b6b', 'arc-wrong');

  // centre label
  const pct = Math.round((correct / total) * 100);

  return `
  <svg viewBox="0 0 140 140" width="140" height="140" class="pie-svg">
    <!-- background ring -->
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
      stroke="rgba(255,255,255,0.05)" stroke-width="${stroke}"/>
    ${wrongArc}
    ${correctArc}
    <!-- centre text -->
    <text x="${cx}" y="${cy - 6}" text-anchor="middle"
      font-family="Sora,sans-serif" font-weight="700" font-size="20"
      fill="#f0f0f8">${pct}%</text>
    <text x="${cx}" y="${cy + 12}" text-anchor="middle"
      font-family="Inter,sans-serif" font-size="10" fill="#a0a0b8">correct</text>
  </svg>`;
}

/** Show the final score screen */
function showScoreScreen() {
  const total  = shuffledMCQs.length;
  const wrong  = wrongIndices.length;
  const pct    = Math.round((score / total) * 100);
  const emoji  = pct === 100 ? '🏆' : pct >= 70 ? '🎉' : pct >= 40 ? '📚' : '💪';
  const msg    = pct === 100 ? 'Perfect score!'
               : pct >= 70  ? 'Great work!'
               : pct >= 40  ? 'Keep practising!'
                             : 'Keep going — you\'ll get there!';

  document.getElementById('progressFill').style.width = '100%';
  document.getElementById('progressLabel').textContent = `${total} / ${total}`;

  const scoreScreen = document.getElementById('scoreScreen');
  scoreScreen.innerHTML = `
    <div class="score-card">
      <div class="score-emoji">${emoji}</div>
      <h3 class="score-title">${msg}</h3>

      <div class="score-stats-row">
        <!-- Pie chart -->
        <div class="pie-wrap">
          ${buildPieChart(score, wrong, total)}
        </div>

        <!-- Legend + numbers -->
        <div class="score-legend">
          <div class="legend-item legend-correct">
            <span class="legend-dot"></span>
            <span class="legend-label">Correct</span>
            <span class="legend-val">${score}</span>
          </div>
          <div class="legend-item legend-wrong">
            <span class="legend-dot"></span>
            <span class="legend-label">Wrong</span>
            <span class="legend-val">${wrong}</span>
          </div>
          <div class="score-total-line">${total} questions total</div>
        </div>
      </div>

      <div class="score-actions">
        ${wrong > 0 ? `<button class="btn btn-danger" id="retryWrongBtn">🔁 Retry wrong (${wrong})</button>` : ''}
        <button class="btn btn-outline" id="retryAllBtn">🔀 Retry all</button>
        <button class="btn btn-ghost" id="resetBtnScore">← New file</button>
      </div>
    </div>`;

  scoreScreen.hidden = false;

  // Retry wrong questions only
  document.getElementById('retryWrongBtn')?.addEventListener('click', () => {
    const wrongMCQs  = wrongIndices.map(i => shuffledMCQs[i]);
    shuffledMCQs     = shuffleMCQs(wrongMCQs);
    currentIdx       = 0;
    score            = 0;
    wrongIndices     = [];
    scoreScreen.hidden = true;
    renderMCQs(shuffledMCQs);
  });

  // Retry all
  document.getElementById('retryAllBtn').addEventListener('click', () => {
    shuffledMCQs     = shuffleMCQs(applyEdits(currentMCQs));
    currentIdx       = 0;
    score            = 0;
    wrongIndices     = [];
    scoreScreen.hidden = true;
    renderMCQs(shuffledMCQs);
  });

  document.getElementById('resetBtnScore').addEventListener('click', () => resetBtn.click());
}

// ── Render MCQ cards (one at a time) ─────────────────────
function renderMCQs(mcqs) {
  if (!Array.isArray(mcqs) || mcqs.length === 0) {
    showToast('No questions returned. Try a different file.', 'error');
    return;
  }

  mcqList.innerHTML = '';
  document.getElementById('scoreScreen').hidden = true;
  const letters = ['A', 'B', 'C', 'D', 'E'];

  mcqs.forEach((mcq, i) => {
    const card = document.createElement('div');
    card.className = 'mcq-card';

    // ── Card header: question + edit button ───────────────
    const isMulti = (mcq.answers ?? []).length > 1;

    const cardHeader = document.createElement('div');
    cardHeader.className = 'card-header-row';

    const qEl = document.createElement('p');
    qEl.className = 'mcq-q';
    qEl.innerHTML =
      `<span class="mcq-num">${i + 1}</span><span class="q-text">${escapeHtml(mcq.question)}</span>` +
      (isMulti ? ` <span class="multi-hint">Select all that apply</span>` : '');

    const editBtn = document.createElement('button');
    editBtn.className   = 'btn-icon';
    editBtn.title       = 'Edit question & choices';
    editBtn.innerHTML   = `<svg viewBox="0 0 20 20" fill="currentColor" width="15"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>`;

    cardHeader.appendChild(qEl);
    cardHeader.appendChild(editBtn);
    card.appendChild(cardHeader);

    // ── Choices ───────────────────────────────────────────
    const choicesEl = document.createElement('div');
    choicesEl.className = 'mcq-choices';

    mcq.choices.forEach((text, idx) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'choice-wrapper';

      // The selectable choice row
      const choice = document.createElement('div');
      choice.className     = 'mcq-choice';
      choice.dataset.index = idx;

      // ? reasoning button
      const reasonBtn = document.createElement('button');
      reasonBtn.className = 'btn-reason';
      reasonBtn.title     = 'Add / view reasoning';
      reasonBtn.innerHTML = '?';
      reasonBtn.addEventListener('click', e => {
        e.stopPropagation();
        const panel = wrapper.querySelector('.reason-panel');
        panel.hidden = !panel.hidden;
      });

      choice.innerHTML = `<span class="choice-letter">${letters[idx] ?? idx}</span><span class="choice-text">${escapeHtml(text)}</span>`;
      choice.appendChild(reasonBtn);

      choice.addEventListener('click', (e) => {
        if (e.target.closest('.btn-reason')) return;
        if (isMulti) {
          choice.classList.toggle('selected');
        } else {
          card.querySelectorAll('.mcq-choice').forEach(c => c.classList.remove('selected'));
          choice.classList.add('selected');
        }
      });

      // Reasoning panel (hidden by default, read-only until Edit clicked)
      const savedReason = mcq._reasoning?.[idx] ?? '';
      const reasonPanel = document.createElement('div');
      reasonPanel.className = 'reason-panel';
      reasonPanel.hidden    = true;

      // Build panel content
      const reasonTA = document.createElement('textarea');
      reasonTA.className   = 'reason-textarea';
      reasonTA.placeholder = 'No reasoning added yet.';
      reasonTA.value       = savedReason;
      reasonTA.readOnly    = true;

      const reasonActionsEl = document.createElement('div');
      reasonActionsEl.className = 'reason-actions';

      const editReasonBtn = document.createElement('button');
      editReasonBtn.className   = 'reason-edit-btn';
      editReasonBtn.textContent = '✏ Edit';

      const saveReasonBtn = document.createElement('button');
      saveReasonBtn.className   = 'reason-save-btn';
      saveReasonBtn.textContent = 'Save';
      saveReasonBtn.hidden      = true;

      const cancelReasonBtn = document.createElement('button');
      cancelReasonBtn.className   = 'reason-close-btn';
      cancelReasonBtn.textContent = 'Cancel';
      cancelReasonBtn.hidden      = true;

      const closeReasonBtn = document.createElement('button');
      closeReasonBtn.className   = 'reason-close-btn';
      closeReasonBtn.textContent = 'Close';

      // Edit toggles textarea to editable
      editReasonBtn.addEventListener('click', () => {
        reasonTA.readOnly        = false;
        reasonTA.classList.add('reason-editing');
        reasonTA.focus();
        editReasonBtn.hidden  = true;
        closeReasonBtn.hidden = true;
        saveReasonBtn.hidden  = false;
        cancelReasonBtn.hidden = false;
      });

      // Save
      saveReasonBtn.addEventListener('click', () => {
        const val = reasonTA.value.trim();
        const edits = loadEdits();
        const key   = qKey(mcq);   // always _origIdx
        if (!edits[key]) edits[key] = {};
        if (!edits[key].reasoning) edits[key].reasoning = {};
        edits[key].reasoning[idx] = val;
        saveEdits(edits);
        if (!mcq._reasoning) mcq._reasoning = {};
        mcq._reasoning[idx] = val;
        showToast('Reasoning saved!', 'success');
        // Back to read-only view
        reasonTA.readOnly = true;
        reasonTA.classList.remove('reason-editing');
        editReasonBtn.hidden   = false;
        closeReasonBtn.hidden  = false;
        saveReasonBtn.hidden   = true;
        cancelReasonBtn.hidden = true;
      });

      // Cancel edit — restore saved value
      cancelReasonBtn.addEventListener('click', () => {
        reasonTA.value    = mcq._reasoning?.[idx] ?? '';
        reasonTA.readOnly = true;
        reasonTA.classList.remove('reason-editing');
        editReasonBtn.hidden   = false;
        closeReasonBtn.hidden  = false;
        saveReasonBtn.hidden   = true;
        cancelReasonBtn.hidden = true;
      });

      // Close panel entirely
      closeReasonBtn.addEventListener('click', () => {
        reasonPanel.hidden = true;
      });

      reasonActionsEl.appendChild(editReasonBtn);
      reasonActionsEl.appendChild(saveReasonBtn);
      reasonActionsEl.appendChild(cancelReasonBtn);
      reasonActionsEl.appendChild(closeReasonBtn);
      reasonPanel.appendChild(reasonTA);
      reasonPanel.appendChild(reasonActionsEl);

      wrapper.appendChild(choice);
      wrapper.appendChild(reasonPanel);
      choicesEl.appendChild(wrapper);
    });

    card.appendChild(choicesEl);

    // ── Edit mode (question + choices + correct answers) ──
    const editPanel = document.createElement('div');
    editPanel.className = 'edit-panel';
    editPanel.hidden    = true;

    const editFields = document.createElement('div');
    editFields.className = 'edit-fields';
    editFields.innerHTML = `
      <label class="edit-label">Question</label>
      <textarea class="edit-textarea" data-field="question" rows="2">${escapeHtml(mcq.question)}</textarea>
      <label class="edit-label" style="margin-top:10px">Choices &amp; correct answers</label>
      <p class="edit-hint">Check ✓ the box(es) next to the correct answer(s).</p>
      ${mcq.choices.map((c, idx) => `
        <div class="edit-choice-row">
          <label class="edit-correct-toggle" title="Mark as correct">
            <input type="checkbox" data-correct="${idx}" ${(mcq.answers ?? []).includes(idx) ? 'checked' : ''} />
            <span class="edit-check-indicator"></span>
          </label>
          <input class="edit-input" data-field="choice" data-idx="${idx}" value="${escapeHtml(c)}" />
        </div>
      `).join('')}
    `;

    const editActions = document.createElement('div');
    editActions.className = 'edit-actions';
    editActions.innerHTML = `
      <button class="btn btn-primary btn-sm edit-save-btn">Save changes</button>
      <button class="btn btn-ghost btn-sm edit-cancel-btn">Cancel</button>
    `;

    editPanel.appendChild(editFields);
    editPanel.appendChild(editActions);
    card.appendChild(editPanel);

    // Toggle edit panel — sync values each open
    editBtn.addEventListener('click', () => {
      editPanel.hidden = !editPanel.hidden;
      if (!editPanel.hidden) {
        editPanel.querySelector('[data-field="question"]').value = mcq.question;
        mcq.choices.forEach((c, idx) => {
          editPanel.querySelector(`[data-idx="${idx}"]`).value = c;
          editPanel.querySelector(`[data-correct="${idx}"]`).checked = (mcq.answers ?? []).includes(idx);
        });
      }
    });

    editPanel.querySelector('.edit-cancel-btn').addEventListener('click', () => {
      editPanel.hidden = true;
    });

    editPanel.querySelector('.edit-save-btn').addEventListener('click', () => {
      const newQ = editPanel.querySelector('[data-field="question"]').value.trim();

      // Choices in the edit panel are displayed in SHUFFLED order.
      // We need to save them mapped back to the ORIGINAL order so
      // applyEdits can restore them onto currentMCQs correctly.
      // mcq._origChoices holds the original unshuffled choices array.
      const origChoices = mcq._origChoices ?? mcq.choices;
      const newChoicesByOrig = [...origChoices]; // will fill by orig index
      const newAnswersByOrig = [];

      origChoices.forEach((origText, origIdx) => {
        // Find which shuffled slot corresponds to this original choice
        const shuffledIdx = mcq._origMap?.[origIdx] ?? origIdx;
        const newText  = editPanel.querySelector(`[data-idx="${shuffledIdx}"]`)?.value.trim();
        const isChecked = editPanel.querySelector(`[data-correct="${shuffledIdx}"]`)?.checked;
        if (newText) newChoicesByOrig[origIdx] = newText;
        if (isChecked) newAnswersByOrig.push(origIdx);
      });

      // Update in-memory shuffled copy (for immediate visual update)
      mcq.question = newQ || mcq.question;
      mcq.choices.forEach((_, shuffledIdx) => {
        const origIdx = mcq._revMap?.[shuffledIdx] ?? shuffledIdx;
        mcq.choices[shuffledIdx] = newChoicesByOrig[origIdx] ?? mcq.choices[shuffledIdx];
      });
      // Remap answers back to shuffled positions
      mcq.answers = newAnswersByOrig.map(origIdx => mcq._origMap?.[origIdx] ?? origIdx);

      // Update currentMCQs (original order) so reshuffle is correct
      const orig = currentMCQs.find(q => q._origIdx === mcq._origIdx);
      if (orig) {
        orig.question = mcq.question;
        orig.choices  = [...newChoicesByOrig];
        orig.answers  = [...newAnswersByOrig];
      }

      // Persist to localStorage in original order
      const edits = loadEdits();
      const key   = qKey(mcq);
      if (!edits[key]) edits[key] = {};
      edits[key].question = mcq.question;
      edits[key].choices  = [...newChoicesByOrig];
      edits[key].answers  = [...newAnswersByOrig];
      saveEdits(edits);

      // Update visible question text and choice texts
      qEl.querySelector('.q-text').textContent = mcq.question;
      card.querySelectorAll('.choice-text').forEach((el, si) => {
        el.textContent = mcq.choices[si] ?? el.textContent;
      });
      const multiHint = qEl.querySelector('.multi-hint');
      if (mcq.answers.length > 1 && !multiHint) {
        const hint = document.createElement('span');
        hint.className = 'multi-hint';
        hint.textContent = 'Select all that apply';
        qEl.appendChild(hint);
      } else if (mcq.answers.length <= 1 && multiHint) {
        multiHint.remove();
      }

      editPanel.hidden = true;
      showToast('Changes saved locally!', 'success');
    });

    // ── Card footer: Confirm → Next / Finish ──────────────
    const cardFooter = document.createElement('div');
    cardFooter.className = 'card-footer';

    const actionBtn = document.createElement('button');
    actionBtn.className   = 'btn-confirm';
    actionBtn.textContent = 'Confirm';

    actionBtn.addEventListener('click', () => {
      if (!actionBtn.dataset.confirmed) {
        const correct = revealCard(card, mcq);
        if (correct) { score++; } else { wrongIndices.push(i); }
        actionBtn.dataset.confirmed = '1';
        const isLast = (i === mcqs.length - 1);
        actionBtn.textContent = isLast ? 'Finish 🎉' : 'Next →';
        actionBtn.classList.add('next-mode');
      } else {
        const isLast = (i === mcqs.length - 1);
        if (isLast) { showScoreScreen(); }
        else { currentIdx = i + 1; showCard(currentIdx); }
      }
    });

    cardFooter.appendChild(actionBtn);
    card.appendChild(cardFooter);
    mcqList.appendChild(card);
  });

  document.getElementById('progressFill').style.width  = '0%';
  document.getElementById('progressLabel').textContent = `1 / ${mcqs.length}`;
  mcqCountEl.textContent = `${mcqs.length} question${mcqs.length !== 1 ? 's' : ''}`;
  mcqSection.hidden      = false;
  mcqSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  showCard(0);
}

// ── Helpers ───────────────────────────────────────────────
async function withProcessing(message, fn) {
  processingText.textContent = message;
  processing.hidden    = false;
  generateBtn.disabled = true;
  ankiBtn.disabled     = true;
  try {
    await fn();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Something went wrong.', 'error');
  } finally {
    processing.hidden    = true;
    generateBtn.disabled = false;
    ankiBtn.disabled     = false;
  }
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(msg, type = 'info') {
  document.querySelector('.toast')?.remove();
  const t = Object.assign(document.createElement('div'), {
    className: `toast toast-${type}`,
    textContent: msg
  });
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('toast-visible'));
  setTimeout(() => {
    t.classList.remove('toast-visible');
    setTimeout(() => t.remove(), 400);
  }, 3500);
}
