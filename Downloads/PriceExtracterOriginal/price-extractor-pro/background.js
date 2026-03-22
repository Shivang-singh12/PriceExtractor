// ═══════════════════════════════════════════════════════════════
//  Price Extractor Pro – background.js  v6
//  Changes from v5:
//  + saveStateSafe: syncState() is now try/catch protected
//  + Tab reuse: N tabs created once at job start, reused per worker
// ═══════════════════════════════════════════════════════════════

const DYNAMIC_WAIT_MS  = 3000;
const TAB_TIMEOUT_MS   = 35000;
const MAX_RETRIES      = 3;
const RETRY_BACKOFF_MS = 2500;

// pendingTabs: tabId → { resolve, reject, timeout, loaded }
const pendingTabs = new Map();

// ── Job state ─────────────────────────────────────────────────
let localState  = { status: 'idle', total: 0, completed: 0, active: 0, results: {} };
let jobRunning  = false;
let jobQueue    = [];
let rateLimitMs = 2000;
let concurrency = 1;

// ── Tab pool (NEW v6) ─────────────────────────────────────────
// tabPool[workerIndex] = tabId  — reused for entire job duration
const tabPool = [];

// ───────────────────────────────────────────────────────────────
//  Keep-alive
// ───────────────────────────────────────────────────────────────
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {});

// ───────────────────────────────────────────────────────────────
//  Tab event listeners (MUST be top-level in MV3)
// ───────────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const pending = pendingTabs.get(tabId);
  if (!pending) return;

  // Skip redirect / short-URL domains
  const url = tab.url || '';
  if (url.includes('dl.flipkart.com') || url.includes('amzn.in') || url.includes('amzn.to')) return;

  // Skip blank pages (pool tabs navigating away from about:blank)
  if (url === 'about:blank' || url === 'chrome://newtab/') return;

  if (pending.loaded) return;
  pending.loaded = true;
  clearTimeout(pending.timeout);

  // Wait DYNAMIC_WAIT_MS for React/JS to finish rendering
  pending.timeout = setTimeout(async () => {
    try {
      const response = await sendMessageToTab(tabId, { action: 'extractPrice' });
      const p = pendingTabs.get(tabId);
      if (!p) return;
      pendingTabs.delete(tabId);
      p.resolve(response || {});
    } catch (e) {
      const p = pendingTabs.get(tabId);
      if (!p) return;
      pendingTabs.delete(tabId);
      p.reject(e);
    }
    // NOTE: tab is NOT closed here — it stays in the pool for the next URL
  }, DYNAMIC_WAIT_MS);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const pending = pendingTabs.get(tabId);
  if (!pending) return;
  pendingTabs.delete(tabId);
  clearTimeout(pending.timeout);
  pending.reject(new Error('Tab closed unexpectedly'));

  // Remove from pool if it was a pool tab so workers can recreate it
  const poolIdx = tabPool.indexOf(tabId);
  if (poolIdx !== -1) tabPool[poolIdx] = null;
});

// ───────────────────────────────────────────────────────────────
//  Message handler
// ───────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'startJob') {
    rateLimitMs = msg.rateLimit   ?? 2000;
    concurrency = msg.concurrency ?? 1;
    startJob(msg.urls).catch(console.error);
    sendResponse({ ok: true });

  } else if (msg.action === 'cancelJob') {
    cancelJob();
    sendResponse({ ok: true });

  } else if (msg.action === 'getProgress') {
    sendResponse({ ...localState });
  }
});

// ───────────────────────────────────────────────────────────────
//  Job orchestration
// ───────────────────────────────────────────────────────────────
async function startJob(urls) {
  jobRunning = true;
  jobQueue   = urls.map((url, i) => ({ url: url.trim(), index: i }));

  localState = {
    status   : 'running',
    total    : urls.length,
    completed: 0,
    active   : 0,
    results  : {}
  };
  await syncState();

  // ── Create tab pool (NEW v6) ──────────────────────────────
  // Pre-create N blank background tabs once. Workers reuse them
  // for every URL instead of create/destroy on each request.
  tabPool.length = 0;
  for (let i = 0; i < concurrency; i++) {
    try {
      const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
      tabPool.push(tab.id);
    } catch (e) {
      tabPool.push(null); // null = will fall back to create on first use
    }
  }

  // Launch N workers
  const workers = Array.from({ length: concurrency }, (_, wid) => runWorker(wid));
  await Promise.all(workers);

  // Close all pool tabs when job finishes
  await drainTabPool();

  if (jobRunning) {
    localState.status = 'complete';
    localState.active = 0;
  } else {
    localState.status = 'cancelled';
    localState.active = 0;
  }
  await syncState();
}

// ───────────────────────────────────────────────────────────────
//  Single worker — owns one pool tab for its lifetime
// ───────────────────────────────────────────────────────────────
async function runWorker(workerId) {
  while (jobQueue.length > 0 && jobRunning) {
    const item = jobQueue.shift();
    if (!item) break;

    const { url, index } = item;

    localState.active++;
    await syncState();

    let data  = null;
    let error = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Pass workerId so extractFromUrl can reuse the right pool tab
        data  = await extractFromUrl(url, workerId);
        error = null;
        break;
      } catch (e) {
        error = e.message;
        if (attempt < MAX_RETRIES && jobRunning) {
          await sleep(RETRY_BACKOFF_MS * attempt);
        }
      }
    }

    if (data && data.price) {
      localState.results[index] = {
        price       : data.price,
        avgRating   : data.avgRating    || null,
        totalRatings: data.totalRatings || null,
        breakdown   : data.breakdown    || null,
        error       : null
      };
    } else {
      localState.results[index] = {
        price       : null,
        avgRating   : data?.avgRating    || null,
        totalRatings: data?.totalRatings || null,
        breakdown   : data?.breakdown    || null,
        error       : error || data?.error || 'Unknown error'
      };
    }

    localState.completed++;
    localState.active = Math.max(0, localState.active - 1);
    await syncState();

    if (jobQueue.length > 0 && jobRunning) {
      await sleep(rateLimitMs);
    }
  }
}

// ───────────────────────────────────────────────────────────────
//  Per-URL extraction — REUSES pool tab via tabs.update (NEW v6)
// ───────────────────────────────────────────────────────────────
function extractFromUrl(url, workerId) {
  return new Promise(async (resolve, reject) => {
    // ── Validate URL ────────────────────────────────────────
    let parsed;
    try   { parsed = new URL(url); }
    catch { return reject(new Error('Invalid URL format')); }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return reject(new Error('URL must be http/https'));
    }

    const host = parsed.hostname;
    if (!host.includes('amazon.in') && !host.includes('flipkart.com')) {
      return reject(new Error('Only amazon.in and flipkart.com supported'));
    }

    // ── Get or recreate pool tab ─────────────────────────────
    // If pool tab is null (was closed unexpectedly), create a new one
    let tabId = tabPool[workerId] ?? null;

    if (tabId === null) {
      try {
        const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
        tabId = tab.id;
        tabPool[workerId] = tabId;
      } catch (e) {
        return reject(new Error('Could not create tab: ' + e.message));
      }
    }

    // ── Navigate existing tab to new URL (reuse) ─────────────
    try {
      await chrome.tabs.update(tabId, { url });
    } catch (e) {
      // Tab may have been closed externally — recreate it
      try {
        const tab = await chrome.tabs.create({ url, active: false });
        tabId = tab.id;
        tabPool[workerId] = tabId;
      } catch (e2) {
        return reject(new Error('Could not navigate tab: ' + e2.message));
      }
    }

    // ── Register pending handler for this navigation ─────────
    const globalTimeout = setTimeout(() => {
      pendingTabs.delete(tabId);
      reject(new Error('Page load timeout (35s)'));
      // Don't close the tab — keep it in the pool for the next URL
    }, TAB_TIMEOUT_MS);

    pendingTabs.set(tabId, {
      resolve: (data) => { clearTimeout(globalTimeout); resolve(data); },
      reject:  (err)  => { clearTimeout(globalTimeout); reject(err); },
      timeout: null,
      loaded : false   // reset for each new navigation
    });
  });
}

// ───────────────────────────────────────────────────────────────
//  Close all pool tabs at end of job
// ───────────────────────────────────────────────────────────────
async function drainTabPool() {
  for (const tabId of tabPool) {
    if (tabId !== null) await safeCloseTab(tabId);
  }
  tabPool.length = 0;
}

// ───────────────────────────────────────────────────────────────
//  Cancel
// ───────────────────────────────────────────────────────────────
function cancelJob() {
  jobRunning = false;
  jobQueue   = [];

  for (const [tabId, pending] of pendingTabs) {
    clearTimeout(pending.timeout);
    pending.reject(new Error('Job cancelled'));
  }
  pendingTabs.clear();

  // Close all pool tabs on cancel
  drainTabPool();
}

// ───────────────────────────────────────────────────────────────
//  Helpers
// ───────────────────────────────────────────────────────────────
function sendMessageToTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

async function safeCloseTab(tabId) {
  try { await chrome.tabs.remove(tabId); } catch {}
}

// ── saveStateSafe integrated into syncState (NEW v6) ──────────
// Storage writes are now try/catch protected. If quota is exceeded
// or storage fails, job continues instead of crashing silently.
async function syncState() {
  try {
    await chrome.storage.local.set({ job: { ...localState } });
  } catch (e) {
    console.warn('Price Extractor: storage write failed:', e.message);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
