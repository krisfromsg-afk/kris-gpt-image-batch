// content.js — Runs inside ChatGPT tab (persistent, single tab)
// v2: tracks message count to detect NEW images only, returns base64 blob

let isReady       = false;
let messageCount  = 0;   // how many assistant messages existed BEFORE this task

// ── Boot: wait for ChatGPT UI, then signal ready ──────
async function waitForChatGPTUI() {
  await waitForElement(
    '[contenteditable="true"][data-testid="prompt-textarea"], #prompt-textarea',
    20000
  );
  isReady = true;
  chrome.runtime.sendMessage({ type: 'CONTENT_READY' });
}
waitForChatGPTUI();

// ── Message handler — only accept messages from this extension ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;

  if (msg.type === 'PING') {
    sendResponse({ ready: isReady });
    return true;
  }
  if (msg.type === 'RUN_TASK') {
    runTask(msg.task).then(sendResponse);
    return true;
  }
});

// ══════════════════════════════════════════════════════
//  MAIN TASK
// ══════════════════════════════════════════════════════
async function runTask(task) {
  try {
    // Snapshot how many assistant messages exist RIGHT NOW
    // so we only watch for NEW ones after sending
    messageCount = countAssistantMessages();

    // 1. Upload image
    await uploadImage(task.imageData);
    await sleep(1500);

    // 2. Type prompt
    await typePrompt(task.prompt);
    await sleep(600);

    // 3. Send
    await clickSend();

    // 4. Wait for NEW generated image (ignores previous images in chat)
    const imageUrl = await waitForNewGeneratedImage(messageCount, 180000);

    // 5. Fetch as blob IMMEDIATELY while still in tab (no URL expire)
    const imageBase64 = await fetchImageAsBase64(imageUrl);

    return { success: true, imageBase64 };

  } catch(err) {
    return { success: false, error: err.message };
  }
}

// ══════════════════════════════════════════════════════
//  UPLOAD IMAGE
// ══════════════════════════════════════════════════════
async function uploadImage(base64Data) {
  const blob = base64ToBlob(base64Data);
  const file = new File([blob], 'image.png', { type: 'image/png' });

  const fileInput = await waitForElement('input[type="file"]', 8000);
  if (!fileInput) throw new Error('File input not found');

  const dt = new DataTransfer();
  dt.items.add(file);
  fileInput.files = dt.files;
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));

  await sleep(2000);
}

// ══════════════════════════════════════════════════════
//  TYPE PROMPT
// ══════════════════════════════════════════════════════
async function typePrompt(prompt) {
  const editor = await waitForElement(
    '[contenteditable="true"][data-testid="prompt-textarea"], #prompt-textarea',
    8000
  );
  if (!editor) throw new Error('Prompt editor not found');

  editor.focus();
  await sleep(300);

  // Clear
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('delete', false, null);

  // Insert via clipboard API, fallback to textContent
  try {
    await navigator.clipboard.writeText(prompt);
    document.execCommand('paste');
  } catch {
    editor.textContent = '';
    editor.appendChild(document.createTextNode(prompt));
    editor.dispatchEvent(new InputEvent('input', {
      bubbles: true, data: prompt, inputType: 'insertText'
    }));
  }
}

// ══════════════════════════════════════════════════════
//  CLICK SEND
// ══════════════════════════════════════════════════════
async function clickSend() {
  const btn = await waitForElement(
    'button[data-testid="send-button"]:not(:disabled)',
    5000
  );
  if (!btn) throw new Error('Send button not found or disabled');
  btn.click();
}

// ══════════════════════════════════════════════════════
//  WAIT FOR NEW IMAGE ONLY (skips images from previous turns)
// ══════════════════════════════════════════════════════
function countAssistantMessages() {
  return document.querySelectorAll('[data-message-author-role="assistant"]').length;
}

function waitForNewGeneratedImage(prevMessageCount, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const checkRateLimit = () => {
      // Only check ChatGPT's error/notice elements, not entire page text
      // Avoids false positives if user's prompt contains these keywords
      const errorSelectors = [
        '[data-testid="rate-limit-message"]',
        '.text-red-500',
        '.text-orange-500',
      ];
      for (const sel of errorSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const t = el.innerText || '';
          if (t.includes("You've reached") || t.includes('rate limit') || t.includes('too many')) {
            return true;
          }
        }
      }
      return false;
    };

    // Only look at assistant messages that appeared AFTER we sent
    const findNewImage = () => {
      const allMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
      // Only check messages newer than prevMessageCount
      for (let i = prevMessageCount; i < allMessages.length; i++) {
        const imgs = allMessages[i].querySelectorAll(
          'img[src*="oaiusercontent"], img[src*="files.oaiusercontent"]'
        );
        if (imgs.length > 0) {
          const src = imgs[imgs.length - 1].src;
          if (src?.startsWith('http')) return src;
        }
      }
      return null;
    };

    const immediate = findNewImage();
    if (immediate) return resolve(immediate);

    const obs = new MutationObserver(() => {
      if (checkRateLimit()) {
        obs.disconnect();
        return reject(new Error('RATE_LIMIT'));
      }
      const url = findNewImage();
      if (url) {
        obs.disconnect();
        resolve(url);
      }
    });

    obs.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['src']
    });

    setTimeout(() => {
      obs.disconnect();
      reject(new Error('Timeout: image generation took too long'));
    }, timeout);
  });
}

// ══════════════════════════════════════════════════════
//  FETCH IMAGE AS BASE64 (while still in tab — no expire)
// ══════════════════════════════════════════════════════
async function fetchImageAsBase64(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const blob = await res.blob();
  return blobToBase64(blob);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result); // "data:image/png;base64,..."
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

// ══════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const obs = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) { obs.disconnect(); resolve(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
  });
}

function base64ToBlob(base64) {
  const parts = base64.split(';base64,');
  const mime  = parts[0].split(':')[1];
  const raw   = atob(parts[1]);
  const arr   = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
