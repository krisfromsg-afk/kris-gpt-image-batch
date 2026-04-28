// content.js — Runs inside ChatGPT tab (persistent, single tab)

let isReady      = false;
let messageCount = 0;

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
  if (msg.type === 'PING') { sendResponse({ ready: isReady }); return true; }
  if (msg.type === 'RUN_TASK') { runTask(msg.task).then(sendResponse); return true; }
});

// ══════════════════════════════════════════════════════
//  MAIN TASK
// ══════════════════════════════════════════════════════
async function runTask(task) {
  try {
    messageCount = countAssistantMessages();

    await uploadImage(task.imageData);
    await sleep(1500);

    await typePrompt(task.prompt);
    await sleep(500);

    await clickSend();

    // Wait for ChatGPT to finish — anchored on send-button state, not URL patterns.
    // The button goes disabled when ChatGPT starts and re-enables when it finishes.
    // This works regardless of how ChatGPT serves the generated image.
    await waitForGenerationComplete(360000);
    await sleep(800); // let DOM fully settle after completion

    // Scan the new message(s) for the generated image
    const imageUrl    = await scanForNewImage(messageCount, 8000);
    const imageBase64 = await fetchImageAsBase64(imageUrl);

    return { success: true, imageBase64 };
  } catch(err) {
    return { success: false, error: err.message };
  }
}

// ══════════════════════════════════════════════════════
//  UPLOAD IMAGE
// ══════════════════════════════════════════════════════
async function uploadImage(base64DataOrArray) {
  const dataArray = Array.isArray(base64DataOrArray) ? base64DataOrArray : [base64DataOrArray];
  const files = dataArray.map((b64, i) => {
    const blob = base64ToBlob(b64);
    return new File([blob], `image_${i + 1}.png`, { type: 'image/png' });
  });

  const fileInputs = document.querySelectorAll('input[type="file"]');
  const fileInput  = fileInputs[fileInputs.length - 1];
  if (!fileInput) throw new Error('File input not found');

  const dt = new DataTransfer();
  files.forEach(f => dt.items.add(f));
  fileInput.files = dt.files;
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));

  await sleep(1500 + files.length * 800);
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

  // Primary: execCommand('insertText') — triggers React synthetic events
  document.execCommand('selectAll', false, null);
  const ok = document.execCommand('insertText', false, prompt);

  if (!ok) {
    try {
      await navigator.clipboard.writeText(prompt);
      document.execCommand('selectAll', false, null);
      document.execCommand('paste');
    } catch {
      editor.textContent = '';
      editor.focus();
      document.execCommand('insertText', false, prompt);
    }
  }

  const inserted = editor.textContent || editor.innerText || '';
  if (!inserted.trim()) {
    editor.textContent = prompt;
    editor.dispatchEvent(new InputEvent('input', {
      bubbles: true, inputType: 'insertText', data: prompt
    }));
  }
}

// ══════════════════════════════════════════════════════
//  CLICK SEND
// ══════════════════════════════════════════════════════
async function clickSend() {
  const btn = await waitForElement(
    'button[data-testid="send-button"]:not([disabled])',
    10000
  );
  if (!btn) throw new Error('Send button not found or still disabled');
  btn.click();
}

// ══════════════════════════════════════════════════════
//  WAIT FOR GENERATION COMPLETE
//  Watches the send button: disabled → enabled transition.
//  This is independent of image URL patterns — ChatGPT always
//  re-enables the button when it finishes, no matter what.
// ══════════════════════════════════════════════════════
function waitForGenerationComplete(timeout = 360000) {
  return new Promise((resolve, reject) => {
    const checkRateLimit = () => {
      const selectors = ['[data-testid="rate-limit-message"]', '.text-red-500', '.text-orange-500'];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const t = el.innerText || '';
        if (t.includes("You've reached") || t.includes('rate limit') || t.includes('too many')) return true;
      }
      return false;
    };

    const timer = setTimeout(() => {
      obs.disconnect();
      reject(new Error('Timeout: image generation took too long'));
    }, timeout);

    // Track the disabled → enabled transition so we don't fire too early
    let wentDisabled = false;

    const obs = new MutationObserver(() => {
      if (checkRateLimit()) {
        obs.disconnect(); clearTimeout(timer);
        return reject(new Error('RATE_LIMIT'));
      }

      const btn = document.querySelector('button[data-testid="send-button"]');
      if (!btn) return;

      if (!wentDisabled && btn.disabled) {
        wentDisabled = true; // confirmed: request is in-flight
        return;
      }

      if (wentDisabled && !btn.disabled) {
        obs.disconnect(); clearTimeout(timer);
        resolve(); // ChatGPT finished
      }
    });

    obs.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['disabled', 'class', 'aria-disabled']
    });

    // Edge case: button already disabled at observation start (very fast re-render)
    const initial = document.querySelector('button[data-testid="send-button"]');
    if (initial?.disabled) wentDisabled = true;
  });
}

// ══════════════════════════════════════════════════════
//  SCAN FOR NEW IMAGE
//  Polls every 300 ms for up to `timeout` ms.
//  Uses 4-layer fallback — works regardless of CDN or rendering method.
// ══════════════════════════════════════════════════════
async function scanForNewImage(prevMessageCount, timeout = 8000) {
  const SKIP = ['/assets/', 'avatar', 'emoji', 'icon', 'logo', '.svg', 'favicon'];

  const find = () => {
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    for (let i = prevMessageCount; i < msgs.length; i++) {
      const msg = msgs[i];

      // 1. Known ChatGPT CDN domains
      for (const img of msg.querySelectorAll(
        'img[src*="oaiusercontent"], img[src*="blob.core.windows.net"], img[src*="oaistatic.com/file"]'
      )) {
        if (img.src?.startsWith('http')) return img.src;
      }

      // 2. Any https img — skip known UI elements, keep long URLs (generated images have long tokens)
      for (const img of Array.from(msg.querySelectorAll('img[src^="https://"]')).reverse()) {
        if (SKIP.some(p => img.src.includes(p))) continue;
        if (img.src.length > 80) return img.src;
      }

      // 3. Canvas (some ChatGPT builds render to canvas)
      for (const canvas of msg.querySelectorAll('canvas')) {
        if (canvas.width > 200 && canvas.height > 200) {
          try { return canvas.toDataURL('image/png'); } catch {}
        }
      }

      // 4. CSS background-image
      for (const el of msg.querySelectorAll('[style*="background-image"]')) {
        const match = el.style.backgroundImage.match(/url\(["']?(https?:[^"')]+)/);
        if (match && match[1].length > 80) return match[1];
      }
    }
    return null;
  };

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const url = find();
    if (url) return url;
    await sleep(300);
  }

  throw new Error('Image not found in ChatGPT response after generation');
}

// ══════════════════════════════════════════════════════
//  FETCH IMAGE AS BASE64
// ══════════════════════════════════════════════════════
async function fetchImageAsBase64(url) {
  if (url.startsWith('data:')) return url; // canvas.toDataURL() result
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const blob = await res.blob();
  return blobToBase64(blob);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

// ══════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════
function countAssistantMessages() {
  return document.querySelectorAll('[data-message-author-role="assistant"]').length;
}

function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const obs = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) { obs.disconnect(); resolve(found); }
    });

    obs.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['disabled', 'class', 'aria-disabled']
    });

    setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
  });
}

function base64ToBlob(base64) {
  const parts = base64.split(';base64,');
  if (parts.length < 2) throw new Error('Invalid base64 data');
  const mime = parts[0].split(':')[1];
  const raw  = atob(parts[1]);
  const arr  = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
