// background.js — Service Worker

let batchQueue   = [];
let batchConfig  = {};
let batchPaused  = false;
let batchStopped = false;
let chatTabId    = null;
let currentIndex = 0;
let doneCount    = 0;

// ── Open side panel on icon click ──────────────────────
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ── Persist state to chrome.storage.session (survives SW idle unload) ──
async function saveState() {
  await chrome.storage.session.set({
    batchQueue, batchConfig, batchPaused, batchStopped,
    chatTabId, currentIndex, doneCount
  });
}

async function loadState() {
  const s = await chrome.storage.session.get([
    'batchQueue','batchConfig','batchPaused','batchStopped',
    'chatTabId','currentIndex','doneCount'
  ]);
  if (s.batchQueue)              batchQueue   = s.batchQueue;
  if (s.batchConfig)             batchConfig  = s.batchConfig;
  if (s.batchPaused  !== undefined) batchPaused  = s.batchPaused;
  if (s.batchStopped !== undefined) batchStopped = s.batchStopped;
  if (s.chatTabId    !== undefined) chatTabId    = s.chatTabId;
  if (s.currentIndex !== undefined) currentIndex = s.currentIndex;
  if (s.doneCount    !== undefined) doneCount    = s.doneCount;
}

// Restore state when SW wakes up after being killed
loadState();

// ── Message handler ────────────────────────────────────
const ALLOWED_ORIGINS = ['https://chatgpt.com', 'https://chat.openai.com'];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from the extension itself or allowed ChatGPT origins
  const fromExtension = !sender.tab;
  const fromChatGPT   = sender.tab && ALLOWED_ORIGINS.some(o => sender.tab.url?.startsWith(o));
  if (!fromExtension && !fromChatGPT) return;

  if (msg.type === 'START_BATCH')  startBatch(msg.payload);
  if (msg.type === 'PAUSE_BATCH')  { batchPaused = true;  saveState(); }
  if (msg.type === 'RESUME_BATCH') { batchPaused = false; saveState(); processNext(); }
  if (msg.type === 'STOP_BATCH')   { batchStopped = true; saveState(); closeChatTab(); }
  if (msg.type === 'RETRY_IMAGE')  retryImage(msg.index);
});

// ══════════════════════════════════════════════════════
//  START BATCH — open ONE tab, reuse for all images
// ══════════════════════════════════════════════════════
async function startBatch(payload) {
  batchQueue   = payload.images;
  batchConfig  = payload;
  batchPaused  = false;
  batchStopped = false;
  currentIndex = 0;
  doneCount    = 0;
  await saveState();

  chatTabId = await openChatGPTTab();

  try {
    await waitForContentReady(chatTabId, 25000);
  } catch(e) {
    // Clear dead tab so retry can open a fresh one
    closeChatTab();
    notifyTelegram('❌ Could not open ChatGPT. Make sure you are logged in.');
    chrome.runtime.sendMessage({ type: 'BATCH_ERROR', error: 'ChatGPT tab failed to load' });
    return;
  }

  await processNext();
}

async function processNext() {
  if (batchStopped) return;
  if (batchPaused)  return;
  if (currentIndex >= batchQueue.length) { onBatchComplete(); return; }

  const item = batchQueue[currentIndex];
  if (item.done) { currentIndex++; return processNext(); }

  await processImage(item, currentIndex);
}

// ══════════════════════════════════════════════════════
//  PROCESS ONE IMAGE
// ══════════════════════════════════════════════════════
async function processImage(item, index) {
  sendProgress(index, 'processing', item.name);

  try {
    const result = await sendTaskToTab(chatTabId, {
      imageData: item.data,
      prompt:    buildPrompt(),
      quality:   batchConfig.quality,
      ratio:     batchConfig.ratio,
      index
    });

    if (result.success) {
      const filename = buildFilename(index, item.name);

      if (!result.imageBase64 || !result.imageBase64.startsWith('data:image/')) {
        throw new Error('Response is not a valid image (ChatGPT may have returned text only)');
      }

      await saveBase64Image(result.imageBase64, filename, batchConfig.batchId);

      item.done = true;
      doneCount++;
      sendProgress(index, 'success', item.name, doneCount);
    } else {
      throw new Error(result.error || 'Generation failed');
    }

  } catch(err) {
    item.error = err.message;
    sendProgress(index, 'error', item.name, doneCount, err.message);
    notifyTelegram(`❌ Error on image ${index + 1}: ${item.name}\n${err.message}`);
  }

  currentIndex++;
  await saveState();

  if (!batchStopped) {
    if (currentIndex < batchQueue.length) {
      await sleep((batchConfig.delay ?? 10) * 1000);
      await processNext();
    } else {
      onBatchComplete();
    }
  }
}

// ══════════════════════════════════════════════════════
//  SEND TASK TO PERSISTENT TAB
// ══════════════════════════════════════════════════════
function sendTaskToTab(tabId, task) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'RUN_TASK', task }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { success: false, error: 'No response from tab' });
      }
    });
  });
}

// ══════════════════════════════════════════════════════
//  PING-PONG
// ══════════════════════════════════════════════════════
function waitForContentReady(tabId, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error('Content script ready timeout'));
    }, timeout);

    function listener(msg, sender) {
      if (msg.type === 'CONTENT_READY' && sender.tab?.id === tabId) {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve();
      }
    }
    chrome.runtime.onMessage.addListener(listener);

    chrome.tabs.sendMessage(tabId, { type: 'PING' }, (res) => {
      if (!chrome.runtime.lastError && res?.ready) {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve();
      }
    });
  });
}

// ══════════════════════════════════════════════════════
//  TAB MANAGEMENT
// ══════════════════════════════════════════════════════
function openChatGPTTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: 'https://chatgpt.com/', active: false }, (tab) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(tab.id);
    });
  });
}

function closeChatTab() {
  if (chatTabId) {
    chrome.tabs.remove(chatTabId, () => { chrome.runtime.lastError; });
    chatTabId = null;
    saveState();
  }
}

// ══════════════════════════════════════════════════════
//  RETRY
// ══════════════════════════════════════════════════════
async function retryImage(index) {
  if (batchPaused || batchStopped) return;
  if (!batchQueue[index]) return;

  if (!chatTabId) {
    chatTabId = await openChatGPTTab();
    try {
      await waitForContentReady(chatTabId, 25000);
    } catch(e) {
      closeChatTab();
      sendProgress(index, 'error', batchQueue[index].name, doneCount, 'ChatGPT tab failed to load');
      return;
    }
  }

  batchQueue[index].done  = false;
  batchQueue[index].error = null;
  await processImage(batchQueue[index], index);
}

// ══════════════════════════════════════════════════════
//  DOWNLOAD — base64 blob, no URL expire
// ══════════════════════════════════════════════════════
function saveBase64Image(base64, filename, batchId) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url:            base64,
      filename:       `GPT-Batch/${batchId}/${filename}`,
      saveAs:         false,
      conflictAction: 'overwrite'
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        waitForDownloadComplete(downloadId).then(resolve).catch(reject);
      }
    });
  });
}

function waitForDownloadComplete(downloadId, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      reject(new Error('Download timeout'));
    }, timeout);

    function listener(delta) {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(listener);
        resolve();
      }
      if (delta.state?.current === 'interrupted') {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(listener);
        reject(new Error(`Download interrupted: ${delta.error?.current || 'unknown'}`));
      }
    }
    chrome.downloads.onChanged.addListener(listener);
  });
}

function buildFilename(index, originalName) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const num  = String(index + 1).padStart(3, '0');
  const stem = originalName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
  return `batch_${date}_${num}_${stem}.png`;
}

// ══════════════════════════════════════════════════════
//  PROMPT BUILD
// ══════════════════════════════════════════════════════
function buildPrompt() {
  let p = batchConfig.prompt;
  if (batchConfig.quality === 'hd') p += ' Use maximum quality and 2K resolution.';
  if (batchConfig.ratio !== 'auto') p += ` Output aspect ratio: ${batchConfig.ratio}.`;
  return p;
}

// ══════════════════════════════════════════════════════
//  TELEGRAM
// ══════════════════════════════════════════════════════
async function notifyTelegram(text) {
  if (!batchConfig.tg?.token || !batchConfig.tg?.chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${batchConfig.tg.token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: batchConfig.tg.chatId, text })
    });
  } catch {}
}

function onBatchComplete() {
  const total  = batchQueue.length;
  const errors = batchQueue.filter(i => !i.done).length;
  notifyTelegram(`🎉 Batch complete!\n✅ Success: ${total - errors}/${total}\n❌ Failed: ${errors}`);
  closeChatTab();
  chrome.runtime.sendMessage({ type: 'BATCH_DONE', total, errors });
}

// ══════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════
function sendProgress(index, status, name, done, errorMsg) {
  chrome.runtime.sendMessage({
    type: 'BATCH_PROGRESS',
    index, status,
    filename: name,
    total:    batchQueue.length,
    done:     done ?? doneCount,
    errorMsg: errorMsg || null
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
