/**
 * Proof of submission. An application only counts as `applied` when the portal
 * itself showed a success signal; we keep what we saw:
 *   - the signal (matched success text or "Applied" control state)
 *   - the page URL at that moment
 *   - a screenshot under data/evidence/YYYY-MM-DD/
 *
 * If a submit was clicked but no signal appears, callers must record the job as
 * `unconfirmed` (blocking in dedup) — never `failed`, which would be retried and
 * could submit a duplicate application.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EVIDENCE_DIR = path.join(__dirname, '..', '..', 'data', 'evidence');

function istDate(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** Generic success copy used across portals. Portal-specific signals are passed in. */
const GENERIC_SUCCESS = [
  'application (?:has been )?(?:sent|submitted)',
  'your application was sent',
  'successfully (?:applied|submitted)',
  'applied successfully',
  'thanks? (?:you )?for applying',
  "we(?:'|’)?ve received your application",
];

/**
 * Wait for a success signal on `page`.
 * @param {import('puppeteer').Page} page
 * @param {{ text?: string[], selector?: string, timeoutMs?: number }} [signals]
 *   text: extra regex sources (case-insensitive) matched against body text
 *   selector: CSS selector whose presence (visible) proves submission, e.g. '#already-applied'
 * @returns {Promise<string|null>} the matched signal, or null
 */
async function waitForSuccess(page, { text = [], selector = '', timeoutMs = 8000 } = {}) {
  const sources = [...text, ...GENERIC_SUCCESS];
  try {
    const handle = await page.waitForFunction(
      (sources, selector) => {
        if (selector) {
          const el = document.querySelector(selector);
          if (el && (el.offsetWidth || el.offsetHeight)) return `selector ${selector}: ${(el.textContent || '').trim().slice(0, 60)}`;
        }
        const body = (document.body && document.body.innerText) || '';
        for (const src of sources) {
          const m = body.match(new RegExp(src, 'i'));
          if (m) return `text "${m[0]}"`;
        }
        return false;
      },
      { timeout: timeoutMs, polling: 300 },
      sources,
      selector
    );
    return await handle.jsonValue();
  } catch {
    return null;
  }
}

/**
 * Save a screenshot + signal for a confirmed application.
 * Returns { signal, url, screenshot, at } — attach as `job.evidence`.
 */
async function capture(page, { portal, jobKey, signal }) {
  const at = new Date().toISOString();
  let url = '';
  try {
    url = page.url();
  } catch {
    // page gone
  }
  let screenshot = '';
  try {
    const dir = path.join(EVIDENCE_DIR, istDate());
    fs.mkdirSync(dir, { recursive: true });
    const id = crypto.createHash('sha1').update(String(jobKey)).digest('hex').slice(0, 10);
    screenshot = path.join(dir, `${portal}-${id}.png`);
    await page.screenshot({ path: screenshot, fullPage: false });
  } catch {
    screenshot = '';
  }
  return { signal, url, screenshot, at };
}

/** One-line CSV note for an evidence object. */
function evidenceNote(ev) {
  if (!ev) return '';
  return `evidence: ${ev.signal}${ev.screenshot ? ` | shot: ${path.relative(path.join(__dirname, '..', '..'), ev.screenshot)}` : ''}`;
}

module.exports = { waitForSuccess, capture, evidenceNote, EVIDENCE_DIR, GENERIC_SUCCESS };
