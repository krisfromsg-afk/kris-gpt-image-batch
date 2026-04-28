// popup.js — GPT Image Batch Pro

// URLs are defined in config.js
const LICENSE_SERVER = CONFIG.LICENSE_SERVER;
const GET_KEY_URL    = CONFIG.GET_KEY_URL;

// ── State ──────────────────────────────────────────────
let imageFiles  = [];
let presets     = {};
let delayVal    = 10;
let quality     = 'standard';
let ratio       = 'auto';
let tgEnabled   = false;
let batchStatus = 'idle'; // idle | running | paused | stopped
let appMode     = 'transform'; // 'transform' | 'reference'
let refImages   = [null, null]; // File objects for reference mode

// ── DOM refs ───────────────────────────────────────────
const $ = id => document.getElementById(id);
const licenseScreen = $('license-screen');
const mainScreen    = $('main-screen');

// ══════════════════════════════════════════════════════
//  BOOT — check license
// ══════════════════════════════════════════════════════
chrome.storage.local.get(['licenseKey','licenseValid'], data => {
  if (data.licenseValid) {
    showMain();
  } else {
    licenseScreen.classList.remove('hidden');
    mainScreen.classList.add('hidden');
  }
});

// ── License activate ───────────────────────────────────
$('activate-btn').addEventListener('click', activateLicense);
$('license-input').addEventListener('keydown', e => { if(e.key==='Enter') activateLicense(); });
$('get-key-link').addEventListener('click', e => {
  e.preventDefault();
  chrome.tabs.create({ url: GET_KEY_URL });
});

async function activateLicense() {
  const key = $('license-input').value.trim().toUpperCase();
  if (!key) return showLicenseError('Please enter a license key.');

  $('license-loading').classList.remove('hidden');
  $('license-error').classList.add('hidden');
  $('activate-btn').disabled = true;

  try {
    const res = await fetch(LICENSE_SERVER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const json = await res.json();

    if (json.valid) {
      chrome.storage.local.set({ licenseKey: key, licenseValid: true });
      showMain();
    } else {
      showLicenseError(json.message || 'Invalid license key.');
    }
  } catch {
    if (CONFIG.DEV_MODE) {
      // Dev mode: bypass license check (config.js → DEV_MODE: false before production build)
      chrome.storage.local.set({ licenseKey: 'DEV', licenseValid: true });
      showMain();
    } else {
      showLicenseError('Cannot connect to license server. Try again.');
    }
  } finally {
    $('license-loading').classList.add('hidden');
    $('activate-btn').disabled = false;
  }
}

function showLicenseError(msg) {
  const el = $('license-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function showMain() {
  licenseScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');
  initMain();
}

// ── Logout license ─────────────────────────────────────
$('logout-btn').addEventListener('click', () => {
  if (confirm('Remove license key?')) {
    chrome.storage.local.remove(['licenseKey','licenseValid'], () => location.reload());
  }
});

// ══════════════════════════════════════════════════════
//  INIT MAIN
// ══════════════════════════════════════════════════════
function initMain() {
  loadSettings();
  loadPresets();
  checkChatGPTSession();
  setupModeToggle();
  setupFileInput();
  setupPrompt();
  setupReferenceImages();
  setupPromptList();
  setupSettings();
  setupTelegram();
  setupBatchControls();
  restoreBatchState();
  setInterval(checkChatGPTSession, 30000);
}

// ══════════════════════════════════════════════════════
//  MODE TOGGLE
// ══════════════════════════════════════════════════════
function setupModeToggle() {
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      appMode = btn.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === appMode));
      $('transform-section').classList.toggle('hidden', appMode !== 'transform');
      $('reference-section').classList.toggle('hidden', appMode !== 'reference');
      updateUI();
    });
  });
}

// ══════════════════════════════════════════════════════
//  REFERENCE IMAGES
// ══════════════════════════════════════════════════════
function setupReferenceImages() {
  [0, 1].forEach(slot => {
    const slotEl  = $(`ref-slot-${slot}`);
    const inputEl = $(`ref-input-${slot}`);

    slotEl.addEventListener('click', () => inputEl.click());
    inputEl.addEventListener('change', () => {
      if (inputEl.files[0]) setRefImage(slot, inputEl.files[0]);
    });

    slotEl.addEventListener('dragover', e => { e.preventDefault(); slotEl.style.borderColor = 'var(--accent)'; });
    slotEl.addEventListener('dragleave', () => { slotEl.style.borderColor = ''; });
    slotEl.addEventListener('drop', e => {
      e.preventDefault();
      slotEl.style.borderColor = '';
      const file = Array.from(e.dataTransfer.files).find(f => f.type.startsWith('image/'));
      if (file) setRefImage(slot, file);
    });

    const clearBtn = slotEl.querySelector('.ref-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', e => {
        e.stopPropagation();
        clearRefImage(slot);
      });
    }
  });
}

function setRefImage(slot, file) {
  refImages[slot] = file;
  const url = URL.createObjectURL(file);
  $(`ref-img-${slot}`).src = url;
  $(`ref-empty-${slot}`).classList.add('hidden');
  $(`ref-preview-${slot}`).classList.remove('hidden');
  $(`ref-slot-${slot}`).classList.add('has-image');
  updateUI();
}

function clearRefImage(slot) {
  if (refImages[slot]) URL.revokeObjectURL($(`ref-img-${slot}`).src);
  refImages[slot] = null;
  $(`ref-img-${slot}`).src = '';
  $(`ref-empty-${slot}`).classList.remove('hidden');
  $(`ref-preview-${slot}`).classList.add('hidden');
  $(`ref-slot-${slot}`).classList.remove('has-image');
  updateUI();
}

// ══════════════════════════════════════════════════════
//  PROMPT LIST (line-numbered editor)
// ══════════════════════════════════════════════════════
function setupPromptList() {
  const ta = $('prompt-list');
  if (!ta) return;

  ta.addEventListener('input', () => {
    syncLineNumbers();
    updatePromptCount();
    updateUI();
  });

  ta.addEventListener('scroll', () => {
    $('line-numbers').scrollTop = ta.scrollTop;
  });

  $('clear-prompts-btn').addEventListener('click', () => {
    ta.value = '';
    syncLineNumbers();
    updatePromptCount();
    updateUI();
  });

  syncLineNumbers();
}

function syncLineNumbers() {
  const ta    = $('prompt-list');
  const ln    = $('line-numbers');
  if (!ta || !ln) return;
  const count = ta.value ? ta.value.split('\n').length : 1;
  ln.textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n');
  ln.scrollTop = ta.scrollTop;
}

function getPromptLines() {
  const ta = $('prompt-list');
  if (!ta) return [];
  return ta.value.split('\n').map(l => l.trim()).filter(Boolean);
}

function updatePromptCount() {
  const lines = getPromptLines();
  const n = lines.length;
  const el = $('ref-prompt-count');
  if (el) el.textContent = n > 0 ? `${n} prompt${n > 1 ? 's' : ''} · max 50` : '0 prompts';
}

// ══════════════════════════════════════════════════════
//  RESTORE BATCH STATE (when panel is reopened mid-batch)
// ══════════════════════════════════════════════════════
function restoreBatchState() {
  chrome.storage.session.get(
    ['batchQueue','batchPaused','batchStopped','currentIndex','doneCount'],
    (s) => {
      if (!s.batchQueue?.length || s.batchStopped) return;

      const queue = s.batchQueue;
      const done  = s.doneCount || 0;
      const total = queue.length;

      batchStatus = s.batchPaused ? 'paused' : 'running';

      $('progress-section').classList.remove('hidden');
      $('start-btn').classList.add('hidden');
      $('stop-btn').classList.remove('hidden');

      if (s.batchPaused) {
        $('resume-btn').classList.remove('hidden');
      } else {
        $('pause-btn').classList.remove('hidden');
      }

      $('prog-log').innerHTML = '';
      queue.forEach((item, i) => {
        let status;
        if (item.done)          status = 'success';
        else if (item.error)    status = 'error';
        else if (i === s.currentIndex) status = s.batchPaused ? 'pending' : 'processing';
        else if (i < s.currentIndex)  status = 'error';
        else                          status = 'pending';
        addLogRow(i, item.name, status, {
          success: '✅ Saved', error: '❌ Error',
          processing: '⚡ Generating...', pending: '⏳ Pending'
        }[status]);
      });

      updateProgress(done, total);
    }
  );
}

// ══════════════════════════════════════════════════════
//  SESSION CHECK
// ══════════════════════════════════════════════════════
function checkChatGPTSession() {
  chrome.cookies.get({ url: 'https://chatgpt.com', name: '__Secure-next-auth.session-token' }, cookie => {
    const ok = !!cookie;
    $('conn-dot').className = 'status-dot ' + (ok ? 'status-ok' : 'status-err');
    $('conn-label').textContent = ok ? 'Connected' : 'Not logged in';
    if (!ok) {
      $('conn-label').style.color = 'var(--red)';
    } else {
      $('conn-label').style.color = '';
    }
  });
}

// ══════════════════════════════════════════════════════
//  FILE INPUT
// ══════════════════════════════════════════════════════
function setupFileInput() {
  const zone   = $('drop-zone');
  const input  = $('file-input');

  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => handleFiles(Array.from(input.files)));

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('over');
    handleFiles(Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/')));
  });
}

function handleFiles(files) {
  imageFiles = files.slice(0, 50);
  renderThumbs();
  updateUI();
}

function renderThumbs() {
  const strip = $('thumb-strip');
  const count = $('img-count');
  strip.innerHTML = '';

  if (!imageFiles.length) {
    strip.classList.add('hidden');
    count.classList.add('hidden');
    return;
  }

  imageFiles.forEach((file, i) => {
    const url = URL.createObjectURL(file);
    const div = document.createElement('div');
    div.className = 'th pending';
    div.id = `th-${i}`;
    div.innerHTML = `<img src="${url}" title="${file.name}"><span class="th-badge">⏳</span>`;
    strip.appendChild(div);
  });

  strip.classList.remove('hidden');
  count.classList.remove('hidden');
  count.textContent = `${imageFiles.length} image${imageFiles.length>1?'s':''} selected · max 50`;
}

function setThumbStatus(i, status) {
  const el = document.getElementById(`th-${i}`);
  if (!el) return;
  el.className = `th ${status}`;
  const badges = { pending:'⏳', processing:'⚡', success:'✅', error:'❌' };
  el.querySelector('.th-badge').textContent = badges[status] || '';
}

// ══════════════════════════════════════════════════════
//  PROMPT + PRESETS
// ══════════════════════════════════════════════════════
function setupPrompt() {
  const ta = $('prompt-input');
  ta.addEventListener('input', () => {
    $('char-count').textContent = ta.value.length;
    updateUI();
  });

  $('save-preset-btn').addEventListener('click', () => {
    if (!ta.value.trim()) return;
    $('preset-modal').classList.remove('hidden');
    $('preset-name').focus();
  });

  $('preset-confirm').addEventListener('click', savePreset);
  $('preset-cancel').addEventListener('click', () => $('preset-modal').classList.add('hidden'));
  $('preset-name').addEventListener('keydown', e => { if(e.key==='Enter') savePreset(); });

  $('del-preset-btn').addEventListener('click', () => {
    const sel = $('preset-select');
    const name = sel.value;
    if (!name) return;
    delete presets[name];
    chrome.storage.local.set({ presets });
    renderPresetDropdown();
    sel.value = '';
  });

  $('preset-select').addEventListener('change', () => {
    const name = $('preset-select').value;
    if (name && presets[name]) {
      $('prompt-input').value = presets[name];
      $('char-count').textContent = presets[name].length;
      updateUI();
    }
  });
}

function savePreset() {
  const name = $('preset-name').value.trim();
  const prompt = $('prompt-input').value.trim();
  if (!name) return;
  presets[name] = prompt;
  chrome.storage.local.set({ presets });
  renderPresetDropdown();
  $('preset-modal').classList.add('hidden');
  $('preset-name').value = '';
}

function loadPresets() {
  chrome.storage.local.get('presets', d => {
    presets = d.presets || {};
    renderPresetDropdown();
  });
}

function renderPresetDropdown() {
  const sel = $('preset-select');
  sel.innerHTML = '<option value="">Load preset...</option>';
  Object.keys(presets).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    sel.appendChild(opt);
  });
}

// ══════════════════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════════════════
function setupSettings() {
  // Quality toggle
  document.querySelectorAll('[data-quality]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-quality]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      quality = btn.dataset.quality;
      saveSettings();
    });
  });

  // Ratio toggle
  document.querySelectorAll('[data-ratio]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-ratio]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      ratio = btn.dataset.ratio;
      saveSettings();
    });
  });

  // Delay
  $('delay-minus').addEventListener('click', () => {
    if (delayVal > 5) { delayVal -= 5; $('delay-val').textContent = delayVal; saveSettings(); }
  });
  $('delay-plus').addEventListener('click', () => {
    if (delayVal < 60) { delayVal += 5; $('delay-val').textContent = delayVal; saveSettings(); }
  });
}

function loadSettings() {
  chrome.storage.local.get(['quality','ratio','delay','tgEnabled','tgToken','tgChatId'], d => {
    if (d.quality) {
      quality = d.quality;
      document.querySelectorAll('[data-quality]').forEach(b => b.classList.toggle('active', b.dataset.quality === quality));
    }
    if (d.ratio) {
      ratio = d.ratio;
      document.querySelectorAll('[data-ratio]').forEach(b => b.classList.toggle('active', b.dataset.ratio === ratio));
    }
    if (d.delay)     { delayVal = d.delay; $('delay-val').textContent = delayVal; }
    if (d.tgEnabled) { $('tg-toggle').checked = true; $('tg-config').classList.remove('hidden'); }
    if (d.tgToken)   $('tg-token').value = d.tgToken;
    if (d.tgChatId)  $('tg-chatid').value = d.tgChatId;
  });
}

function saveSettings() {
  chrome.storage.local.set({
    quality, ratio, delay: delayVal,
    tgEnabled: $('tg-toggle').checked,
    tgToken: $('tg-token').value,
    tgChatId: $('tg-chatid').value
  });
}

// ══════════════════════════════════════════════════════
//  TELEGRAM
// ══════════════════════════════════════════════════════
function setupTelegram() {
  $('tg-toggle').addEventListener('change', () => {
    $('tg-config').classList.toggle('hidden', !$('tg-toggle').checked);
    saveSettings();
  });
  $('tg-token').addEventListener('change', saveSettings);
  $('tg-chatid').addEventListener('change', saveSettings);
  $('tg-test-btn').addEventListener('click', async () => {
    const token  = $('tg-token').value.trim();
    const chatId = $('tg-chatid').value.trim();
    if (!token || !chatId) return alert('Enter Bot Token & Chat ID first.');
    const ok = await sendTelegram(token, chatId, '✅ GPT Image Batch Pro — Telegram connected!');
    alert(ok ? '✅ Sent! Check your Telegram.' : '❌ Failed. Check token & chat ID.');
  });
}

async function sendTelegram(token, chatId, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
    return r.ok;
  } catch { return false; }
}

// ══════════════════════════════════════════════════════
//  BATCH CONTROLS
// ══════════════════════════════════════════════════════
function setupBatchControls() {
  $('start-btn').addEventListener('click', startBatch);
  $('pause-btn').addEventListener('click', pauseBatch);
  $('resume-btn').addEventListener('click', resumeBatch);
  $('stop-btn').addEventListener('click', stopBatch);
}

function updateUI() {
  let ready = false;
  let n = 0;

  if (appMode === 'transform') {
    const hasPrompt = $('prompt-input') && $('prompt-input').value.trim().length > 0;
    ready = imageFiles.length > 0 && hasPrompt;
    n = imageFiles.length;
  } else {
    const prompts = getPromptLines();
    ready = refImages[0] && refImages[1] && prompts.length > 0;
    n = prompts.length;
  }

  $('start-btn').disabled = !ready || batchStatus === 'running';

  const secs = n * (delayVal + 45);
  const mins = Math.ceil(secs / 60);
  $('batch-label').textContent = n > 0
    ? `${n} ${appMode === 'reference' ? 'prompt' : 'image'}${n > 1 ? 's' : ''} · ~${mins} min estimated`
    : '';
}

// ── BATCH START ────────────────────────────────────────
function startBatch() {
  if (appMode === 'reference') {
    startReferenceBatch();
  } else {
    startTransformBatch();
  }
}

function startTransformBatch() {
  if (!imageFiles.length) return;
  const prompt = $('prompt-input').value.trim();
  if (!prompt) return;

  batchStatus = 'running';

  Promise.all(imageFiles.map(fileToBase64)).then(b64array => {
    const batchId = 'batch_' + new Date().toISOString().slice(0,10).replace(/-/g,'');
    chrome.runtime.sendMessage({
      type: 'START_BATCH',
      payload: {
        mode: 'transform',
        images: b64array.map((data, i) => ({ data, name: imageFiles[i].name })),
        prompt, quality, ratio, delay: delayVal, batchId,
        tg: $('tg-toggle').checked ? { token: $('tg-token').value.trim(), chatId: $('tg-chatid').value.trim() } : null
      }
    });
    showProgressUI();
  });
}

function startReferenceBatch() {
  const prompts = getPromptLines().slice(0, 50);
  if (!refImages[0] || !refImages[1] || !prompts.length) return;

  batchStatus = 'running';

  Promise.all([fileToBase64(refImages[0]), fileToBase64(refImages[1])]).then(([ref0, ref1]) => {
    const batchId = 'batch_' + new Date().toISOString().slice(0,10).replace(/-/g,'');
    chrome.runtime.sendMessage({
      type: 'START_BATCH',
      payload: {
        mode: 'reference',
        refImages: [ref0, ref1],
        images: prompts.map((p, i) => ({
          data: null,
          name: `prompt_${String(i+1).padStart(3,'0')}`,
          prompt: p
        })),
        prompt: '', quality, ratio, delay: delayVal, batchId,
        tg: $('tg-toggle').checked ? { token: $('tg-token').value.trim(), chatId: $('tg-chatid').value.trim() } : null
      }
    });
    showProgressUI();
  });
}

function pauseBatch() {
  batchStatus = 'paused';
  chrome.runtime.sendMessage({ type: 'PAUSE_BATCH' });
  $('pause-btn').classList.add('hidden');
  $('resume-btn').classList.remove('hidden');
}

function resumeBatch() {
  batchStatus = 'running';
  chrome.runtime.sendMessage({ type: 'RESUME_BATCH' });
  $('resume-btn').classList.add('hidden');
  $('pause-btn').classList.remove('hidden');
}

function stopBatch() {
  batchStatus = 'idle';
  chrome.runtime.sendMessage({ type: 'STOP_BATCH' });
  $('pause-btn').classList.add('hidden');
  $('resume-btn').classList.add('hidden');
  $('stop-btn').classList.add('hidden');
  $('start-btn').classList.remove('hidden');
  updateUI();
}

function showProgressUI() {
  $('progress-section').classList.remove('hidden');
  $('start-btn').classList.add('hidden');
  $('pause-btn').classList.remove('hidden');
  $('stop-btn').classList.remove('hidden');

  $('prog-log').innerHTML = '';

  if (appMode === 'reference') {
    const prompts = getPromptLines().slice(0, 50);
    prompts.forEach((p, i) => {
      addLogRow(i, p.length > 40 ? p.slice(0, 40) + '…' : p, 'pending', '⏳ Pending');
    });
    updateProgress(0, prompts.length);
  } else {
    imageFiles.forEach((f, i) => {
      addLogRow(i, f.name, 'pending', '⏳ Pending');
    });
    updateProgress(0, imageFiles.length);
  }
}

// ── Progress messages from background ─────────────────
let startTime = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'BATCH_PROGRESS') {
    const { index, status, filename, total, done, errorMsg, elapsed } = msg;

    if (!startTime && done > 0) startTime = Date.now();

    setThumbStatus(index, status);
    updateLogRow(index, filename, status, errorMsg, elapsed);
    updateProgress(done, total);
    updateETA(done, total);
  }

  if (msg.type === 'BATCH_DONE') {
    batchStatus = 'idle';
    $('pause-btn').classList.add('hidden');
    $('resume-btn').classList.add('hidden');
    $('stop-btn').classList.add('hidden');
    $('start-btn').classList.remove('hidden');
    $('start-btn').disabled = false;
    startTime = null;
  }
});

function updateProgress(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  $('prog-bar').style.width = pct + '%';
  $('prog-count').textContent = `${done} / ${total}`;
}

function updateETA(done, total) {
  if (!startTime || done === 0) return;
  const elapsed = (Date.now() - startTime) / 1000;
  $('prog-elapsed').textContent = `⏱ ${fmtTime(elapsed)}`;
  if (done < total) {
    const rate = elapsed / done;
    const remaining = rate * (total - done);
    $('prog-eta').textContent = `ETA ${fmtTime(remaining)}`;
  } else {
    $('prog-eta').textContent = '✅ Done';
  }
}

function fmtTime(secs) {
  const m = Math.floor(secs / 60), s = Math.round(secs % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ── Log rows ───────────────────────────────────────────
function addLogRow(i, name, status, label) {
  const row = document.createElement('div');
  row.className = `log-row ${status}`;
  row.id = `log-${i}`;
  row.innerHTML = `<span>${label}</span><span style="margin-left:auto;opacity:.6">${name}</span>`;
  $('prog-log').appendChild(row);
}

function updateLogRow(i, name, status, errorMsg, elapsed) {
  const row = $(`log-${i}`);
  if (!row) return;
  const labels = {
    processing: elapsed ? `⚡ Generating... (${elapsed}s)` : '⚡ Generating...',
    success:    '✅ Saved',
    error:      '❌ Error',
    pending:    '⏳ Pending',
    rate_limit: '⏸ Rate limit'
  };
  row.className = `log-row ${status}`;
  const showDetail = (status === 'error' || status === 'rate_limit') && errorMsg;
  const errDetail = showDetail
    ? ` <span style="opacity:.6;font-size:10px" title="${errorMsg.replace(/"/g,'&quot;')}">— ${errorMsg.slice(0, 40)}${errorMsg.length > 40 ? '…' : ''}</span>`
    : '';
  let html = `<span>${labels[status]||status}${errDetail}</span><span style="margin-left:4px;opacity:.6">${name}</span>`;
  if (status === 'error') {
    html += `<button class="retry-btn" data-index="${i}">Retry</button>`;
  }
  row.innerHTML = html;

  // Retry click
  const retryBtn = row.querySelector('.retry-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'RETRY_IMAGE', index: i });
    });
  }

  // Auto scroll
  $('prog-log').scrollTop = $('prog-log').scrollHeight;
}

// ── Helper ─────────────────────────────────────────────
function fileToBase64(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.readAsDataURL(file);
  });
}
