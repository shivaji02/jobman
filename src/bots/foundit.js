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
const { withRetry } = require('../core/retry');
const { scoreJob, shouldApply, parseExperienceRange } = require('../core/filter');
const { classifyLocation, byLocationPreference, SEARCH_CITIES } = require('../core/location');
const { selectResume, RESUME_RN, RESUME_FS } = require('./wellfound');
const logger = require('../core/logger');
const { capture, evidenceNote } = require('../core/evidence');
const { emptyResults, admit, claimGate } = require('../core/disposition');

const QUERIES = [
  'react native developer',
  'react native engineer',
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

function log(dedup, dryRun, card, status, notes) {
  if (dryRun) return;
  dedup.append({ site: SITE, job_title: card.title, company: card.company, job_url: jobKey(card.id), status, notes });
}

async function run({ profile = {}, dedup, dryRun, newPage, browser }) {
  const results = emptyResults();
  const seenThisRun = new Set();
  const tabs = createTabTracker('foundit');
  const page = await newPage();
  await blockHeavyAssets(page);

  try {
    const searches = SEARCH_CITIES.flatMap((city) => QUERIES.map((query) => ({ city, query })));
    for (const { city, query } of searches) {
      if (results.applied.length + results.unconfirmed.length + results.manualApply.length >= MAX_APPS_PER_RUN) break;

      await withRetry(() => page.goto(searchUrl(query, city), { waitUntil: 'domcontentloaded' }), { maxAttempts: 2 });
      await page.waitForSelector('.cardContainer[id]', { timeout: 15000 }).catch(() => {});
      await dismissCookies(page);
      await checkForCaptcha(page);
      if (!dryRun && (await isLoggedOut(page))) {
        throw new SkipPortalError('login required — sign in once via `npm run login`');
      }

      const cards = (await extractCards(page)).sort(byLocationPreference);
      results.discovered += cards.length;
      logger.info(`[foundit] "${query}" in ${city}: ${cards.length} cards`);

      for (const card of cards) {
        const key = jobKey(card.id);
        const job = { title: card.title, company: card.company, url: key };
        if (admit(results, { key, seen: seenThisRun, dedup, job, site: SITE, dryRun }) !== 'new') continue;
        const loc = classifyLocation(card.location, card.company);
        const range = parseExperienceRange(card.experienceText);
        const score = scoreJob({ title: card.title, description: card.text, experienceText: card.experienceText });

        let skipReason = '';
        if (!loc.allowed) skipReason = loc.reason;
        else if (range && (range.min > 3.5 || range.max < 1.5)) skipReason = `experience ${card.experienceText} out of range`;
        else if (!shouldApply(score)) skipReason = `score ${score} below threshold`;
        else if (results.applied.length + results.unconfirmed.length + results.manualApply.length >= MAX_APPS_PER_RUN) skipReason = 'per-run cap reached';
        if (skipReason) {
          job.reason = skipReason;
          results.skipped.push(job);
          if (!/cap reached/.test(skipReason)) log(dedup, dryRun, card, 'skipped', skipReason);
          continue;
        }

        // Parallel runs: atomically claim the job across portal workers (no-op otherwise).
        if (!(await claimGate(results, dedup, key, job))) continue;

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
            if (err instanceof SkipPortalError) throw err;
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

module.exports = { run, searchUrl, jobKey, extractCards, RESUME_RN, RESUME_FS };
