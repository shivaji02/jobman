/**
 * Foundit (foundit.in, formerly Monster India) bot.
 *
 * Search:  https://www.foundit.in/srp/results?query=<q>&locations=<city>
 * The results page is an SPA: clicking a card opens its detail panel on the
 * right, which has an "Apply Now" button (#applyNowBtn). Cards carry the job id
 * in the element id and have no hrefs, so the dedup key is the synthetic
 * https://www.foundit.in/job/<id>.
 *
 * Policy:
 *   - logged out ("Please login/register to" banner, password field, login
 *     modal) → SkipPortalError, never enter credentials
 *   - Apply Now confirmed ("Applied" state / success text) → applied
 *   - Apply opens an external site in a new tab → manual-apply, tab left open
 *   - Apply Now clicked but no success state → unconfirmed (never re-clicked:
 *     the old retry re-pressed Apply Now after an uncertain submit)
 *   - Apply Now button missing → failed (retried once — nothing was submitted)
 */
const { humanDelay, blockHeavyAssets, checkForCaptcha, SkipPortalError, createTabTracker, closePageQuietly } = require('../core/browser');
const { withRetry, isTransientError } = require('../core/retry');
const { scoreJob, shouldApply, parseExperienceRange } = require('../core/filter');
const { classifyLocation, byLocationPreference, SEARCH_CITIES } = require('../core/location');
const { selectResume, RESUME_RN, RESUME_FS } = require('./wellfound');
const logger = require('../core/logger');
const { capture, evidenceNote } = require('../core/evidence');
const { emptyResults, admit, claimGate, offerIfUncertain } = require('../core/disposition');

const QUERIES = [
  'react native developer',
  'react native engineer',
  'react native',
  'cross platform mobile developer',
  'mobile developer',
  'react developer',
  'full stack developer node react',
];
const MAX_APPS_PER_RUN = Number(process.env.JOBMAN_MAX_APPS) || 30;
const SITE = 'Foundit';

function searchUrl(query, city = 'Hyderabad') {
  return `https://www.foundit.in/srp/results?query=${encodeURIComponent(query)}&locations=${encodeURIComponent(city.toLowerCase())}`;
}

function jobKey(id) {
  return `https://www.foundit.in/job/${id}`;
}

async function dismissCookies(page) {
  await page
    .evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, a, div')).find(
        (b) => b.children.length === 0 && /^okay$/i.test((b.textContent || '').trim())
      );
      if (btn) btn.click();
    })
    .catch(() => {});
}

function isLoggedOut(page) {
  return page.evaluate(() => /please login\/register to/i.test(document.body.innerText));
}

async function extractCards(page) {
  return page.evaluate(() => {
    const clean = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
    const seen = new Set();
    return Array.from(document.querySelectorAll('.cardContainer[id]'))
      .map((card, index) => ({
        index,
        id: card.id,
        title: clean(card.querySelector('.jobTitle')),
        company: clean(card.querySelector('.companyName')),
        experienceText: clean(card.querySelector('.experienceSalary .details')),
        location: clean(card.querySelector('.location')),
        text: clean(card).slice(0, 1200),
      }))
      .filter((c) => c.id && c.title && !seen.has(c.id) && seen.add(c.id));
  });
}

/** Open a card's detail panel and read the job description for scoring/resume choice. */
async function openCard(page, id) {
  const opened = await page.evaluate((id) => {
    const card = document.getElementById(id);
    const title = card?.querySelector('.jobTitle');
    if (!title) return false;
    title.click();
    return true;
  }, id);
  if (!opened) throw new Error('card not found in results list');
  await page.waitForSelector('#applyNowBtn, .jobDescriptionNew', { timeout: 8000 }).catch(() => {});
  return page.evaluate(() => (document.querySelector('.jobDescriptionNew')?.innerText || '').slice(0, 4000));
}

/** Click the visible Apply Now button; returns the button label seen, or '' if absent. */
function clickApplyNow(page) {
  return page.evaluate(() => {
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight);
    const btn = Array.from(document.querySelectorAll('#applyNowBtn')).find(visible);
    if (!btn) return '';
    const label = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    if (/^applied$/i.test(label)) return label;
    btn.click();
    return label;
  });
}

async function applyToCard(page, browser, card) {
  const pagesBefore = new Set(await browser.pages());
  const label = await clickApplyNow(page);
  if (!label) return { status: 'failed', reason: 'Apply Now button not found' };
  if (/^applied$/i.test(label)) return { status: 'already-applied' };

  // Wait for a definite outcome instead of a fixed sleep.
  const outcome = await page
    .waitForFunction(
      () => {
        const visible = (el) => !!(el.offsetWidth || el.offsetHeight);
        if (Array.from(document.querySelectorAll('input[type="password"]')).some(visible)) return 'login';
        const btn = Array.from(document.querySelectorAll('#applyNowBtn')).find(visible);
        if (btn && /^applied$/i.test((btn.textContent || '').trim())) return 'applied';
        const text = document.body.innerText;
        if (/applied successfully|successfully applied|you have applied|application (has been )?(sent|submitted)/i.test(text)) return 'applied';
        if (/please login\/register to apply|login to apply/i.test(text) && document.querySelector('[class*="login"] input')) return 'login';
        return false;
      },
      { timeout: 6000, polling: 250 }
    )
    .then((h) => h.jsonValue())
    .catch(() => '');

  if (outcome === 'login') throw new SkipPortalError('login required — sign in once via `npm run login`');
  if (outcome === 'applied') {
    return { status: 'applied', evidence: await capture(page, { portal: 'foundit', jobKey: jobKey(card.id), signal: 'Apply Now → "Applied" state / success text' }) };
  }

  // Apply may have opened the employer's site in a new tab.
  const opened = (await browser.pages()).find(
    (p) => !pagesBefore.has(p) && p.target().opener() === page.target() && p.url() && p.url() !== 'about:blank'
  );
  if (opened) return { status: 'manual-apply', page: opened, companyUrl: opened.url() };

  await checkForCaptcha(page);
  return { status: 'unconfirmed', reason: 'Apply Now clicked; no "Applied" state (extra questions or unknown state)' };
}

/** Submit an approved Foundit job by its persisted detail URL, without searching. */
async function applyApprovedJob(browser, job) {
  let parsed;
  try { parsed = new URL(job.url); } catch { return { status: 'manual-apply', submitted: false, reason: 'saved Foundit URL is invalid; no application action taken' }; }
  if (!/(^|\.)foundit\.in$/i.test(parsed.hostname) || !/^\/job\/[^/]+\/?$/.test(parsed.pathname)) {
    return { status: 'manual-apply', submitted: false, reason: 'saved Foundit URL is not a direct job detail URL; no application action taken' };
  }
  const page = await browser.newPage();
  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    try { await checkForCaptcha(page); } catch (err) {
      return { status: 'manual-apply', submitted: false, page, reason: `Foundit verification barrier; complete it in the open tab: ${err.message}` };
    }
    const state = await page.evaluate(() => ({
      text: (document.body?.innerText || '').slice(0, 5000),
      title: document.querySelector('.jobTitle')?.textContent?.trim() || document.querySelector('h1')?.textContent?.trim() || '',
      company: document.querySelector('.companyName')?.textContent?.trim() || '',
      apply: !!document.querySelector('#applyNowBtn'),
    }));
    if (/please login\/register to apply|login to apply/i.test(state.text) || await page.$('input[type="password"]')) {
      return { status: 'manual-apply', submitted: false, page, reason: 'Foundit requires sign-in; complete it in the open tab' };
    }
    const contains = (haystack, needle) => !needle || haystack.toLowerCase().includes(String(needle).toLowerCase());
    if (!contains(state.text, job.title) || !contains(state.text, job.company) || !state.apply) {
      return { status: 'manual-apply', submitted: false, page, reason: 'could not verify the saved job title, employer, and Apply control on its direct page; no click made' };
    }
    const outcome = await applyToCard(page, browser, { id: parsed.pathname.split('/').filter(Boolean).at(-1), title: job.title, company: job.company });
    if (outcome.status === 'applied' || outcome.status === 'already-applied' || (outcome.status === 'manual-apply' && outcome.page)) await page.close().catch(() => {});
    else if (outcome.status === 'unconfirmed') outcome.page = page;
    return outcome;
  } catch (err) {
    if (/captcha|verification/i.test(err.message)) return { status: 'unconfirmed', submitted: true, page, reason: `verification barrier after opening the approved posting: ${err.message}` };
    await page.close().catch(() => {});
    return { status: 'failed', submitted: false, reason: err.message };
  }
}

function log(dedup, dryRun, card, status, notes) {
  if (dryRun) return;
  dedup.append({ site: SITE, job_title: card.title, company: card.company, job_url: jobKey(card.id), status, notes });
}

/**
 * Wait for the results list to settle: cards, an explicit "no results" message, or
 * a loaded page that stays card-less for QUIET_MS. Run 2026-11-09: every zero-result
 * query sat out the full 15 s selector timeout (25 of 40 queries → ~6.5 min).
 */
const SETTLE_TIMEOUT_MS = 12_000;
const QUIET_MS = 2_500;
async function waitForResults(page) {
  return page
    .waitForFunction(
      (quietMs) => {
        if (document.querySelector('.cardContainer[id]')) return 'cards';
        const text = (document.body && document.body.innerText) || '';
        // Foundit's CDN answers rapid searches with "Access Denied" (2026-11-10). That is a
        // refusal, not an empty result — never count it as "0 cards".
        if (/access denied|you don.t have permission to access/i.test(`${document.title} ${text.slice(0, 400)}`)) return 'blocked';
        if (/no (matching )?(jobs|results) (were )?found|we couldn.?t find|0 jobs found|did not match any/i.test(text)) return 'empty';
        if (document.readyState === 'complete') {
          window.__jobmanQuietSince = window.__jobmanQuietSince || Date.now();
          if (Date.now() - window.__jobmanQuietSince > quietMs) return 'quiet';
        }
        return false;
      },
      { timeout: SETTLE_TIMEOUT_MS, polling: 200 },
      QUIET_MS
    )
    .then((h) => h.jsonValue())
    .catch((err) => (/detached|context was destroyed|Target closed|Session closed/i.test(err.message) ? Promise.reject(err) : 'timeout'));
}

/** Errors that mean "this page/frame handle is dead" — recover by opening a fresh tab. */
function isPageLost(err) {
  return /detached Frame|Execution context was destroyed|Target closed|Session closed|Protocol error|frame was detached|page has been closed|Cannot find context/i.test(err?.message || '');
}

const MAX_DEFERRED_RETRIES = 1;
/** Pause between two searches. The old 15 s empty-result timeouts throttled Foundit by accident; without them it rate-limits us. */
const SEARCH_GAP_MS = Number(process.env.JOBMAN_FOUNDIT_GAP_MS) >= 0 && process.env.JOBMAN_FOUNDIT_GAP_MS != null ? Number(process.env.JOBMAN_FOUNDIT_GAP_MS) : 3000;
let lastSearchAt = 0;
async function paceSearch() {
  const wait = lastSearchAt + SEARCH_GAP_MS + Math.random() * (SEARCH_GAP_MS / 2) - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSearchAt = Date.now();
}

async function run({ profile = {}, dedup, dryRun, newPage, browser, approvedJobs = [], pipeline = null, portal = 'foundit', resume: state = null }) {
  // Resumable within a run: a portal retried after a crash continues where it stopped
  // (same results, same seen-set, finished searches skipped) — no job is processed twice.
  const st = state || {};
  const results = (st.results = st.results || emptyResults());
  const doneSearches = (st.doneSearches = st.doneSearches || new Set());
  const seenThisRun = (st.seen = st.seen || new Set());
  const searchLog = (results.searchLog = results.searchLog || []);
  const tabs = createTabTracker('foundit');
  let page = null;
  let pagesOpened = 0;

  async function freshPage(reason) {
    if (page) await closePageQuietly(page);
    page = await newPage();
    pagesOpened++;
    await blockHeavyAssets(page);
    if (reason) logger.warn(`[foundit] reacquired a fresh tab (${reason})`);
    return page;
  }
  const capReached = () => results.applied.length + results.unconfirmed.length + results.manualApply.length >= MAX_APPS_PER_RUN;

  /** One search: navigate, settle, extract, screen every card. Throws only SkipPortalError or page-lost errors. */
  async function runSearch({ city, query }) {
    await paceSearch();
    const t0 = Date.now();
    await withRetry(() => page.goto(searchUrl(query, city), { waitUntil: 'domcontentloaded', timeout: 20_000 }), { maxAttempts: 2 });
    const settled = await waitForResults(page);
    if (settled === 'blocked') {
      searchLog.push({ query, city, cards: 0, ms: Date.now() - t0, settled });
      throw new SkipPortalError(
        `paused — Foundit refused requests ("Access Denied" from its CDN) at "${query}" in ${city}; nothing was bypassed. ${doneSearches.size} searches finished and their jobs are kept; the rest run next time (--resume or the next run)`
      );
    }
    await dismissCookies(page);
    await checkForCaptcha(page);
    if (!dryRun && (await isLoggedOut(page))) {
      throw new SkipPortalError('login required — sign in once via `npm run login`');
    }
    const cards = settled === 'cards' ? (await extractCards(page)).sort(byLocationPreference) : [];
    results.discovered += cards.length;
    const ms = Date.now() - t0;
    searchLog.push({ query, city, cards: cards.length, ms, settled });
    logger.info(`[foundit] "${query}" in ${city}: ${cards.length} cards (${(ms / 1000).toFixed(1)}s, ${settled})`);

    for (const card of cards) {
      const key = jobKey(card.id);
      const job = { title: card.title, company: card.company, url: key, location: card.location };
      if (admit(results, { key, seen: seenThisRun, dedup, job, site: SITE, dryRun }) !== 'new') continue;
      const loc = classifyLocation(card.location, card.company);
      const range = parseExperienceRange(card.experienceText);
      const score = scoreJob({ title: card.title, description: card.text, experienceText: card.experienceText });

      let skipReason = '';
      if (!loc.allowed) skipReason = loc.reason;
      else if (range && (range.min > 3.5 || range.max < 1.5)) skipReason = `experience ${card.experienceText} out of range`;
      else if (!shouldApply(score)) skipReason = `score ${score} below threshold`;
      else if (capReached()) skipReason = 'per-run cap reached';

      // Inconclusive card: the detail panel on this same page has the full description.
      if (/below threshold/.test(skipReason) && pipeline) {
        const description = await openCard(page, card.id).catch((err) => {
          if (isPageLost(err)) throw err;
          return '';
        });
        if (description && description.length >= 200) {
          pipeline.offer(portal, job, { text: card.text, experienceText: card.experienceText, location: card.location, description, site: SITE });
          continue;
        }
        if (offerIfUncertain(pipeline, portal, job, card, SITE)) continue;
      }
      if (skipReason) {
        job.reason = skipReason;
        results.skipped.push(job);
        if (!/cap reached/.test(skipReason)) log(dedup, dryRun, card, 'skipped', skipReason);
        continue;
      }

      // Eligible on the card: read the panel now so the pipeline decides on the full posting.
      const offerDescription = pipeline ? await openCard(page, card.id).catch((err) => { if (isPageLost(err)) throw err; return ''; }) : '';
      if (!(await claimGate(results, dedup, key, job, { dryRun, approvedJobs, pipeline, portal, offer: { text: card.text, experienceText: card.experienceText, location: card.location, description: offerDescription, site: SITE } }))) continue;

      if (dryRun) {
        job.resume = selectResume(card.title, card.text);
        job.reason = `would apply (score ${score}; resume=${job.resume})`;
        results.applied.push(job);
        logger.info(`[foundit] DRY RUN would apply: ${card.title} @ ${card.company} (score ${score})`);
        continue;
      }

      let outcome;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const description = await openCard(page, card.id);
          job.resume = selectResume(card.title, `${card.text} ${description}`);
          outcome = await applyToCard(page, browser, card);
        } catch (err) {
          if (err instanceof SkipPortalError || isPageLost(err)) throw err;
          outcome = { status: 'failed', reason: err.message };
        }
        if (outcome.status !== 'failed' || attempt === 2) break;
        logger.warn(`[foundit] attempt ${attempt} failed for "${card.title}": ${outcome.reason}`);
        await page.keyboard.press('Escape').catch(() => {});
        await humanDelay(1500, 2500);
      }

      if (outcome.status === 'applied') {
        job.evidence = outcome.evidence;
        results.applied.push(job);
        log(dedup, dryRun, card, 'applied', `auto-applied (score ${score}; resume=${job.resume}) | ${evidenceNote(outcome.evidence)}`);
        console.log(`✅ Applied (confirmed): ${card.title} @ ${card.company}`);
      } else if (outcome.status === 'unconfirmed') {
        job.reason = outcome.reason;
        results.unconfirmed.push(job);
        tabs.trackFailed(job, key);
        log(dedup, dryRun, card, 'unconfirmed', outcome.reason);
      } else if (outcome.status === 'already-applied') {
        job.reason = 'already applied on Foundit';
        results.alreadyApplied.push(job);
        log(dedup, dryRun, card, 'applied', 'already applied on Foundit');
        continue; // nothing submitted — no rate-limit delay
      } else if (outcome.status === 'manual-apply') {
        const entry = { ...job, companyUrl: outcome.companyUrl };
        results.manualApply.push(entry);
        tabs.trackManualApply(entry, entry.companyUrl);
        log(dedup, dryRun, card, 'manual-apply', `URL: ${entry.companyUrl} | Resume: ${job.resume}`);
        logger.info(`[foundit] → Tab OPEN and ready for manual apply: ${card.title} @ ${card.company}`);
      } else {
        job.reason = outcome.reason || 'apply failed';
        results.failed.push(job);
        tabs.trackFailed(job, key);
        log(dedup, dryRun, card, 'failed', job.reason);
      }
      await page.keyboard.press('Escape').catch(() => {});
      await humanDelay();
    }
  }

  try {
    await freshPage();
    const searches = SEARCH_CITIES.flatMap((city) => QUERIES.map((query) => ({ city, query, id: `${city}|${query}` })));
    let queue = searches.filter((s) => !doneSearches.has(s.id));
    // Bounded deferred retries: a search broken by a lost frame / navigation is retried
    // after the others (fresh tab), at most MAX_DEFERRED_RETRIES times, then reported.
    for (let round = 0; round <= MAX_DEFERRED_RETRIES && queue.length; round++) {
      const deferred = [];
      for (const s of queue) {
        if (capReached()) break;
        try {
          await runSearch(s);
          doneSearches.add(s.id);
        } catch (err) {
          if (err instanceof SkipPortalError || err.name === 'SkipPortalError' || err.name === 'ShutdownError') throw err;
          if (!isPageLost(err) && !isTransientError(err)) throw err;
          deferred.push(s);
          searchLog.push({ query: s.query, city: s.city, cards: 0, ms: 0, settled: `error: ${err.message.slice(0, 60)}` });
          logger.warn(`[foundit] "${s.query}" in ${s.city} broke (${err.message.slice(0, 70)}) — ${round < MAX_DEFERRED_RETRIES ? 'deferred for one retry' : 'giving up on this search'}`);
          await freshPage('previous tab lost its frame');
        }
      }
      queue = deferred;
      if (deferred.length && round < MAX_DEFERRED_RETRIES) await humanDelay(1000, 2000);
    }
    if (queue.length) {
      results.searchFailures = queue.map((s) => `${s.query} @ ${s.city}`);
      results.note = `${queue.length} search(es) failed after a retry: ${results.searchFailures.join(', ')}`;
    }
    if (pagesOpened > 1) logger.info(`[foundit] recovered from ${pagesOpened - 1} lost tab(s) without restarting the portal`);
  } catch (err) {
    tabs.printSummary();
    err.partialResults = results;
    throw err;
  } finally {
    await closePageQuietly(page);
  }

  tabs.printSummary();
  return results;
}

module.exports = { run, searchUrl, jobKey, extractCards, waitForResults, isPageLost, openCard, applyToCard, applyApprovedJob, RESUME_RN, RESUME_FS };
