// background.js — Service Worker

let batchQueue    = [];
let batchConfig   = {};
let batchPaused   = false;
let batchStopped  = false;
let activeTabId   = null;
let currentIndex  = 0;
let doneCount     = 0;

// ── Message handler ────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_BATCH')  startBatch(msg.payload);
  if (msg.type === 'PAUSE_BATCH')  batchPaused = true;
  if (msg.type === 'RESUME_BATCH') { batchPaused = false; processNext(); }
  if (msg.type === 'STOP_BATCH')   { batchStopped = true; closeActiveTab(); }
  if (msg.type === 'RETRY_IMAGE')  retryImage(msg.index);
});

// ══════════════════════════════════════════════════════
//  START BATCH
// ══════════════════════════════════════════════════════
async function startBatch(payload) {
  batchQueue   = payload.images;
  batchConfig  = payload;
  batchPaused  = false;
  batchStopped = false;
  currentIndex = 0;
  doneCount    = 0;

  await processNext();
}

async function processNext() {
  if (batchStopped) return;
  if (batchPaused)  return;
  if (currentIndex >= batchQueue.length) {
    onBatchComplete();
    return;
  }

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
    // 1. Open new ChatGPT tab
    const tab = await createChatGPTTab();
    activeTabId = tab.id;

    // 2. Wait for page ready
    await waitForTabLoad(tab.id, 12000);

    // 3. Inject content script task
    const result = await injectTask(tab.id, {
      imageData: item.data,
      prompt:    buildPrompt(),
      quality:   batchConfig.quality,
      ratio:     batchConfig.ratio
    });

    if (result.success) {
      // 4. Download image
      const filename = buildFilename(index);
      await downloadImage(result.imageUrl, filename, batchConfig.batchId);

      item.done = true;
      doneCount++;
      sendProgress(index, 'success', item.name, doneCount);
    } else {
      throw new Error(result.error || 'Generation failed');
    }

  } catch(err) {
    sendProgress(index, 'error', item.name, doneCount);
    notifyTelegram(`❌ Error on image ${index+1}: ${item.name}\n${err.message}`);
  } finally {
    closeActiveTab();
    activeTabId = null;
    currentIndex++;

    if (!batchStopped) {
      if (currentIndex < batchQueue.length) {
        await sleep(batchConfig.delay * 1000);
        await processNext();
      } else {
        onBatchComplete();
      }
    }
  }
}

// ══════════════════════════════════════════════════════
//  INJECT TASK INTO CONTENT SCRIPT
// ══════════════════════════════════════════════════════
async function injectTask(tabId, task) {
  return new Promise((resolve) => {
    // Wait a bit for ChatGPT UI to settle
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, { type: 'RUN_TASK', task }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { success: false, error: 'No response from tab' });
        }
      });
    }, 3000);
  });
}

// ══════════════════════════════════════════════════════
//  TAB MANAGEMENT
// ══════════════════════════════════════════════════════
function createChatGPTTab() {
  return new Promise(resolve => {
    chrome.tabs.create({ url: 'https://chatgpt.com/', active: false }, tab => resolve(tab));
  });
}

function waitForTabLoad(tabId, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Tab load timeout')), timeout);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 2000); // extra 2s for JS to load
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function closeActiveTab() {
  if (activeTabId) {
    chrome.tabs.remove(activeTabId, () => {});
    activeTabId = null;
  }
}

// ══════════════════════════════════════════════════════
//  RETRY
// ══════════════════════════════════════════════════════
async function retryImage(index) {
  if (batchQueue[index]) {
    batchQueue[index].done = false;
    const item = batchQueue[index];
    await processImage(item, index);
  }
}

// ══════════════════════════════════════════════════════
//  DOWNLOAD
// ══════════════════════════════════════════════════════
function downloadImage(url, filename, batchId) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url,
      filename: `GPT-Batch/${batchId}/${filename}`,
      saveAs: false,
      conflictAction: 'overwrite'
    }, (downloadId) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(downloadId);
    });
  });
}

function buildFilename(index) {
  const date  = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const num   = String(index + 1).padStart(3, '0');
  return `batch_${date}_${num}.png`;
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
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: batchConfig.tg.chatId, text })
    });
  } catch {}
}

function onBatchComplete() {
  const total  = batchQueue.length;
  const errors = batchQueue.filter(i => !i.done).length;
  notifyTelegram(
    `🎉 Batch complete!\n✅ Success: ${total - errors}/${total}\n❌ Failed: ${errors}`
  );
  chrome.runtime.sendMessage({ type: 'BATCH_DONE' });
}

// ══════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════
function sendProgress(index, status, name, done) {
  chrome.runtime.sendMessage({
    type: 'BATCH_PROGRESS',
    index, status, filename: name,
    total: batchQueue.length,
    done: done ?? doneCount
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
