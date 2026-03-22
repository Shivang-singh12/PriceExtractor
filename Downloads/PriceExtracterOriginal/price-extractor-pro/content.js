// ═══════════════════════════════════════════════════════════════
//  Price Extractor Pro – content.js  v4
//  Extracts: price, avg rating, total ratings, star breakdown
// ═══════════════════════════════════════════════════════════════

const MAX_WAIT_MS   = 18000;
const POLL_INTERVAL = 500;

// ───────────────────────────────────────────────────────────────
//  Site detection
// ───────────────────────────────────────────────────────────────
function getHost()    { return window.location.hostname.toLowerCase(); }
function isAmazon()   { return getHost().includes('amazon'); }
function isFlipkart() { return getHost().includes('flipkart'); }

// ───────────────────────────────────────────────────────────────
//  Is this a product page?
// ───────────────────────────────────────────────────────────────
function checkPageIsProduct() {
  const path = window.location.pathname;
  const host = getHost();

  if (host.includes('amazon')) {
    if (/\/(dp|gp\/product)\/[A-Z0-9]{10}/i.test(path)) return true;
    return !!(
      document.querySelector('#productTitle') ||
      document.querySelector('#dp-container') ||
      document.querySelector('#buybox')
    );
  }

  if (host.includes('flipkart')) {
    if (/\/p\/[a-zA-Z0-9]+/.test(path)) return true;
    if (new URLSearchParams(window.location.search).get('pid')) return true;
    return !!(
      document.querySelector('span.B_NuCI')  ||
      document.querySelector('h1.yhB1nd')    ||
      document.querySelector('div.hl05eU')   ||
      document.querySelector('div.DOjaWF')   ||
      document.querySelector('h1.VU-ZEz')    ||
      document.querySelector('._3qQ9m1')
    );
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════
//  PRICE EXTRACTION
// ═══════════════════════════════════════════════════════════════

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

const FK_PRICE_SELECTORS = [
  'div._30jeq3._16Jk6d',
  'div._30jeq3',
  '._16Jk6d',
  'div.Nx9bqj',
  '.hl05eU .Nx9bqj',
  'div.CEmiEU ._30jeq3',
];

function tryAmazonPrice() {
  for (const sel of AMAZON_PRICE_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = el.textContent.trim();
    if (text && (text.includes('₹') || /^\d/.test(text))) return cleanPrice(text);
  }
  return null;
}

function tryFlipkartPrice() {
  for (const sel of FK_PRICE_SELECTORS) {
    try {
      const el = document.querySelector(sel);
      if (!el) continue;
      const text = el.textContent.trim();
      if (isValidPrice(text)) return cleanPrice(text);
    } catch {}
  }
  return structuralPriceScan();
}

function structuralPriceScan() {
  const candidates = [];
  const walker = document.createTreeWalker(
    document.body, NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
        const tag = node.tagName.toLowerCase();
        if (['script','style','nav','footer','header','aside'].includes(tag)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  while (walker.nextNode()) {
    const el   = walker.currentNode;
    const text = el.textContent.trim();
    if (
      text.length > 2 && text.length < 20 &&
      text.includes('₹') && /[\d,]+/.test(text) &&
      el.children.length <= 2
    ) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const fontSize = parseFloat(window.getComputedStyle(el).fontSize || '0');
        candidates.push({ el, text, fontSize, top: rect.top });
      }
    }
  }

  if (!candidates.length) return null;

  const scored = candidates
    .filter(c => !isInExcludedSection(c.el))
    .map(c => ({ ...c, score: c.fontSize * 2 - c.top * 0.01 }))
    .sort((a, b) => b.score - a.score);

  return scored.length > 0 ? cleanPrice(scored[0].text) : null;
}

function isInExcludedSection(el) {
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

// ═══════════════════════════════════════════════════════════════
//  RATING EXTRACTION – AMAZON
// ═══════════════════════════════════════════════════════════════

function extractAmazonRatings() {
  const result = { avgRating: null, totalRatings: null, breakdown: null };

  // ── Average rating ───────────────────────────────────────────
  // Primary: data-hook attribute (most reliable, used by Amazon for structured data)
  const ratingHook = document.querySelector('[data-hook="rating-out-of-text"]');
  if (ratingHook) {
    const m = ratingHook.textContent.match(/([\d.]+)\s+out of/i);
    if (m) result.avgRating = m[1];
  }

  // Fallback: .a-icon-star > .a-icon-alt text like "4.3 out of 5 stars"
  if (!result.avgRating) {
    const starEl = document.querySelector(
      '#averageCustomerReviews .a-icon-star .a-icon-alt,' +
      '#acrPopupLink .a-icon-alt,' +
      '.reviewCountTextLinkedHistogram .a-icon-alt,' +
      '[data-hook="average-stars-rating-anywhere"] .a-icon-alt'
    );
    if (starEl) {
      const m = starEl.textContent.match(/([\d.]+)/);
      if (m) result.avgRating = m[1];
    }
  }

  // Fallback: aria-label on star element
  if (!result.avgRating) {
    const ariaEl = document.querySelector(
      '#averageCustomerReviews [aria-label*="out of"],' +
      '#acrPopupLink [aria-label*="stars"]'
    );
    if (ariaEl) {
      const label = ariaEl.getAttribute('aria-label') || '';
      const m = label.match(/([\d.]+)\s+out of/i) || label.match(/([\d.]+)\s+star/i);
      if (m) result.avgRating = m[1];
    }
  }

  // ── Total ratings count ──────────────────────────────────────
  const totalEl = document.querySelector(
    '#acrCustomerReviewText,' +
    '[data-hook="total-review-count"],' +
    '#averageCustomerReviews ~ * [data-hook="total-review-count"]'
  );
  if (totalEl) {
    const m = totalEl.textContent.replace(/,/g, '').match(/(\d+)/);
    if (m) result.totalRatings = m[1];
  }

  // Fallback: look for ratings link text like "1,234 ratings"
  if (!result.totalRatings) {
    const allLinks = document.querySelectorAll('#averageCustomerReviews a, [data-hook="see-all-reviews-link-foot"]');
    for (const link of allLinks) {
      const t = link.textContent.trim();
      const m = t.replace(/,/g, '').match(/^(\d+)\s+(rating|review)/i);
      if (m) { result.totalRatings = m[1]; break; }
    }
  }

  // ── Star breakdown (1★ to 5★ percentages) ───────────────────
  const histRows = document.querySelectorAll(
    '#histogramTable tr,' +
    '[data-hook="histogram-container"] tr,' +
    '.a-histogram-row'
  );

  if (histRows.length >= 3) {
    const breakdown = {};
    histRows.forEach(row => {
      // Row typically has: "5 star", "64%", "See all … 5 star reviews"
      const cells  = row.querySelectorAll('td, li');
      const text   = row.textContent;
      const starM  = text.match(/(\d)\s*star/i);
      const pctEl  = row.querySelector('.a-text-right, [data-csa-c-type="element"]');
      const pctM   = text.match(/(\d+)%/);
      if (starM && pctM) {
        breakdown[starM[1] + '★'] = pctM[1] + '%';
      }
    });
    if (Object.keys(breakdown).length >= 3) result.breakdown = breakdown;
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
//  RATING EXTRACTION – FLIPKART
// ═══════════════════════════════════════════════════════════════

function extractFlipkartRatings() {
  const result = { avgRating: null, totalRatings: null, breakdown: null };

  // ── Average rating ───────────────────────────────────────────
  // Flipkart shows average as a standalone number like "4.3" in a styled div
  const avgSelectors = [
    'div._3LWZlK',           // classic
    'div._1lRcqv ._3LWZlK', // inside rating block
    'div.XQDdHH',            // 2024 layout
    'div._2d4LTz',           // alternate
    'span._2_R_DZ ._3LWZlK', // inline
	  'div.css-146c3p1',//2026- added on 21st
    'span.css-146c3p1',//2026- added on 21st
    '.css-146c3p1',//2026- added on 21st
  ];
console.log('[Rating Debug] Starting average rating extraction with selectors:', avgSelectors);
  for (const sel of avgSelectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = el.textContent.trim();
    if (/^\d[\d.]*$/.test(text) && parseFloat(text) >= 1 && parseFloat(text) <= 5) {
      result.avgRating = text;
      break;
    }
  }

  // Fallback: structural scan — find a standalone decimal number 1.0–5.0
  if (!result.avgRating) {
    result.avgRating = structuralRatingScan();
  }
  console.log(`[Rating Debug] Structural scan found average rating: ${result.avgRating}`);

  // ── Total ratings + reviews ──────────────────────────────────
  // Flipkart shows "1,23,456 Ratings & 12,345 Reviews" or similar
  const totalSelectors = [
    'span._2_R_DZ',
    'div._3eOLFC',
    '._2afOsF span',
    '._1k9JI4',
    '.css-146c3p1', //added on 21st June 2026
  ];

  for (const sel of totalSelectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = el.textContent.trim();
    // e.g. "1,23,456 Ratings & 12,345 Reviews"
    const m = text.replace(/,/g, '').match(/(\d+)\s+Ratings?/i);
    if (m) { result.totalRatings = m[1]; break; }
  }

  // Fallback: scan all spans/divs for "X Ratings" pattern
  if (!result.totalRatings) {
    const all = document.querySelectorAll('span, div');
    for (const el of all) {
      if (el.children.length > 0) continue; // skip non-leaf
      const text = el.textContent.trim();
      const m = text.replace(/,/g, '').match(/^(\d+)\s+Ratings?/i);
      if (m && parseInt(m[1]) > 0) {
        result.totalRatings = m[1];
        break;
      }
    }
  }

  // ── Star breakdown ───────────────────────────────────────────
  // Flipkart shows a bar chart: "5★ 70%", "4★ 15%", etc.
  // Selectors for the rating bars container
  const breakdownSelectors = [
    'div._3c5Uaj',
    'div._1rVxoO',
    '._2A54wS',
  ];

  for (const sel of breakdownSelectors) {
    const container = document.querySelector(sel);
    if (!container) continue;

    const rows = container.querySelectorAll('div[class]');
    const breakdown = {};

    rows.forEach(row => {
      const text = row.textContent.trim();
      const starM = text.match(/^(\d)\s*★/);
      const pctM  = text.match(/(\d+)%/);
      if (starM && pctM) {
        breakdown[starM[1] + '★'] = pctM[1] + '%';
      }
    });

    if (Object.keys(breakdown).length >= 2) {
      result.breakdown = breakdown;
      break;
    }
  }

  // Fallback: structural scan for "5★ XX%" patterns in page text
  if (!result.breakdown) {
    result.breakdown = structuralBreakdownScan();
  }

  return result;
}

// ── Structural rating scan (Flipkart class-agnostic) ──────────
function structuralRatingScan() {
  const allEls = document.querySelectorAll('div, span');
  for (const el of allEls) {
    if (el.children.length > 2) continue;
    const text = el.textContent.trim();
    // A standalone rating number: 1.0 to 5.0, possibly with one decimal
    if (/^\d(\.\d)?$/.test(text)) {
      const val = parseFloat(text);
      if (val >= 1.0 && val <= 5.0) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          // Make sure it's near the top of page (product info area)
          if (rect.top < 800) return text;
        }
      }
    }
  }
  return null;
}

function structuralBreakdownScan() {
  const breakdown = {};
  const bodyText  = document.body.innerText || '';

  // Match patterns like "5★\n70%" or "5 ★  70%" in the page text
  const matches = bodyText.matchAll(/([1-5])\s*★[^\d]*(\d+)%/g);
  for (const m of matches) {
    breakdown[m[1] + '★'] = m[2] + '%';
  }

  return Object.keys(breakdown).length >= 2 ? breakdown : null;
}

// ═══════════════════════════════════════════════════════════════
//  OOS CHECKS
// ═══════════════════════════════════════════════════════════════

function checkAmazonOOS() {
  const el = document.querySelector('#availability');
  if (el) {
    const t = el.textContent.toLowerCase();
    if (t.includes('unavailable') || t.includes('out of stock') || t.includes('currently')) return true;
  }
  return false;
}

function checkFlipkartOOS() {
  const bodyText = document.body.textContent.toLowerCase();
  return bodyText.includes('sold out') || bodyText.includes('notify me');
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

function isValidPrice(text) {
  return text && text.length < 20 && (text.includes('₹') || /^\d[\d,]+$/.test(text));
}

function cleanPrice(text) {
  return text.replace(/\s+/g, ' ').replace(/₹\s*₹/g, '₹').trim();
}

// ═══════════════════════════════════════════════════════════════
//  MAIN POLLING LOOP
// ═══════════════════════════════════════════════════════════════

function extractAllWithPolling() {
  return new Promise((resolve) => {
    const startTime = Date.now();

    // ── waitForPriceStable (NEW v6) ────────────────────────────
    // After a price is first found, we don't resolve immediately.
    // We confirm it matches on the NEXT poll tick (500ms later).
    // This prevents resolving on a transient value during React re-renders
    // where the DOM updates mid-render and flickers through intermediate states.
    let lastSeenPrice = null;

    function attempt() {
      const elapsed   = Date.now() - startTime;
      const isProduct = checkPageIsProduct();

      if (!isProduct && elapsed < 8000) { setTimeout(attempt, POLL_INTERVAL); return; }

      if (!isProduct && elapsed >= 8000) {
        resolve({ price: null, avgRating: null, totalRatings: null, breakdown: null,
                  error: 'Not a product page (URL does not contain /p/ for Flipkart or /dp/ for Amazon)' });
        return;
      }

      // Extract price
      let price = null;
      if (isAmazon())   price = tryAmazonPrice();
      if (isFlipkart()) price = tryFlipkartPrice();

      // Extract ratings (attempt even if price not yet found)
      let ratingData = { avgRating: null, totalRatings: null, breakdown: null };
      if (isAmazon())   ratingData = extractAmazonRatings();
      if (isFlipkart()) ratingData = extractFlipkartRatings();

      // ── Stable price confirmation ──────────────────────────
      // If we see a price, check if it matches what we saw last tick.
      // If it does → DOM has settled → safe to resolve.
      // If it differs → store it and poll one more time.
      if (price) {
        if (price === lastSeenPrice) {
          // Same value two ticks in a row — DOM is stable, resolve now
          resolve({ price, ...ratingData, error: null });
          return;
        }
        // First time seeing this price value — store and wait one more tick
        lastSeenPrice = price;
        setTimeout(attempt, POLL_INTERVAL);
        return;
      }

      // OOS check after 5s
      if (elapsed > 5000) {
        if (isFlipkart() && checkFlipkartOOS()) {
          resolve({ price: null, ...ratingData, error: 'Product sold out / unavailable' });
          return;
        }
        if (isAmazon() && checkAmazonOOS()) {
          resolve({ price: null, ...ratingData, error: 'Product unavailable / out of stock' });
          return;
        }
      }

      if (elapsed >= MAX_WAIT_MS) {
        resolve({ price: null, ...ratingData,
                  error: 'Price element not found after 18s — layout may have changed' });
        return;
      }

      setTimeout(attempt, POLL_INTERVAL);
    }

    attempt();
  });
}

// ═══════════════════════════════════════════════════════════════
//  MESSAGE LISTENER
// ═══════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'extractPrice') {
    extractAllWithPolling().then(sendResponse);
    return true;
  }
});
