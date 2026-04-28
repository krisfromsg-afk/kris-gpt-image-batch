// background.js — Service Worker

let batchQueue    = [];
let batchConfig   = {};
let batchPaused   = false;
let batchStopped  = false;
let chatTabId     = null;
let currentIndex  = 0;
let doneCount     = 0;
let lastDownloadId = null; // used to open the output folder when batch finishes

// ── Open side panel on icon click ──────────────────────
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ── Persist state to chrome.storage.session (survives SW idle unload) ──
// Only lightweight metadata is saved — never base64 blobs, which can blow
// past the 10 MB session-storage quota and silently kill the batch.
async function saveState() {
  try {
    const lightQueue = batchQueue.map(({ name, prompt, done, error }) => ({ name, prompt, done, error }));
    const lightConfig = {
      mode: batchConfig.mode, prompt: batchConfig.prompt,
      quality: batchConfig.quality, ratio: batchConfig.ratio,
      delay: batchConfig.delay, batchId: batchConfig.batchId,
      tg: batchConfig.tg
    };
    await chrome.storage.session.set({
      batchQueue: lightQueue, batchConfig: lightConfig,
      batchPaused, batchStopped, chatTabId, currentIndex, doneCount
    });
  } catch { /* storage failure must never stop the batch */ }
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

  if (msg.type === 'START_BATCH')       startBatch(msg.payload);
  if (msg.type === 'PAUSE_BATCH')       { batchPaused = true;  saveState(); }
  if (msg.type === 'RESUME_BATCH')      { batchPaused = false; saveState(); processNext(); }
  if (msg.type === 'STOP_BATCH')        { batchStopped = true; saveState(); closeChatTab(); }
  if (msg.type === 'RETRY_IMAGE')       retryImage(msg.index);
  if (msg.type === 'RETRY_ALL_FAILED')  retryAllFailed();
  if (msg.type === 'OPEN_DOWNLOAD_FOLDER') {
    if (lastDownloadId) chrome.downloads.show(lastDownloadId);
  }
});

// ══════════════════════════════════════════════════════
//  START BATCH — open ONE tab, reuse for all images
// ══════════════════════════════════════════════════════
async function startBatch(payload) {
  batchQueue    = payload.images;
  batchConfig   = payload;
  batchPaused   = false;
  batchStopped  = false;
  currentIndex  = 0;
  doneCount     = 0;
  lastDownloadId = null;
  await saveState();

  chatTabId = await openChatGPTTab();

  try {
    await waitForContentReady(chatTabId, 25000);
  } catch(e) {
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
//  PROCESS ONE IMAGE  (with reconnect + rate-limit retry + heartbeat)
// ══════════════════════════════════════════════════════
async function processImage(item, index) {
  const MAX_RL_RETRIES = 3;
  const RL_WAIT_MS     = 65000;

  // Verify content script is alive before starting; wait if page is reloading
  try {
    await waitForContentReady(chatTabId, 25000);
  } catch {
    item.error = 'ChatGPT content script reconnect failed';
    sendProgress(index, 'error', item.name, doneCount, item.error);
    currentIndex++;
    await saveState();
    if (!batchStopped && currentIndex < batchQueue.length) await processNext();
    else if (!batchStopped) onBatchComplete();
    return;
  }

  for (let rlRetry = 0; ; rlRetry++) {
    sendProgress(index, 'processing', item.name);

    // Heartbeat: keep UI alive while ChatGPT generates (up to ~3 min)
    let heartbeatSecs = 0;
    const heartbeatId = setInterval(() => {
      heartbeatSecs += 5;
      sendProgress(index, 'processing', item.name, doneCount, null, heartbeatSecs);
    }, 5000);

    let result;
    try {
      const imageData = batchConfig.mode === 'reference'
        ? batchConfig.refImages
        : item.data;

      result = await sendTaskToTab(chatTabId, {
        imageData,
        prompt:  buildPrompt(item.prompt),
        quality: batchConfig.quality,
        ratio:   batchConfig.ratio,
        index
      });
    } finally {
      clearInterval(heartbeatId);
    }

    // Rate-limit: wait 65 s then retry automatically
    if (!result.success && result.error === 'RATE_LIMIT') {
      if (rlRetry < MAX_RL_RETRIES) {
        notifyTelegram(`⏸ Rate limit (attempt ${rlRetry + 1}/${MAX_RL_RETRIES}) — waiting 65s...`);
        const waitUntil = Date.now() + RL_WAIT_MS;
        while (Date.now() < waitUntil) {
          const remaining = Math.ceil((waitUntil - Date.now()) / 1000);
          sendProgress(index, 'rate_limit', item.name, doneCount, `Retrying in ${remaining}s`);
          await sleep(Math.min(5000, waitUntil - Date.now()));
        }
        continue;
      }
      result = { success: false, error: 'Rate limit: max retries reached' };
    }

    // Success / error
    try {
      if (result.success) {
        if (!result.imageBase64 || !result.imageBase64.startsWith('data:image/')) {
          throw new Error('Response is not a valid image (ChatGPT may have returned text only)');
        }
        const filename = buildFilename(index, item.name);
        await saveBase64Image(result.imageBase64, filename, batchConfig.batchId);
        item.done = true;
        doneCount++;
        sendProgress(index, 'success', item.name, doneCount, null, null, result.imageBase64);
      } else {
        throw new Error(result.error || 'Generation failed');
      }
    } catch(err) {
      item.error = err.message;
      sendProgress(index, 'error', item.name, doneCount, err.message);
      notifyTelegram(`❌ Error on image ${index + 1}: ${item.name}\n${err.message}`);
    }
    break;
  }

  currentIndex++;
  await saveState();

  if (!batchStopped) {
    if (currentIndex < batchQueue.length) {
      // Countdown: tick every second, respects pause and stop
      let remaining = (batchConfig.delay ?? 10);
      while (remaining > 0 && !batchStopped && !batchPaused) {
        chrome.runtime.sendMessage({ type: 'BATCH_COUNTDOWN', seconds: remaining });
        await sleep(1000);
        remaining--;
      }
      chrome.runtime.sendMessage({ type: 'BATCH_COUNTDOWN', seconds: 0 });
      if (!batchStopped && !batchPaused) await processNext();
    } else {
      onBatchComplete();
    }
  }
}

// ══════════════════════════════════════════════════════
//  RETRY ALL FAILED — re-runs every errored item
// ══════════════════════════════════════════════════════
async function retryAllFailed() {
  const failedItems = batchQueue
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => !item.done);

  if (!failedItems.length) return;

  batchStopped = false;
  batchPaused  = false;
  doneCount    = batchQueue.filter(i => i.done).length;

  if (!chatTabId) {
    chatTabId = await openChatGPTTab();
    try {
      await waitForContentReady(chatTabId, 25000);
    } catch {
      closeChatTab();
      chrome.runtime.sendMessage({ type: 'BATCH_ERROR', error: 'ChatGPT tab failed to load for retry' });
      return;
    }
  }

  for (const { item, i } of failedItems) {
    if (batchStopped) break;
    item.done  = false;
    item.error = null;
    currentIndex = i;
    await processImage(item, i);
  }

  onBatchComplete();
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
//  PING-PONG / CONTENT READY
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
//  RETRY SINGLE IMAGE
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
        lastDownloadId = downloadId;
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
function buildPrompt(perItemPrompt) {
  let p = perItemPrompt || batchConfig.prompt;
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
  chrome.runtime.sendMessage({
    type: 'BATCH_DONE', total, errors,
    batchId: batchConfig.batchId,
    lastDownloadId
  });
}

// ══════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════
function sendProgress(index, status, name, done, errorMsg, elapsed, imageBase64) {
  chrome.runtime.sendMessage({
    type: 'BATCH_PROGRESS',
    index, status,
    filename: name,
    total:    batchQueue.length,
    done:     done ?? doneCount,
    errorMsg: errorMsg || null,
    elapsed:  elapsed ?? null,
    imageBase64: imageBase64 || null
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
