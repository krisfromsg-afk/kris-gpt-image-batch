# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**GPT Image Batch Pro** is a Chrome Extension (Manifest V3) that automates batch image processing through ChatGPT's `gpt-image-2` model. It opens a single background ChatGPT tab, uploads images one by one via DOM automation, waits for generated results, and downloads them as base64 PNGs.

The extension source lives inside `gpt-image-batch-production.zip`. Extract it before making changes:

```bash
unzip gpt-image-batch-production.zip
```

There is no build toolchain — the extension is plain vanilla JavaScript with no npm, no bundler, and no transpilation step.

## Loading for Development

1. Extract the zip to get the `gpt-image-batch-production/` folder
2. Open Chrome → `chrome://extensions`
3. Enable **Developer Mode** (top right)
4. Click **Load unpacked** → select the extracted folder
5. After any file change, click **Reload** on the extension card

## Architecture

The extension has four active components that communicate via `chrome.runtime.sendMessage`:

```
popup.js ←──────────────────────────── background.js (service worker)
    │  START/PAUSE/RESUME/STOP/RETRY →      │
    │  ← BATCH_PROGRESS/BATCH_DONE/ERROR    │
    │                                        │ RUN_TASK →
    │                                   content.js (injected into chatgpt.com)
    │                                        │ ← CONTENT_READY / PING response
```

### `background.js` — Service Worker
Owns the entire batch state (`batchQueue`, `currentIndex`, `doneCount`, `chatTabId`). Opens **one** ChatGPT tab (`active: false`) and reuses it for all images in a run. State is persisted to `chrome.storage.session` so it survives the service worker being killed by Chrome's idle timer. On each image: sends a `RUN_TASK` message to the content script, waits for a result, validates the base64 response, and calls `chrome.downloads.download()` to save it.

### `content.js` — ChatGPT Tab Automation
Injected into `chatgpt.com`. On each `RUN_TASK`:
1. Snapshots the current assistant message count (to ignore prior images in the chat)
2. Uploads the image by injecting into `<input type="file">`
3. Types the prompt via clipboard API (falls back to `textContent` + `InputEvent`)
4. Clicks the send button
5. Uses a `MutationObserver` to detect a **new** assistant message containing an `oaiusercontent` image URL
6. Fetches the image as base64 **immediately** (before the signed URL expires) using `fetch` with `credentials: 'include'`

### `popup.js` — Extension Popup UI
Two screens: **license** (validates against `CONFIG.LICENSE_SERVER`, stores result in `chrome.storage.local`) and **main** (file picker, prompt, settings, progress). Converts selected `File` objects to base64 before sending to the background worker. Listens for `BATCH_PROGRESS` and `BATCH_DONE` messages to update the UI.

### `config.js` — Build Config
Single source of truth for environment flags. Must be updated before shipping:

| Key | Dev value | Production value |
|-----|-----------|-----------------|
| `DEV_MODE` | `true` | `false` |
| `LICENSE_SERVER` | placeholder URL | real verify endpoint |
| `GET_KEY_URL` | placeholder URL | real purchase link |

`DEV_MODE: true` bypasses the license server — any key activates the extension when the server is unreachable.

## Key Conventions

- **Message types** are SCREAMING_SNAKE_CASE strings (`START_BATCH`, `RUN_TASK`, `BATCH_PROGRESS`, etc.). All inter-component communication goes through `chrome.runtime.onMessage`.
- **Base64 everywhere**: images travel as `data:image/png;base64,...` strings between popup → background → content → background → `chrome.downloads`.
- **Single tab reuse**: the background worker keeps `chatTabId` for the lifetime of a batch. A new tab is only opened on the first `START_BATCH` or a `RETRY_IMAGE` when no tab exists.
- **Session state persistence**: `saveState()` / `loadState()` in `background.js` use `chrome.storage.session` to survive SW idle unloads. Call `saveState()` after any mutation to batch state.
- **Message count guard** (`messageCount` in `content.js`): snapshot `countAssistantMessages()` before sending each image so `waitForNewGeneratedImage` only resolves on messages that appear **after** this task's send.
- **Delay between images** is configurable (5–60 s, default 10 s) to avoid hitting ChatGPT rate limits.
- Output files are saved to `GPT-Batch/<batchId>/batch_<YYYYMMDD>_<NNN>_<stem>.png` via `chrome.downloads`.

## Production Build Checklist

Before zipping for Chrome Web Store submission:

- [ ] Set `DEV_MODE: false` in `config.js`
- [ ] Set `LICENSE_SERVER` to real verify endpoint in `config.js`
- [ ] Set `GET_KEY_URL` to real purchase link in `config.js`
- [ ] Add `icons/icon48.png` and `icons/icon128.png`
- [ ] Re-zip the folder and test the full flow end-to-end

## License Server Integration

The license verification endpoint receives `POST { key: string }` and must return `{ valid: boolean, message?: string }`. Compatible out of the box with Gumroad and Lemon Squeezy license APIs, or a self-hosted server (e.g. Railway + Supabase).
