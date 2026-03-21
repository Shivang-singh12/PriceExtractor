// ═══════════════════════════════════════════════════════════════
//  Price Extractor Pro – popup.js
//  File parsing (CSV + XLSX), job submission, progress UI
// ═══════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────
//  State
// ───────────────────────────────────────────────────────────────
let parsedRows   = [];   // All rows from input file
let allUrls      = [];   // Extracted URLs
let pollTimer    = null;
let jobComplete  = false;
let finalResults = {};

// ───────────────────────────────────────────────────────────────
//  DOM refs
// ───────────────────────────────────────────────────────────────
const uploadZone     = document.getElementById('uploadZone');
const uploadDefault  = document.getElementById('uploadDefault');
const uploadFileInfo = document.getElementById('uploadFileInfo');
const fileIcon       = document.getElementById('fileIcon');
const fileNameEl     = document.getElementById('fileName');
const fileMetaEl     = document.getElementById('fileMeta');
const fileClear      = document.getElementById('fileClear');
const fileInput      = document.getElementById('fileInput');

const btnStart       = document.getElementById('btnStart');
const btnCancel      = document.getElementById('btnCancel');
const btnDownload    = document.getElementById('btnDownload');

const progressSection = document.getElementById('progressSection');
const progressCount   = document.getElementById('progressCount');
const progressFill    = document.getElementById('progressFill');
const currentUrlText  = document.getElementById('currentUrlText');

const resultsSection  = document.getElementById('resultsSection');
const resultsStats    = document.getElementById('resultsStats');
const resultsBody     = document.getElementById('resultsBody');

const statusDot       = document.getElementById('statusDot');
const statusText      = document.getElementById('statusText');
const footerHint      = document.getElementById('footerHint');

// ───────────────────────────────────────────────────────────────
//  Upload zone
// ───────────────────────────────────────────────────────────────
uploadZone.addEventListener('click', () => fileInput.click());

uploadZone.addEventListener('dragover', e => {
  e.preventDefault();
  uploadZone.classList.add('dragover');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

fileClear.addEventListener('click', e => {
  e.stopPropagation();
  resetFileState();
});

function resetFileState() {
  parsedRows = [];
  allUrls    = [];
  fileInput.value = '';
  uploadZone.classList.remove('has-file');
  uploadDefault.style.display = '';
  uploadFileInfo.classList.remove('show');
  btnStart.disabled = true;
  setStatus('idle', 'Ready');
  footerHint.textContent = 'Upload a file to begin';
  hideResults();
}

// ───────────────────────────────────────────────────────────────
//  File handling
// ───────────────────────────────────────────────────────────────
async function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  setStatus('idle', 'Parsing file…');

  try {
    let rows;
    if (ext === 'csv') {
      const text = await readAsText(file);
      rows = parseCSV(text);
    } else if (ext === 'xlsx' || ext === 'xls') {
      const buffer = await readAsArrayBuffer(file);
      rows = await parseXLSX(buffer);
    } else {
      throw new Error('Unsupported file type. Use .csv or .xlsx');
    }

    parsedRows = rows;

    // Extract URLs based on settings
    refreshUrlList();

    const urlCount = allUrls.filter(u => u).length;

    // Update UI
    uploadZone.classList.add('has-file');
    uploadDefault.style.display = 'none';
    uploadFileInfo.classList.add('show');
    fileIcon.textContent = ext === 'csv' ? '📋' : '📊';
    fileNameEl.textContent = file.name;
    fileMetaEl.textContent = `${rows.length} rows · ${urlCount} valid URLs detected`;

    btnStart.disabled = urlCount === 0;
    setStatus('idle', urlCount > 0 ? `${urlCount} URLs ready` : 'No URLs found in selected column');
    footerHint.textContent = urlCount > 0 ? `Col C will be updated with prices` : 'Check URL column setting';

  } catch (e) {
    setStatus('error', 'Parse error: ' + e.message);
  }
}

function refreshUrlList() {
  const colIdx    = parseInt(document.getElementById('urlColumn').value);
  const skipHdr   = parseInt(document.getElementById('skipHeader').value);
  const startRow  = skipHdr ? 1 : 0;

  allUrls = parsedRows.slice(startRow).map(row => (row[colIdx] || '').trim());
}

// Re-read URL column when settings change
document.getElementById('urlColumn').addEventListener('change', () => {
  if (parsedRows.length) { refreshUrlList(); }
});
document.getElementById('skipHeader').addEventListener('change', () => {
  if (parsedRows.length) { refreshUrlList(); }
});

// ───────────────────────────────────────────────────────────────
//  Start / Cancel
// ───────────────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  refreshUrlList();
  const validUrls = allUrls; // background handles invalid ones gracefully
  if (!validUrls.length) return;

  jobComplete  = false;
  finalResults = {};

  btnStart.disabled = true;
  btnCancel.classList.add('show');
  btnDownload.classList.remove('show');

  progressSection.classList.add('show');
  resultsSection.classList.remove('show');
  setStatus('active', 'Running extraction…');
  footerHint.textContent = 'Keep this popup open';

  // Clear storage
  await chrome.storage.local.remove('job');

  // Clear results table
  resultsBody.innerHTML = '';
  renderPendingRows(validUrls);

  // Send job to background
  const rateLimit = parseInt(document.getElementById('rateLimit').value);
  chrome.runtime.sendMessage({ action: 'startJob', urls: validUrls, rateLimit });

  // Start polling
  pollTimer = setInterval(pollProgress, 600);
});

btnCancel.addEventListener('click', async () => {
  clearInterval(pollTimer);
  chrome.runtime.sendMessage({ action: 'cancelJob' });
  btnCancel.classList.remove('show');
  btnStart.disabled = false;
  setStatus('error', 'Cancelled');
  footerHint.textContent = 'Job cancelled';
});

// ───────────────────────────────────────────────────────────────
//  Progress polling
// ───────────────────────────────────────────────────────────────
async function pollProgress() {
  chrome.runtime.sendMessage({ action: 'getProgress' }, (job) => {
    if (!job) return;

    const { total, current, results, status } = job;
    finalResults = results || {};

    // Update progress bar
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    progressFill.style.width = pct + '%';
    progressCount.textContent = `${current} / ${total}`;

    // Update current URL hint
    if (current < allUrls.length) {
      currentUrlText.textContent = allUrls[current] || '—';
    }

    // Update rows
    updateResultRows(results || {}, current, total);

    if (status === 'complete' || status === 'cancelled') {
      clearInterval(pollTimer);
      jobComplete = true;

      if (status === 'complete') {
        progressFill.style.width = '100%';
        progressCount.textContent = `${total} / ${total}`;
        currentUrlText.textContent = 'All done!';
        setStatus('done', 'Extraction complete');
        footerHint.textContent = 'Download updated CSV below';
        btnDownload.classList.add('show');
      }

      btnCancel.classList.remove('show');
      btnStart.disabled = false;
      showResultsStats(results || {}, total);
    }
  });
}

// ───────────────────────────────────────────────────────────────
//  Results table rendering
// ───────────────────────────────────────────────────────────────
function renderPendingRows(urls) {
  resultsSection.classList.add('show');
  resultsBody.innerHTML = '';
  urls.forEach((url, i) => {
    const tr = document.createElement('tr');
    tr.id = `row-${i}`;
    tr.innerHTML = `
      <td class="td-row">${i + 1}</td>
      <td class="td-url"><a href="${esc(url)}" title="${esc(url)}" target="_blank">${shortUrl(url)}</a></td>
      <td class="td-price" id="price-${i}">—</td>
      <td id="status-${i}"><span class="badge badge-pending">Pending</span></td>
    `;
    resultsBody.appendChild(tr);
  });
}

function updateResultRows(results, current, total) {
  for (const [idxStr, res] of Object.entries(results)) {
    const i = parseInt(idxStr);
    const priceEl  = document.getElementById(`price-${i}`);
    const statusEl = document.getElementById(`status-${i}`);
    if (!priceEl || !statusEl) continue;

    if (res.price) {
      priceEl.textContent  = res.price;
      statusEl.innerHTML   = `<span class="badge badge-ok">✓ Done</span>`;
    } else {
      priceEl.innerHTML    = `<span style="color:var(--error);font-size:9px;" title="${esc(res.error)}">N/A</span>`;
      statusEl.innerHTML   = `<span class="badge badge-error" title="${esc(res.error)}">Error</span>`;
    }
  }

  // Mark current processing row
  if (current < total) {
    const statusEl = document.getElementById(`status-${current}`);
    const priceEl  = document.getElementById(`price-${current}`);
    if (statusEl && !results[current]) {
      statusEl.innerHTML = `<span class="badge badge-running">⚡ Live</span>`;
    }
    if (priceEl && !results[current]) {
      priceEl.textContent = '…';
    }
  }
}

function showResultsStats(results, total) {
  const success = Object.values(results).filter(r => r.price).length;
  const errors  = Object.values(results).filter(r => !r.price).length;
  const pending = total - Object.keys(results).length;

  resultsStats.innerHTML = `
    <div class="stat"><div class="stat-num green">${success}</div><div class="stat-label">✓ Extracted</div></div>
    <div class="stat"><div class="stat-num red">${errors}</div><div class="stat-label">✕ Errors</div></div>
    <div class="stat"><div class="stat-num orange">${pending}</div><div class="stat-label">⊘ Skipped</div></div>
    <div class="stat"><div class="stat-num" style="color:var(--muted2)">${total}</div><div class="stat-label">Total</div></div>
  `;
}

function hideResults() {
  progressSection.classList.remove('show');
  resultsSection.classList.remove('show');
}

// ───────────────────────────────────────────────────────────────
//  Download CSV
// ───────────────────────────────────────────────────────────────
btnDownload.addEventListener('click', () => {
  if (!parsedRows.length) return;

  const skipHdr  = parseInt(document.getElementById('skipHeader').value);
  const colIdx   = parseInt(document.getElementById('urlColumn').value);

  // Rebuild rows with prices in Column C (index 2)
  const outputRows = parsedRows.map((row, rowIdx) => {
    const urlRowIdx = rowIdx - (skipHdr ? 1 : 0); // Adjust for header
    const isHeader  = skipHdr && rowIdx === 0;

    const newRow = [...row];
    // Ensure at least 3 columns
    while (newRow.length < 3) newRow.push('');

    if (isHeader) {
      newRow[2] = 'Price';
    } else if (urlRowIdx >= 0 && urlRowIdx < allUrls.length) {
      const result = finalResults[urlRowIdx];
      newRow[2] = result?.price || (result?.error ? `ERROR: ${result.error}` : '');
    }

    return newRow;
  });

  const csv = outputRows.map(row =>
    row.map(cell => {
      const s = String(cell ?? '');
      return (s.includes(',') || s.includes('"') || s.includes('\n'))
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    }).join(',')
  ).join('\n');

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `prices_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ───────────────────────────────────────────────────────────────
//  Status helper
// ───────────────────────────────────────────────────────────────
function setStatus(type, text) {
  statusText.textContent = text;
  statusDot.className = 'status-dot';
  if (type === 'active') statusDot.classList.add('active');
  if (type === 'done')   statusDot.classList.add('done');
  if (type === 'error')  statusDot.classList.add('error');
}

// ───────────────────────────────────────────────────────────────
//  ── Minimal XLSX Parser (pure JS, no dependencies) ──────────
//  Reads: ZIP → xl/sharedStrings.xml + xl/worksheets/sheet1.xml
// ───────────────────────────────────────────────────────────────
async function parseXLSX(buffer) {
  const getFile = await buildZipReader(buffer);

  // Shared strings
  const sharedStrings = [];
  const ssRaw = await getFile('xl/sharedStrings.xml');
  if (ssRaw) {
    const doc = parseXML(ssRaw);
    doc.querySelectorAll('si').forEach(si => {
      sharedStrings.push([...si.querySelectorAll('t')].map(t => t.textContent).join(''));
    });
  }

  // Sheet 1 – try common paths
  let sheetRaw = await getFile('xl/worksheets/sheet1.xml');
  if (!sheetRaw) sheetRaw = await getFile('xl/worksheets/Sheet1.xml');
  if (!sheetRaw) throw new Error('Could not find worksheet in XLSX file');

  const doc  = parseXML(sheetRaw);
  const rows = [];

  doc.querySelectorAll('row').forEach(rowEl => {
    const ri = +rowEl.getAttribute('r') - 1;
    while (rows.length <= ri) rows.push([]);

    rowEl.querySelectorAll('c').forEach(c => {
      const ref = c.getAttribute('r') || '';
      const colStr = ref.replace(/\d/g, '');
      const col = colStr.split('').reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0) - 1;

      const type   = c.getAttribute('t');
      const vEl    = c.querySelector('v');
      const v      = vEl ? vEl.textContent : '';
      const value  = type === 's' ? (sharedStrings[+v] ?? '') : v;

      const r = rows[ri];
      while (r.length <= col) r.push('');
      r[col] = value;
    });
  });

  return rows;
}

// Minimal ZIP reader using DecompressionStream (Chrome 80+)
async function buildZipReader(buffer) {
  const bytes = new Uint8Array(buffer);
  const view  = new DataView(buffer);

  // Find End of Central Directory
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP/XLSX file');

  const cdOffset = view.getUint32(eocd + 16, true);
  const cdCount  = view.getUint16(eocd + 10, true);

  // Parse central directory
  const entries = {};
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method    = view.getUint16(p + 10, true);
    const compSize  = view.getUint32(p + 20, true);
    const fnLen     = view.getUint16(p + 28, true);
    const extraLen  = view.getUint16(p + 30, true);
    const cmtLen    = view.getUint16(p + 32, true);
    const localOff  = view.getUint32(p + 42, true);
    const name      = new TextDecoder().decode(bytes.slice(p + 46, p + 46 + fnLen));
    entries[name]   = { localOff, method, compSize };
    p += 46 + fnLen + extraLen + cmtLen;
  }

  return async function getFile(name) {
    const e = entries[name];
    if (!e) return null;

    const lv    = new DataView(buffer, e.localOff);
    const fnl   = lv.getUint16(26, true);
    const exl   = lv.getUint16(28, true);
    const start = e.localOff + 30 + fnl + exl;
    const raw   = bytes.slice(start, start + e.compSize);

    if (e.method === 0) return new TextDecoder().decode(raw);

    if (e.method === 8) {
      const ds     = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      writer.write(raw);
      writer.close();

      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const total  = chunks.reduce((n, c) => n + c.length, 0);
      const out    = new Uint8Array(total);
      let   off    = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return new TextDecoder().decode(out);
    }

    throw new Error(`Unsupported ZIP compression method: ${e.method}`);
  };
}

function parseXML(text) {
  return new DOMParser().parseFromString(text, 'text/xml');
}

// ───────────────────────────────────────────────────────────────
//  CSV Parser (handles quoted fields, commas in values, CRLF)
// ───────────────────────────────────────────────────────────────
function parseCSV(text) {
  const rows   = [];
  const lines  = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let   pos    = 0;

  while (pos < lines.length) {
    const row = [];
    while (pos < lines.length && lines[pos] !== '\n') {
      if (lines[pos] === '"') {
        // Quoted field
        pos++;
        let field = '';
        while (pos < lines.length) {
          if (lines[pos] === '"' && lines[pos + 1] === '"') { field += '"'; pos += 2; }
          else if (lines[pos] === '"')                       { pos++; break; }
          else                                               { field += lines[pos++]; }
        }
        row.push(field);
        if (lines[pos] === ',') pos++;
      } else {
        let field = '';
        while (pos < lines.length && lines[pos] !== ',' && lines[pos] !== '\n') {
          field += lines[pos++];
        }
        row.push(field.trim());
        if (lines[pos] === ',') pos++;
      }
    }
    if (lines[pos] === '\n') pos++;
    if (row.length > 0 && !(row.length === 1 && row[0] === '')) {
      rows.push(row);
    }
  }

  return rows;
}

// ───────────────────────────────────────────────────────────────
//  File read helpers
// ───────────────────────────────────────────────────────────────
function readAsText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result);
    r.onerror = () => rej(new Error('Failed to read file'));
    r.readAsText(file, 'UTF-8');
  });
}

function readAsArrayBuffer(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result);
    r.onerror = () => rej(new Error('Failed to read file'));
    r.readAsArrayBuffer(file);
  });
}

// ───────────────────────────────────────────────────────────────
//  Utilities
// ───────────────────────────────────────────────────────────────
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.slice(0, 30) + (u.pathname.length > 30 ? '…' : '');
    return u.hostname.replace('www.', '') + path;
  } catch {
    return url.slice(0, 40) + (url.length > 40 ? '…' : '');
  }
}
