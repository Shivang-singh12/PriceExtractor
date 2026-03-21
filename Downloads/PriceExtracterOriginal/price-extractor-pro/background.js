// ═══════════════════════════════════════════════════════════════
//  Price Extractor Pro – background.js (Service Worker)
//  Handles: tab lifecycle, rate limiting, retry logic, job queue
// ═══════════════════════════════════════════════════════════════

const DYNAMIC_WAIT_MS  = 3000;   // wait after page load for JS to render
const TAB_TIMEOUT_MS   = 35000;  // max time to wait per tab
const MAX_RETRIES      = 3;
const RETRY_BACKOFF_MS = 2500;   // multiplied by attempt number

// pendingTabs: tabId → { resolve, reject, timeout, loaded }
const pendingTabs = new Map();
let jobRunning   = false;
let jobQueue     = [];   // { url, index }[]
let rateLimitMs  = 2000; // configurable

// ───────────────────────────────────────────────────────────────
//  Keep-alive (service workers die after ~30s idle in MV3)
// ───────────────────────────────────────────────────────────────
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => { /* heartbeat */ });

// ───────────────────────────────────────────────────────────────
//  Tab event listeners (MUST be top-level in MV3 service worker)
// ───────────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const pending = pendingTabs.get(tabId);
  if (!pending) return;

  // ── Redirect / short-URL detection ──────────────────────────
  // Short URLs (dl.flipkart.com, amzn.in) redirect to the real page.
  // Ignore the 'complete' event on the redirect domain and wait for
  // the next one (the actual product page).
  const finalUrl = tab.url || '';
  const isShortUrl = finalUrl.includes('dl.flipkart.com') ||
                     finalUrl.includes('amzn.in')         ||
                     finalUrl.includes('amzn.to');
  if (isShortUrl) return; // wait for redirect to resolve

  // Ignore duplicate complete events
  if (pending.loaded) return;
  pending.loaded = true;

  clearTimeout(pending.timeout);

  // Wait for dynamic content (React/SPA rendering)
  pending.timeout = setTimeout(async () => {
    try {
      const response = await sendMessageToTab(tabId, { action: 'extractPrice' });
      const p = pendingTabs.get(tabId);
      if (!p) return;
      pendingTabs.delete(tabId);
      safeCloseTab(tabId);

      if (response?.price) {
        p.resolve(response.price);
      } else {
        p.reject(new Error(response?.error || 'Price not found'));
      }
    } catch (e) {
      const p = pendingTabs.get(tabId);
      if (!p) return;
      pendingTabs.delete(tabId);
      safeCloseTab(tabId);
      p.reject(e);
    }
  }, DYNAMIC_WAIT_MS);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const pending = pendingTabs.get(tabId);
  if (!pending) return;
  pendingTabs.delete(tabId);
  clearTimeout(pending.timeout);
  pending.reject(new Error('Tab closed unexpectedly'));
});

// ───────────────────────────────────────────────────────────────
//  Message handler (from popup)
// ───────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'startJob') {
    rateLimitMs = msg.rateLimit ?? 2000;
    startJob(msg.urls).catch(console.error);
    sendResponse({ ok: true });
  } else if (msg.action === 'cancelJob') {
    cancelJob();
    sendResponse({ ok: true });
  } else if (msg.action === 'getProgress') {
    getStoredJob().then(sendResponse);
    return true; // async
  }
});

// ───────────────────────────────────────────────────────────────
//  Job Orchestration
// ───────────────────────────────────────────────────────────────
async function startJob(urls) {
  jobRunning = true;
  jobQueue   = urls.map((url, i) => ({ url: url.trim(), index: i }));

  await setJob({
    status  : 'running',
    total   : urls.length,
    current : 0,
    results : {}
  });

  await processQueue();
}

async function processQueue() {
  while (jobQueue.length > 0 && jobRunning) {
    const { url, index } = jobQueue.shift();

    // Update current pointer in storage
    await patchJob({ current: index, status: 'running' });

    let price = null;
    let error = null;

    // ── Retry loop ──────────────────────────────────────────
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        price = await extractFromUrl(url);
        error = null;
        break;
      } catch (e) {
        error = e.message;
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_BACKOFF_MS * attempt);
        }
      }
    }

    // Store result
    const stored = await getStoredJob();
    stored.results[index] = { price, error: price ? null : (error || 'Unknown error') };
    stored.current = index + 1;
    if (jobQueue.length === 0) stored.status = 'complete';
    await setJob(stored);

    // Rate limit between requests
    if (jobQueue.length > 0 && jobRunning) {
      await sleep(rateLimitMs);
    }
  }

  if (!jobRunning) {
    await patchJob({ status: 'cancelled' });
  }
}

// ───────────────────────────────────────────────────────────────
//  Per-URL Extraction (opens background tab)
// ───────────────────────────────────────────────────────────────
function extractFromUrl(url) {
  return new Promise(async (resolve, reject) => {
    // ── Validate URL ────────────────────────────────────────
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new Error('Invalid URL format'));
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return reject(new Error('URL must be http/https'));
    }

    const host = parsed.hostname;
    const supported = host.includes('amazon.in') || host.includes('flipkart.com');
    if (!supported) {
      return reject(new Error('Only amazon.in and flipkart.com supported'));
    }

    // ── Create background tab ────────────────────────────────
    let tab;
    try {
      tab = await chrome.tabs.create({ url, active: false });
    } catch (e) {
      return reject(new Error('Could not open tab: ' + e.message));
    }

    // ── Global timeout ───────────────────────────────────────
    const globalTimeout = setTimeout(async () => {
      pendingTabs.delete(tab.id);
      safeCloseTab(tab.id);
      reject(new Error('Page load timeout (35s)'));
    }, TAB_TIMEOUT_MS);

    pendingTabs.set(tab.id, {
      resolve: (price) => { clearTimeout(globalTimeout); resolve(price); },
      reject:  (err)   => { clearTimeout(globalTimeout); reject(err); },
      timeout: null,
      loaded:  false
    });
  });
}

// ───────────────────────────────────────────────────────────────
//  Cancel
// ───────────────────────────────────────────────────────────────
function cancelJob() {
  jobRunning = false;
  jobQueue   = [];

  for (const [tabId, pending] of pendingTabs) {
    clearTimeout(pending.timeout);
    safeCloseTab(tabId);
    pending.reject(new Error('Job cancelled'));
  }
  pendingTabs.clear();
}

// ───────────────────────────────────────────────────────────────
//  Helpers
// ───────────────────────────────────────────────────────────────
function sendMessageToTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

async function safeCloseTab(tabId) {
  try { await chrome.tabs.remove(tabId); } catch {}
}

async function getStoredJob() {
  const data = await chrome.storage.local.get('job');
  return data.job || { status: 'idle', total: 0, current: 0, results: {} };
}

async function setJob(job) {
  await chrome.storage.local.set({ job });
}

async function patchJob(patch) {
  const job = await getStoredJob();
  await setJob({ ...job, ...patch });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
