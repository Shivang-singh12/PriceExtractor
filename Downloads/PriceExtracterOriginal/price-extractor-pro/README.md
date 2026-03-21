# Price Extractor Pro 🔋
**Bulk price extractor for Amazon India & Flipkart via CSV/Excel**

---

## Installation (Local, No Store Required)

1. **Download & extract** the ZIP file
2. Open Chrome → go to `chrome://extensions/`
3. Toggle **Developer Mode** ON (top-right)
4. Click **Load Unpacked** → select the `price-extractor-pro` folder
5. The ₹↓ icon appears in your Chrome toolbar

---

## How to Use

### Step 1 — Prepare your CSV/Excel
- Column A: Product URLs (one per row)
- Column B: Product Name (optional)
- Column C: Leave blank — prices will be written here

Use the included `sample_urls.csv` as a template.

### Step 2 — Upload & Configure
- Click the extension icon
- Drag & drop your CSV or Excel (.xlsx) file
- Configure:
  - **Rate Limit**: How fast to process (2s recommended to avoid blocks)
  - **URL Column**: Which column has your URLs (default: A)
  - **Skip Header**: Skip row 1 if it's a header (default: Yes)

### Step 3 — Start Extraction
- Click **⚡ Start Extraction**
- Keep the popup open while running
- Watch the live progress table update

### Step 4 — Download
- Click **⬇ Download CSV** when complete
- Column C in the downloaded file has all extracted prices
- Rows with errors show `ERROR: <reason>` in Column C

---

## Supported Sites
| Site | URL Pattern | Notes |
|------|------------|-------|
| Amazon India | amazon.in/dp/... | Product pages only |
| Flipkart | flipkart.com/.../p/... | Product pages only |

---

## Error Reference
| Error | Cause |
|-------|-------|
| `Invalid URL format` | URL is malformed |
| `Only amazon.in and flipkart.com supported` | Wrong site |
| `Product unavailable / out of stock` | Page shows OOS |
| `Not a product page` | URL is a search/category page |
| `Price not found after 15s` | Layout change or dynamic load issue |
| `Page load timeout (35s)` | Slow connection or page blocked |

---

## Technical Details
- **Manifest V3** service worker architecture
- **Rate limiting**: Configurable 1.5s–5s between requests
- **Retry logic**: Up to 3 attempts per URL with exponential backoff
- **Dynamic content**: 3-second wait after page load for JS rendering
- **XLSX parser**: Pure JS, no external dependencies (uses native DecompressionStream)
- **Tab management**: Opens background tabs (inactive, non-disruptive)

---

## Tips
- Use **Safe (3s)** rate limit for large batches to avoid being rate-limited by sites
- Product page URLs work best (amazon.in/dp/XXX or flipkart.com/.../p/itmXXX)
- If prices aren't being found, the site may have updated their CSS — open an issue
