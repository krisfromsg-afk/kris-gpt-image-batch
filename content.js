// content.js — Runs inside ChatGPT tab

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'RUN_TASK') {
    runTask(msg.task).then(sendResponse);
    return true; // keep channel open for async
  }
});

// ══════════════════════════════════════════════════════
//  MAIN TASK
// ══════════════════════════════════════════════════════
async function runTask(task) {
  try {
    // 1. Upload image
    await uploadImage(task.imageData);
    await sleep(1500);

    // 2. Type prompt
    await typePrompt(task.prompt);
    await sleep(800);

    // 3. Send
    await clickSend();

    // 4. Wait for image output (max 3 min)
    const imageUrl = await waitForGeneratedImage(180000);
    return { success: true, imageUrl };

  } catch(err) {
    return { success: false, error: err.message };
  }
}

// ══════════════════════════════════════════════════════
//  UPLOAD IMAGE
// ══════════════════════════════════════════════════════
async function uploadImage(base64Data) {
  // Convert base64 to Blob
  const blob = base64ToBlob(base64Data);
  const file = new File([blob], 'image.png', { type: 'image/png' });

  // Find file input
  const fileInput = await waitForElement('input[type="file"]', 8000);
  if (!fileInput) throw new Error('File input not found');

  // Dispatch file
  const dt = new DataTransfer();
  dt.items.add(file);
  fileInput.files = dt.files;
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));

  // Wait for upload indicator to go away
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

  // Clear existing content
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);

  // Insert text
  document.execCommand('insertText', false, prompt);

  editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: prompt }));
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
//  WAIT FOR GENERATED IMAGE
// ══════════════════════════════════════════════════════
async function waitForGeneratedImage(timeout = 180000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    await sleep(2000);

    // Check for rate limit message
    const bodyText = document.body.innerText;
    if (bodyText.includes("You've reached") || bodyText.includes('rate limit') || bodyText.includes('too many')) {
      throw new Error('RATE_LIMIT');
    }

    // Look for generated image in assistant message
    const imgs = document.querySelectorAll(
      '[data-message-author-role="assistant"] img[src*="oaiusercontent"], ' +
      '[data-message-author-role="assistant"] img[src*="files.oaiusercontent"]'
    );

    if (imgs.length > 0) {
      const lastImg = imgs[imgs.length - 1];
      const src = lastImg.src || lastImg.getAttribute('src');
      if (src && src.startsWith('http')) {
        return src;
      }
    }

    // Check if still generating (look for streaming indicator)
    const isStreaming = document.querySelector(
      '[data-testid="stop-button"], .streaming-indicator'
    );
    if (!isStreaming && Date.now() - start > 30000) {
      // Check for error
      const errEl = document.querySelector('[data-testid="error-message"]');
      if (errEl) throw new Error(errEl.textContent || 'Generation error');
    }
  }

  throw new Error('Timeout: image generation took too long');
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
