/**
 * Job-detail enrichment: fetch the full description of a listing before an
 * uncertain eligibility decision is made final (see core/evaluate).
 *
 * Strategy per host (probed 2026-11-10):
 *   linkedin.com   public guest endpoint /jobs-guest/jobs/api/jobPosting/<id> (HTTP, no login)
 *   talent.com     the view page carries the description in its HTML (HTTP)
 *   anything else  HTTP first when the page embeds a schema.org JobPosting (JSON-LD),
 *                  else a tab in the bot's logged-in Chrome (Naukri, Wellfound,
 *                  Instahyre, Foundit, Indeed render client-side or refuse plain HTTP).
 *   naukri.com     the JSON API demands a reCAPTCHA — never used; browser only.
 *
 * Safety / politeness:
 *   - bounded concurrency (HTTP and browser pools are separate) and a minimum gap
 *     between two requests to the same host
 *   - every request has a hard timeout; nothing waits unbounded
 *   - a verification / CAPTCHA page is never interacted with: the host is marked
 *     blocked for the rest of the run (circuit breaker) and its jobs are reported
 *     as "needs enrichment", not rejected
 *   - results are cached on disk (data/jd-cache.json) so unchanged jobs are not
 *     fetched again by later runs (incremental mode)
 */
const fs = require('fs');
const path = require('path');
const { Semaphore, sleep } = require('./concurrency');
const { normalizeJobUrl } = require('./dedup');

const DEFAULT_CACHE = path.join(__dirname, '..', '..', 'data', 'jd-cache.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const CACHE_TTL_DAYS = 21;

const BROWSER_SELECTORS = {
  'naukri.com': 'section[class*="job-desc"], [class*="JDC__dang-inner-html"], [class*="job-desc-container"], .dang-inner-html',
  'wellfound.com': '[class*="description" i], [data-test*="JobDescription"]',
  'instahyre.com': '.job-description, #job-description, [class*="job-description"], .description',
  'indeed.com': '#jobDescriptionText',
  'foundit.in': '.jobDescriptionNew, [class*="jobDescription"], [class*="job-description"]',
  'linkedin.com': '[componentkey^="JobDetails_AboutTheJob_"], .jobs-description, .description__text',
  'talent.com': '[class*="jobDescriptionContainer"], [class*="jobDescription"]',
};
const HTTP_FIRST = /(^|\.)(linkedin\.com|talent\.com|greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|myworkdayjobs\.com)$/;
const BROWSER_ONLY = /(^|\.)(naukri\.com|wellfound\.com|instahyre\.com|indeed\.com|foundit\.in)$/;

function stripHtml(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|li|div|h\d|ul|ol|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#x?[0-9a-f]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function hostKey(host) {
  return Object.keys(BROWSER_SELECTORS).find((h) => host === h || host.endsWith(`.${h}`)) || host;
}

/** schema.org JobPosting from JSON-LD blocks in an HTML string. */
function jobPostingFromHtml(html) {
  const blocks = String(html || '').match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocks) {
    const body = b.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    let data;
    try {
      data = JSON.parse(body.trim());
    } catch {
      continue;
    }
    const items = [].concat(data, data?.['@graph'] || []).flat();
    const jp = items.find((x) => x && (x['@type'] === 'JobPosting' || (Array.isArray(x['@type']) && x['@type'].includes('JobPosting'))));
    if (jp?.description) return { text: stripHtml(jp.description), datePosted: jp.datePosted || null, validThrough: jp.validThrough || null };
  }
  return null;
}

/** Host-specific HTML extraction (pure, unit-tested). */
function extractFromHtml(url, html) {
  const host = hostOf(url);
  if (/linkedin\.com$/.test(host)) {
    const m = html.match(/<div[^>]+class="[^"]*(?:description__text|show-more-less-html__markup)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<button|<section)/i);
    const crit = [...html.matchAll(/description__job-criteria-subheader[^>]*>\s*([^<]+?)\s*<\/h3>\s*<span[^>]*>\s*([^<]+?)\s*<\/span>/gi)].map((x) => `${x[1].trim()}: ${x[2].trim()}`);
    if (m) return { text: [stripHtml(m[1]), crit.join('\n')].filter(Boolean).join('\n'), via: 'linkedin-guest' };
  }
  if (/talent\.com$/.test(host)) {
    const m = html.match(/<div[^>]+class="[^"]*jobDescriptionContainer[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
    if (m) return { text: stripHtml(m[1]), via: 'talent-html' };
  }
  const jp = jobPostingFromHtml(html);
  if (jp) return { ...jp, via: 'json-ld' };
  return null;
}

/** HTTP URL to read for a job page (LinkedIn uses its public guest endpoint). */
function httpUrlFor(url) {
  const li = String(url).match(/linkedin\.com\/jobs\/view\/(?:[^/]*-)?(\d+)/);
  if (li) return `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${li[1]}`;
  return url;
}

function looksBlocked({ title = '', text = '', status = 200 }) {
  if (status === 403 || status === 429 || status === 406) return `HTTP ${status}`;
  if (/just a moment|attention required|access denied|security check|are you a robot/i.test(title)) return `verification page ("${title.slice(0, 40)}")`;
  if (/verify you are human|unusual traffic|complete the security check|recaptcha required/i.test(text.slice(0, 3000))) return 'verification page';
  if (/access denied/i.test(title) || /you don.t have permission to access/i.test(text.slice(0, 1500))) return 'access denied (rate limit)';
  return '';
}

function daysSince(iso, now) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86_400_000)) : null;
}

function createEnricher({
  newPage = null,
  fetchImpl = globalThis.fetch,
  cacheFile = DEFAULT_CACHE,
  httpLimit = Number(process.env.JOBMAN_ENRICH_HTTP) || 6,
  browserLimit = Number(process.env.JOBMAN_ENRICH_TABS) || 2,
  httpTimeoutMs = 15_000,
  browserTimeoutMs = 25_000,
  hostGapMs = { http: 600, browser: 2000 },
  useCache = true,
  now = () => Date.now(),
  logger = require('./logger'),
} = {}) {
  const httpPool = new Semaphore(httpLimit, { name: 'enrich-http' });
  const tabPool = new Semaphore(browserLimit, { name: 'enrich-tabs' });
  const lastHit = new Map(); // host → timestamp
  const blockedHosts = new Map(); // host → reason
  const stats = { requests: 0, http: 0, browser: 0, cacheHits: 0, ok: 0, failed: 0, blocked: 0, ms: 0 };
  let cache = {};
  let dirty = false;
  if (useCache) {
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      cache = {};
    }
    // drop expired entries
    const cutoff = now() - CACHE_TTL_DAYS * 86_400_000;
    for (const [k, v] of Object.entries(cache)) if (!v || v.at < cutoff) delete cache[k];
  }

  async function pace(host, kind) {
    const gap = hostGapMs[kind] || 0;
    const prev = lastHit.get(`${kind}:${host}`) || 0;
    const wait = prev + gap - now();
    lastHit.set(`${kind}:${host}`, Math.max(now(), prev + gap));
    if (wait > 0) await sleep(wait);
  }

  async function viaHttp(url) {
    const target = httpUrlFor(url);
    const host = hostOf(target);
    return httpPool.run(async () => {
      await pace(host, 'http');
      stats.http++;
      const res = await fetchImpl(target, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' }, redirect: 'follow', signal: AbortSignal.timeout(httpTimeoutMs) });
      const html = await res.text();
      const blocked = looksBlocked({ status: res.status, title: (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '', text: html });
      if (blocked) return { blocked };
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const got = extractFromHtml(url, html);
      return got && got.text && got.text.length >= 200 ? got : { error: 'no description in page' };
    });
  }

  /** Employer ATS postings: the public JSON APIs the careers channel already uses. */
  async function viaAts(url) {
    const { parseAtsUrl, fetchPosting } = require('./ats');
    const ref = parseAtsUrl(url);
    if (!ref || !ref.jobId) return { error: 'not an ATS posting URL' };
    return httpPool.run(async () => {
      await pace(hostOf(url), 'http');
      stats.http++;
      const p = await fetchPosting({ ...ref, id: ref.jobId, name: ref.token });
      return p && p.text && p.text.length >= 200 ? { text: p.text, datePosted: p.postedAt || p.updatedAt || null, via: `ats-${ref.ats}` } : { error: 'ATS posting has no description' };
    });
  }

  async function viaBrowser(url) {
    if (!newPage) return { error: 'no browser available' };
    const host = hostOf(url);
    const selector = BROWSER_SELECTORS[hostKey(host)] || '';
    return tabPool.run(async () => {
      await pace(host, 'browser');
      stats.browser++;
      let page;
      try {
        page = await newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: browserTimeoutMs });
        if (selector) await page.waitForSelector(selector, { timeout: Math.min(10_000, browserTimeoutMs) }).catch(() => {});
        const got = await page.evaluate((sel) => {
          const title = document.title || '';
          const strip = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d.innerText || d.textContent || ''; };
          for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
            try {
              const data = JSON.parse(s.textContent);
              const items = [].concat(data, data['@graph'] || []).flat();
              const jp = items.find((x) => x && [].concat(x['@type']).includes('JobPosting'));
              if (jp && jp.description) return { title, text: strip(jp.description), datePosted: jp.datePosted || null, via: 'json-ld' };
            } catch { /* ignore */ }
          }
          if (sel) {
            const els = Array.from(document.querySelectorAll(sel)).filter((e) => (e.innerText || '').length > 150);
            els.sort((a, b) => b.innerText.length - a.innerText.length);
            if (els[0]) return { title, text: els[0].innerText, via: 'selector' };
          }
          // generic: the largest element whose class/id says "desc"
          const cands = Array.from(document.querySelectorAll('[class*="desc" i], [id*="desc" i]')).filter((e) => (e.innerText || '').length > 300 && (e.innerText || '').length < 30000);
          cands.sort((a, b) => b.innerText.length - a.innerText.length);
          return { title, text: cands[0] ? cands[0].innerText : '', body: (document.body ? document.body.innerText : '').slice(0, 3000), via: 'generic' };
        }, selector);
        const blocked = looksBlocked({ title: got.title, text: got.body || got.text || '' });
        if (blocked && (!got.text || got.text.length < 200)) return { blocked };
        return got.text && got.text.length >= 200 ? { text: got.text.slice(0, 12000), datePosted: got.datePosted, via: `browser-${got.via}` } : { error: 'description not found on page' };
      } finally {
        if (page) await page.close().catch(() => {});
      }
    });
  }

  /**
   * @param {{ url: string, description?: string }} job
   * @returns {Promise<{ ok, text?, via?, postedDaysAgo?, cached?, error?, blocked?, ms }>}
   */
  async function enrich(job) {
    const t0 = now();
    const url = job.url;
    const key = normalizeJobUrl(url) || url;
    const host = hostOf(url);
    stats.requests++;
    const done = (r) => {
      const ms = now() - t0;
      stats.ms += ms;
      if (r.ok) stats.ok++;
      else if (r.blocked) stats.blocked++;
      else stats.failed++;
      return { ...r, ms };
    };
    // job.fresh: the caller needs proof the posting is live NOW (auto-apply gate).
    if (useCache && !job.fresh && cache[key]?.text) {
      stats.cacheHits++;
      const c = cache[key];
      return done({ ok: true, text: c.text, via: `cache(${c.via})`, cached: true, postedDaysAgo: daysSince(c.datePosted, now()) });
    }
    if (!url || !host) return done({ ok: false, error: 'no URL' });
    if (blockedHosts.has(hostKey(host))) return done({ ok: false, blocked: `host paused earlier this run — ${blockedHosts.get(hostKey(host))}` });

    const isAts = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|myworkdayjobs\.com)$/.test(host);
    const attempts = BROWSER_ONLY.test(host) ? ['browser'] : isAts ? ['ats', 'http', 'browser'] : ['http', 'browser'];
    let last = { error: 'not attempted' };
    for (const how of attempts) {
      try {
        last = how === 'ats' ? await viaAts(url) : how === 'http' ? await viaHttp(url) : await viaBrowser(url);
      } catch (err) {
        last = err.closed ? { error: 'posting closed (ATS)', closed: true } : { error: /timeout|aborted/i.test(err.message) ? 'timeout' : err.message.slice(0, 80) };
        if (err.closed) break;
      }
      if (last.text) break;
      if (last.blocked && how === 'browser') break;
    }
    if (last.text) {
      const entry = { text: last.text, via: last.via, datePosted: last.datePosted || null, at: now() };
      if (useCache) {
        cache[key] = entry;
        dirty = true;
      }
      return done({ ok: true, text: last.text, via: last.via, postedDaysAgo: daysSince(last.datePosted, now()) });
    }
    if (last.blocked) {
      if (!blockedHosts.has(hostKey(host))) logger.warn(`[enrich] ${hostKey(host)} showed a verification page (${last.blocked}) — no further detail fetches for it this run; affected jobs are reported as "needs enrichment"`);
      blockedHosts.set(hostKey(host), last.blocked);
      return done({ ok: false, blocked: last.blocked });
    }
    return done({ ok: false, error: last.error });
  }

  function flush() {
    if (!useCache || !dirty) return;
    try {
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(cache));
      fs.renameSync(tmp, cacheFile);
      dirty = false;
    } catch (err) {
      logger.warn(`[enrich] cache not saved: ${err.message}`);
    }
  }

  /** Seed the cache with a description a bot already read (e.g. Foundit's detail panel). */
  function remember(url, text, via = 'bot') {
    const key = normalizeJobUrl(url) || url;
    if (!useCache || !text || text.length < 200) return;
    cache[key] = { text: String(text).slice(0, 12000), via, datePosted: null, at: now() };
    dirty = true;
  }

  return { enrich, flush, remember, stats, blockedHosts, httpPool, tabPool };
}

module.exports = { createEnricher, extractFromHtml, jobPostingFromHtml, httpUrlFor, looksBlocked, stripHtml, hostOf };
