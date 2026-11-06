/**
 * Web search for job discovery.
 *
 * Providers, first available wins:
 *   1. serper.dev API      SERPER_API_KEY
 *   2. Google Custom Search JSON API   GOOGLE_CSE_KEY + GOOGLE_CSE_ID
 *   3. google.com in the jobman Chrome profile (a handful of queries per run,
 *      human-paced). If Google shows its "unusual traffic" / CAPTCHA page the
 *      provider stops for the rest of the run — it is never solved or evaded.
 *
 * Every provider returns [{ url, title, snippet, query, provider }].
 * Date filters: `recency` 'd' | 'w' | 'm' (Google tbs=qdr:<x>, CSE dateRestrict).
 */
const logger = require('./logger');

class SearchBlockedError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'SearchBlockedError';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));

async function serper(query, { recency = 'm', num = 20 } = {}) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ q: query, num, gl: 'in', hl: 'en', tbs: `qdr:${recency}` }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`serper ${res.status}`);
  const data = await res.json();
  return (data.organic || []).map((r) => ({ url: r.link, title: r.title || '', snippet: r.snippet || '', query, provider: 'serper' }));
}

async function googleCse(query, { recency = 'm' } = {}) {
  const u = new URL('https://www.googleapis.com/customsearch/v1');
  u.searchParams.set('key', process.env.GOOGLE_CSE_KEY);
  u.searchParams.set('cx', process.env.GOOGLE_CSE_ID);
  u.searchParams.set('q', query);
  u.searchParams.set('num', '10');
  u.searchParams.set('gl', 'in');
  u.searchParams.set('dateRestrict', { d: 'd1', w: 'w1', m: 'm1' }[recency] || 'm1');
  const res = await fetch(u, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`google cse ${res.status}`);
  const data = await res.json();
  return (data.items || []).map((r) => ({ url: r.link, title: r.title || '', snippet: r.snippet || '', query, provider: 'google-cse' }));
}

/** google.com through the user's own Chrome profile. */
function browserGoogle(newPage) {
  let page = null;
  let blocked = '';
  let count = 0;
  async function search(query, { recency = 'm' } = {}) {
    if (blocked) throw new SearchBlockedError(blocked);
    if (!page) page = await newPage();
    if (count++) await sleep(jitter(8000, 15000)); // human pace between queries
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbs=qdr:${recency}&num=20&hl=en&gl=in`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('#search, #captcha-form, form[action*="sorry"]', { timeout: 10_000 }).catch(() => {});
    const state = await page.evaluate(() => {
      const body = document.body ? document.body.innerText : '';
      const isBlock = /\/sorry\//.test(location.pathname) || !!document.querySelector('#captcha-form, iframe[src*="recaptcha"]') || /unusual traffic from your computer/i.test(body);
      const results = [...document.querySelectorAll('#search a[href^="http"]')]
        .filter((a) => a.querySelector('h3'))
        .map((a) => {
          const block = a.closest('[data-hveid], .g, .MjjYud') || a.parentElement;
          const title = a.querySelector('h3').textContent.trim();
          const snippet = (block?.innerText || '').replace(title, '').replace(/\s+/g, ' ').trim().slice(0, 400);
          return { url: a.href, title, snippet };
        });
      return { isBlock, results };
    });
    if (state.isBlock) {
      blocked = 'Google showed its CAPTCHA / unusual-traffic page — Google search stopped for this run (never solved)';
      throw new SearchBlockedError(blocked);
    }
    const seen = new Set();
    return state.results
      .filter((r) => !/^https?:\/\/(www\.)?google\./.test(r.url) && !seen.has(r.url) && seen.add(r.url))
      .map((r) => ({ ...r, query, provider: 'google' }));
  }
  async function close() {
    if (page) await page.close().catch(() => {});
    page = null;
  }
  return { search, close, name: 'google', get blocked() { return blocked; } };
}

/**
 * Build the search client for this run.
 * @param {{ newPage?: () => Promise<import('puppeteer').Page> }} opts
 */
function createSearch({ newPage } = {}) {
  if (process.env.SERPER_API_KEY) return { search: serper, close: async () => {}, name: 'serper' };
  if (process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_ID) return { search: googleCse, close: async () => {}, name: 'google-cse' };
  if (newPage) return browserGoogle(newPage);
  logger.warn('[search] no search provider available (no API key and no browser)');
  return { search: async () => [], close: async () => {}, name: 'none' };
}

module.exports = { createSearch, SearchBlockedError };
