// ═══════════════════════════════════════════════════════════════
//  Price Extractor Pro – content.js  v3
//  Strategy: URL-pattern product detection + ₹ DOM scan
//  (Class-name selectors break when Flipkart rotates CSS hashes)
// ═══════════════════════════════════════════════════════════════

const MAX_WAIT_MS   = 18000;
const POLL_INTERVAL = 500;

// ───────────────────────────────────────────────────────────────
//  Site detection
// ───────────────────────────────────────────────────────────────
function getHost() { return window.location.hostname.toLowerCase(); }
function isAmazon()   { return getHost().includes('amazon'); }
function isFlipkart() { return getHost().includes('flipkart'); }

// ───────────────────────────────────────────────────────────────
//  Is this a product page?
// ───────────────────────────────────────────────────────────────
function checkPageIsProduct() {
  const path = window.location.pathname;
  const host = getHost();

  if (host.includes('amazon')) {
    // amazon.in/dp/ASIN or /gp/product/ASIN
    if (/\/(dp|gp\/product)\/[A-Z0-9]{10}/i.test(path)) return true;
    // Fallback: classic DOM markers
    return !!(
      document.querySelector('#productTitle') ||
      document.querySelector('#dp-container') ||
      document.querySelector('#buybox')
    );
  }

  if (host.includes('flipkart')) {
    // Flipkart product URLs always contain /p/ in path
    if (/\/p\/[a-zA-Z0-9]+/.test(path)) return true;
    // Fallback: pid query param
    if (new URLSearchParams(window.location.search).get('pid')) return true;
    // Fallback: classic DOM markers (may be stale but worth trying)
    return !!(
      document.querySelector('span.B_NuCI')   ||
      document.querySelector('h1.yhB1nd')     ||
      document.querySelector('div.hl05eU')    ||
      document.querySelector('div.DOjaWF')    ||
      document.querySelector('h1.VU-ZEz')     ||
      document.querySelector('._3qQ9m1')
    );
  }

  return false;
}

// ───────────────────────────────────────────────────────────────
//  Amazon price extraction (ID-based, very stable)
// ───────────────────────────────────────────────────────────────
const AMAZON_PRICE_SELECTORS = [
  '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
  '#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen',
  '.apexPriceToPay .a-offscreen',
  '#priceblock_ourprice',
  '#priceblock_dealprice',
  '#priceblock_saleprice',
  '.a-price[data-a-size="xl"] .a-offscreen',
  '.a-price[data-a-size="l"] .a-offscreen',
  '.a-price .a-offscreen',
  '#price_inside_buybox',
  '#newBuyBoxPrice',
  '.a-color-price',
];

function tryAmazonPrice() {
  for (const sel of AMAZON_PRICE_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = el.textContent.trim();
    if (text && (text.includes('₹') || /^\d/.test(text))) {
      return cleanPrice(text);
    }
  }
  return null;
}

// ───────────────────────────────────────────────────────────────
//  Flipkart price extraction – ₹ DOM scan (class-name agnostic)
// ───────────────────────────────────────────────────────────────

// Known stable class fragments still used (belt-and-suspenders)
const FK_STABLE_SELECTORS = [
  'div._30jeq3._16Jk6d',
  'div._30jeq3',
  '._16Jk6d',
  'div.Nx9bqj',
  '.hl05eU .Nx9bqj',
  'div.CEmiEU ._30jeq3',
];

function tryFlipkartPrice() {
  // 1. Try known stable selectors first (fast path)
  for (const sel of FK_STABLE_SELECTORS) {
    try {
      const el = document.querySelector(sel);
      if (!el) continue;
      const text = el.textContent.trim();
      if (isValidPrice(text)) return cleanPrice(text);
    } catch {}
  }

  // 2. Structural scan: find the most prominent ₹ element on the page
  //    Logic: look for elements that contain ONLY a price (short text, has ₹)
  //    and are likely in the buybox area (not in reviews, related products, etc.)
  return structuralPriceScan();
}

function structuralPriceScan() {
  // Gather all text nodes / leaf elements containing ₹
  const candidates = [];
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        // Skip hidden elements
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return NodeFilter.FILTER_REJECT;
        }
        // Skip script, style, nav, footer
        const tag = node.tagName.toLowerCase();
        if (['script','style','nav','footer','header','aside'].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  while (walker.nextNode()) {
    const el   = walker.currentNode;
    const text = el.textContent.trim();

    // Must be short (price only, not a paragraph), contain ₹, look like a price
    if (
      text.length > 2 && text.length < 20 &&
      text.includes('₹') &&
      /[\d,]+/.test(text) &&
      el.children.length <= 2   // leaf-ish element
    ) {
      const rect = el.getBoundingClientRect();
      // Must be visible on screen
      if (rect.width > 0 && rect.height > 0) {
        const fontSize = parseFloat(window.getComputedStyle(el).fontSize || '0');
        candidates.push({ el, text, fontSize, top: rect.top });
      }
    }
  }

  if (!candidates.length) return null;

  // Scoring: prefer larger font size (main price) and higher on page
  // Exclude elements that look like they're in review/recommendation sections
  const scored = candidates
    .filter(c => !isInExcludedSection(c.el))
    .map(c => ({
      ...c,
      score: c.fontSize * 2 - c.top * 0.01
    }))
    .sort((a, b) => b.score - a.score);

  return scored.length > 0 ? cleanPrice(scored[0].text) : null;
}

function isInExcludedSection(el) {
  // Walk up the DOM to see if this element is inside a review, related, or ad section
  let node = el;
  for (let i = 0; i < 10; i++) {
    if (!node || node === document.body) break;
    const cls = (node.className || '').toString().toLowerCase();
    const id  = (node.id || '').toLowerCase();
    if (
      cls.includes('review')   || cls.includes('similar')  ||
      cls.includes('related')  || cls.includes('recommend') ||
      cls.includes('carousel') || cls.includes('ads')       ||
      id.includes('review')    || id.includes('similar')    ||
      id.includes('related')
    ) return true;
    node = node.parentElement;
  }
  return false;
}

// ───────────────────────────────────────────────────────────────
//  OOS checks
// ───────────────────────────────────────────────────────────────
function checkAmazonOOS() {
  const el = document.querySelector('#availability');
  if (el) {
    const t = el.textContent.toLowerCase();
    if (t.includes('unavailable') || t.includes('out of stock') || t.includes('currently')) return true;
  }
  return false;
}

function checkFlipkartOOS() {
  // Text scan for OOS indicators
  const bodyText = document.body.textContent.toLowerCase();
  if (bodyText.includes('sold out') || bodyText.includes('notify me')) {
    // But make sure there's no price — sometimes notify-me + price coexist
    return true;
  }
  return false;
}

// ───────────────────────────────────────────────────────────────
//  Helpers
// ───────────────────────────────────────────────────────────────
function isValidPrice(text) {
  return text && text.length < 20 && (text.includes('₹') || /^\d[\d,]+$/.test(text));
}

function cleanPrice(text) {
  return text.replace(/\s+/g, ' ').replace(/₹\s*₹/g, '₹').trim();
}

// ───────────────────────────────────────────────────────────────
//  Main polling loop
// ───────────────────────────────────────────────────────────────
function extractPriceWithPolling() {
  return new Promise((resolve) => {
    const startTime = Date.now();

    function attempt() {
      const elapsed = Date.now() - startTime;

      const isProduct = checkPageIsProduct();

      // Wait up to 8s for product page signals
      if (!isProduct && elapsed < 8000) {
        setTimeout(attempt, POLL_INTERVAL);
        return;
      }

      if (!isProduct && elapsed >= 8000) {
        resolve({ price: null, error: 'Not a product page (URL does not contain /p/ for Flipkart or /dp/ for Amazon)' });
        return;
      }

      // Try price extraction
      let price = null;
      if (isAmazon())   price = tryAmazonPrice();
      if (isFlipkart()) price = tryFlipkartPrice();

      if (price) {
        resolve({ price, error: null });
        return;
      }

      // OOS check after 5s
      if (elapsed > 5000) {
        if (isFlipkart() && checkFlipkartOOS()) {
          resolve({ price: null, error: 'Product sold out / unavailable' });
          return;
        }
        if (isAmazon() && checkAmazonOOS()) {
          resolve({ price: null, error: 'Product unavailable / out of stock' });
          return;
        }
      }

      if (elapsed >= MAX_WAIT_MS) {
        resolve({ price: null, error: 'Price element not found after 18s — Flipkart may have updated layout' });
        return;
      }

      setTimeout(attempt, POLL_INTERVAL);
    }

    attempt();
  });
}

// ───────────────────────────────────────────────────────────────
//  Message listener
// ───────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'extractPrice') {
    extractPriceWithPolling().then(sendResponse);
    return true;
  }
});
