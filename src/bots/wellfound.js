/**
 * Wellfound bot (formerly AngelList Talent) — startup roles.
 *
 * Listing URLs that work without networkidle:
 *   https://wellfound.com/role/l/<role-slug>/india
 * Job detail: https://wellfound.com/jobs/<id>-<slug>
 *
 * Apply opens an on-site form. If the form asks to set a password (logged-out
 * signup), we skip — never store/enter passwords. Fill only profile-backed
 * fields (name, email, experience, optional CTC).
 */
const { humanDelay, checkForCaptcha, SkipPortalError, createTabTracker, settleAttemptPages, closePageQuietly } = require('../core/browser');
const { withRetry, isUiError } = require('../core/retry');
const { scoreJob, shouldApply } = require('../core/filter');
const logger = require('../core/logger');
const { waitForSuccess, capture, evidenceNote } = require('../core/evidence');
const { emptyResults, admit } = require('../core/disposition');
const { classifyLocation, byLocationPreference } = require('../core/location');

const QUERIES = [
  'react native developer',
  'mobile developer',
  'frontend engineer react',
  'full stack developer node react',
];
const MAX_APPS_PER_RUN = Number(process.env.JOBMAN_MAX_APPS) || 30;
const { RESUME_RN, RESUME_FS, selectResume: pickResume } = require('../core/resume');

class ExternalAtsError extends Error {
  constructor(companyUrl = '') {
    const url = companyUrl || '';
    super(url ? `manual-apply — external apply: ${url}` : 'manual-apply — external or manual apply');
    this.name = 'ExternalAtsError';
    this.companyUrl = url;
  }
}

function selectResume(jobTitle = '', jobText = '') {
  return pickResume(jobTitle, jobText);
}

function normalizeExternalUrl(url, currentUrl = '') {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const absolute = new URL(raw, currentUrl || 'https://wellfound.com').href;
    if (/wellfound\.com/i.test(absolute)) return '';
    return absolute.replace(/[.,;]+$/, '');
  } catch {
    return '';
  }
}

function extractCompanyUrl(error) {
  if (!error) return '';
  if (error.companyUrl) return String(error.companyUrl);
  const msg = String(error.message || error);
  const match = msg.match(/https?:\/\/[^\s)\]|'"]+/i);
  return normalizeExternalUrl(match?.[0] || '');
}

function buildManualApplyEntry(job, companyUrl = '') {
  const resume = selectResume(job.title, job.text);
  const url = companyUrl || job.url || '';
  const entry = {
    title: job.title,
    company: job.company,
    url: job.url,
    companyUrl: url,
    resume,
    reason: `manual-apply — external/manual apply | Resume: ${resume}`,
  };
  const line = `⚠️  Manual Apply: ${job.title} @ ${job.company} | URL: ${url} | Resume: ${resume}`;
  console.log(line);
  logger.info(`[wellfound] [manual-apply] ${job.title} @ ${job.company} | URL: ${url} | Resume: ${resume}`);
  return entry;
}

/**
 * DataDome often returns HTTP 403 with an empty shell (no captcha iframe in the
 * accessible DOM) — checkForCaptcha() misses that. Detect empty / blocked pages
 * before waiting for job cards.
 */
async function assertPageNotBlocked(page) {
  const state = await page.evaluate(() => {
    const body = document.body;
    const text = (body?.innerText || '').toLowerCase();
    const html = (document.documentElement?.outerHTML || '').toLowerCase();
    const hasDataDomeFrame = !!document.querySelector(
      'iframe[src*="captcha-delivery"], iframe[src*="datadome"]'
    );
    return {
      title: document.title || '',
      textLen: text.trim().length,
      textSample: text.slice(0, 200),
      htmlHasDataDome: /datadome|captcha-delivery|geo\.captcha/.test(html),
      hasDataDomeFrame,
    };
  });

  const blocked =
    state.hasDataDomeFrame ||
    state.htmlHasDataDome ||
    /datadome|access denied|please enable cookies|robot|blocked/i.test(state.textSample) ||
    /datadome|access denied/i.test(state.title) ||
    // Empty shell after 403: title stays "wellfound.com", almost no body text
    (state.textLen < 100 && /wellfound\.com/i.test(state.title));

  if (blocked) {
    throw new SkipPortalError(
      'DataDome / bot challenge on Wellfound — session may be stale. Try: npm run login'
    );
  }
}

/** Map free-text queries to Wellfound role URL slugs. */
function roleSlugForQuery(query) {
  const q = query.toLowerCase();
  if (/react native|mobile/.test(q)) return 'react-native';
  if (/frontend|front-end|react/.test(q)) return 'frontend-engineer';
  if (/full.?stack|node/.test(q)) return 'full-stack-engineer';
  if (/backend/.test(q)) return 'backend-engineer';
  return query
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function searchUrl(query, city = 'hyderabad') {
  const slug = roleSlugForQuery(query);
  // Role+location pages render real results; ?query= often lands on a marketing shell.
  return `https://wellfound.com/role/l/${slug}/${city}`;
}

async function extractCards(page) {
  return page.evaluate(() => {
    const abs = (href) => {
      try {
        return new URL(href, location.origin).href;
      } catch {
        return href || '';
      }
    };

    const anchors = Array.from(document.querySelectorAll('a[href*="/jobs/"]'));
    const seen = new Set();
    const cards = [];

    for (const a of anchors) {
      const href = abs(a.getAttribute('href'));
      const m = href.match(/\/jobs\/(\d+)(?:-[^/?#]*)?/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);

      const title = (a.textContent || '').trim().replace(/\s+/g, ' ');
      if (!title || title.length < 3) continue;

      let block = a.parentElement;
      for (let i = 0; i < 8 && block; i++) {
        if (/Actively Hiring|Actively interviewing/i.test(block.innerText || '')) break;
        block = block.parentElement;
      }
      const blockText = (block?.innerText || title).replace(/\s+/g, ' ').slice(0, 1200);

      let company = '';
      const hiringMatch = blockText.match(
        /([A-Za-z0-9&.'’\- ]{2,50}?)\s+Actively (?:Hiring|interviewing)/i
      );
      if (hiringMatch) company = hiringMatch[1].trim().split(/\s{2,}/).pop();
      const expMatch = blockText.match(/(\d+\+?\s*(?:years?|yrs?)(?:\s*of\s*exp)?)/i);

      cards.push({
        title,
        url: `https://wellfound.com/jobs/${m[1]}`,
        company: company || '',
        experienceText: (expMatch?.[1] || '').trim(),
        text: blockText,
      });
    }
    return cards;
  });
}

function fillWellfoundForm(page, profile) {
  return page.evaluate((profile) => {
    const setNativeValue = (el, value) => {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      desc?.set?.call(el, String(value));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const name = profile.name || '';
    const email = profile.email || '';
    // Whole years rounded DOWN (2.7 → 2): Math.round overstated experience.
    const years = profile.experience_years != null ? String(Math.floor(Number(profile.experience_years))) : '';
    const desired =
      profile.expected_ctc || profile.salary_expected || profile.desired_salary || '';
    const note = (profile.summary || '').split(/(?<=\.)\s+/).slice(0, 3).join(' ').slice(0, 600);

    for (const el of document.querySelectorAll('input, textarea')) {
      if (el.type === 'password' || el.type === 'hidden' || el.type === 'file' || el.type === 'checkbox' || el.type === 'radio') {
        continue;
      }
      const label = `${el.name || ''} ${el.getAttribute('aria-label') || ''} ${el.placeholder || ''} ${el.labels?.[0]?.innerText || ''}`.toLowerCase();
      if (!el.value) {
        if (/full name|name/.test(label) && name) setNativeValue(el, name);
        else if (/email/.test(label) && email) setNativeValue(el, email);
        // total experience only — "experience with <skill>" is left for the user
        else if (/years? of experience|yearsofexperience|experience/.test(label) && !/\b(with|in|using)\s+\w/.test(label) && years) setNativeValue(el, years);
        else if (/current (salary|ctc|compensation)/.test(label)) continue; // never fill current pay from expected
        else if (/desired salary|expected|salary|compensation|ctc/.test(label)) {
          if (!desired) continue;
          setNativeValue(el, desired);
        } else if (/note|message|cover|why|tell us|additional/.test(label) && note) {
          setNativeValue(el, note);
        }
      }
    }

    // Prefer "No" for visa sponsorship / US authorization when present (India candidate)
    for (const radio of document.querySelectorAll('input[type="radio"]')) {
      const nameAttr = (radio.name || '').toLowerCase();
      const label = (radio.labels?.[0]?.innerText || radio.value || '').toLowerCase();
      if (/sponsor|usauthorized|authorized/.test(nameAttr) && /^no$/.test(label.trim())) {
        radio.click();
      }
    }

    // Required empty fields we refuse to invent
    const unanswered = [];
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (el.type === 'hidden' || el.type === 'password' || el.type === 'file' || el.type === 'checkbox' || el.type === 'radio') continue;
      const required = el.required || el.getAttribute('aria-required') === 'true';
      if (!required) continue;
      if (el.value) continue;
      const label = (el.labels?.[0]?.innerText || el.name || el.placeholder || el.type).slice(0, 60);
      unanswered.push(label);
    }
    return { ok: unanswered.length === 0, unanswered };
  }, profile);
}

async function openExternalOnPage(page, url) {
  if (!url) return page.url();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (err) {
    logger.warn(`[wellfound] could not open external URL ${url}: ${err.message}`);
  }
  return page.url() || url;
}

async function applyToJob(browser, job, profile) {
  const page = await browser.newPage();
  const resume = selectResume(job.title, job.text);
  try {
    await withRetry(
      () => page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 }),
      { maxAttempts: 2 }
    );
    await new Promise((r) => setTimeout(r, 2000));
    await assertPageNotBlocked(page);
    await checkForCaptcha(page);

    const applyAction = await page.evaluate(() => {
      const isExternal = (value) => {
        if (!value) return '';
        try {
          const absolute = new URL(value, location.href).href;
          return /wellfound\.com/i.test(absolute) ? '' : absolute;
        } catch {
          return '';
        }
      };
      const looksLikeManualApply = (text = '') =>
        /apply|apply now|company site|external|official website|view job/i.test(text);

      const externalCandidates = [];
      for (const el of document.querySelectorAll('a[href], button, form[action]')) {
        const text = (el.textContent || el.getAttribute?.('aria-label') || '').trim();
        const href =
          el.tagName === 'A'
            ? el.getAttribute('href')
            : el.tagName === 'FORM'
              ? el.getAttribute('action')
              : el.getAttribute('data-url') ||
                el.getAttribute('data-href') ||
                el.getAttribute('href') ||
                '';
        const externalUrl = isExternal(href);
        if (externalUrl && looksLikeManualApply(text)) {
          externalCandidates.push({ text, url: externalUrl });
        }
      }

      const exactApply = Array.from(document.querySelectorAll('button, a')).find((b) =>
        /^apply( now)?$/i.test((b.textContent || '').trim())
      );
      if (exactApply) {
        const href = exactApply.getAttribute('href') || exactApply.getAttribute('data-url') || '';
        const externalUrl = isExternal(href);
        if (externalUrl) return { type: 'manual', companyUrl: externalUrl };
        exactApply.click();
        return { type: 'clicked' };
      }

      if (externalCandidates.length) {
        return { type: 'manual', companyUrl: externalCandidates[0].url };
      }

      return { type: 'manual', companyUrl: '' };
    });
    if (applyAction.type === 'manual') {
      let companyUrl = applyAction.companyUrl || job.url;
      if (applyAction.companyUrl) {
        companyUrl = await openExternalOnPage(page, applyAction.companyUrl);
      }
      return {
        status: 'manual-apply',
        page,
        companyUrl,
        resume,
        error: new ExternalAtsError(companyUrl),
      };
    }

    await new Promise((r) => setTimeout(r, 2000));

    // Signup wall = not logged in
    const needsSignup = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input[type="password"]')).some((el) => {
        const label = `${el.name || ''} ${el.labels?.[0]?.innerText || ''}`.toLowerCase();
        return /password/.test(label);
      })
    );
    if (needsSignup) {
      return {
        status: 'failed',
        page,
        resume,
        reason: 'login required — sign in once via `npm run login`',
        skipPortal: true,
      };
    }

    const filled = await fillWellfoundForm(page, profile);
    if (!filled.ok) {
      return {
        status: 'failed',
        page,
        resume,
        reason: `unanswered required fields: ${filled.unanswered.join('; ')}`,
        skipAsScreening: true,
      };
    }

    const submitted = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, a')).find((b) =>
        /submit application|send application|apply now/i.test((b.textContent || '').trim()) && !b.disabled
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!submitted) {
      return { status: 'failed', page, resume, reason: 'Submit application button not found' };
    }

    const signal = await waitForSuccess(page, { timeoutMs: 10000 });
    if (!signal) {
      // Submit was clicked — retrying could send a second application.
      return { status: 'unconfirmed', page, resume, reason: 'Submit clicked; no application-sent confirmation' };
    }
    return { status: 'applied', page, resume, evidence: await capture(page, { portal: 'wellfound', jobKey: job.url, signal }) };
  } catch (err) {
    if (err instanceof ExternalAtsError) {
      const companyUrl = err.companyUrl || job.url;
      if (companyUrl && /wellfound\.com/i.test(page.url()) && !/wellfound\.com/i.test(companyUrl)) {
        await openExternalOnPage(page, companyUrl);
      }
      return { status: 'manual-apply', page, companyUrl, resume, error: err };
    }
    if (err instanceof SkipPortalError) {
      return { status: 'failed', page, resume, reason: err.message, skipPortal: true };
    }
    return { status: 'failed', page, resume, reason: err.message };
  }
}

async function run({ profile, dedup, dryRun, newPage, browser }) {
  const results = emptyResults();
  const seenThisRun = new Set(); // same job shows up under several city/query searches
  const tabs = createTabTracker('wellfound');
  const page = await newPage();

  try {
    const searches = ['hyderabad', 'bangalore', 'chennai'].flatMap((city) => QUERIES.map((query) => ({ city, query })));
    for (const { city, query } of searches) {
      if (results.applied.length + results.unconfirmed.length >= MAX_APPS_PER_RUN) break;

      await withRetry(() => page.goto(searchUrl(query, city), { waitUntil: 'domcontentloaded' }), {
        maxAttempts: 2,
      });

      if (await page.$('input[type="password"]')) {
        throw new SkipPortalError('login required — sign in once via `npm run login`');
      }

      // DataDome 403 returns an empty shell — detect before waiting for job links
      await assertPageNotBlocked(page);
      await page.waitForSelector('a[href*="/jobs/"]', { timeout: 20000 }).catch(() => {});
      await checkForCaptcha(page);

      // If the wait timed out and we still have no job links, treat as a soft block
      const hasJobs = await page.$('a[href*="/jobs/"]');
      if (!hasJobs) {
        throw new SkipPortalError(
          'DataDome / bot challenge on search page — no job links rendered. Try: npm run login'
        );
      }

      // SPA: scroll to load more cards
      for (let i = 0; i < 4; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await new Promise((r) => setTimeout(r, 700));
      }

      const cards = await extractCards(page);
      results.discovered += cards.length;
      logger.info(`[wellfound] "${query}": ${cards.length} cards`);

      for (const card of cards) {
        if (admit(results, { key: card.url, seen: seenThisRun, dedup, job: { title: card.title, company: card.company, url: card.url }, site: 'Wellfound', dryRun }) !== 'new') continue;

        const loc = classifyLocation(`${card.location || ''} ${card.text || ''}`, card.company);
        if (!loc.allowed) {
          const skip = { title: card.title, company: card.company, url: card.url, reason: loc.reason };
          results.skipped.push(skip);
          if (!dryRun) dedup.append({ site: 'Wellfound', job_title: card.title, company: card.company, job_url: card.url, status: 'skipped', notes: loc.reason });
          continue;
        }

        const score = scoreJob({
          title: card.title,
          description: card.text,
          experienceText: card.experienceText,
        });
        const job = {
          title: card.title,
          company: card.company,
          url: card.url,
          text: card.text,
        };

        if (!shouldApply(score)) {
          job.reason = `score ${score} below threshold`;
          results.skipped.push(job);
          if (!dryRun) {
            dedup.append({
              site: 'Wellfound',
              job_title: card.title,
              company: card.company,
              job_url: card.url,
              status: 'skipped',
              notes: job.reason,
            });
          }
          continue;
        }

        if (results.applied.length + results.unconfirmed.length >= MAX_APPS_PER_RUN) {
          job.reason = 'per-run cap reached';
          results.skipped.push(job);
          continue;
        }

        if (dryRun) {
          job.reason = `would apply (score ${score})`;
          results.applied.push(job);
          logger.info(`[wellfound] DRY RUN would apply: ${card.title} @ ${card.company} (score ${score})`);
          continue;
        }

        const attemptPages = [];
        let outcome;
        for (let attempt = 1; attempt <= 2; attempt++) {
          outcome = await applyToJob(browser, card, profile);
          if (outcome.page) attemptPages.push(outcome.page);
          if (
            outcome.status === 'applied' ||
            outcome.status === 'unconfirmed' ||
            outcome.status === 'manual-apply' ||
            outcome.skipPortal ||
            outcome.skipAsScreening ||
            isUiError(new Error(outcome.reason || ''))
          ) {
            break;
          }
          if (attempt < 2) {
            logger.warn(`[wellfound] attempt ${attempt} failed for "${card.title}": ${outcome.reason}`);
            await humanDelay(1500, 2500);
            continue;
          }
          break;
        }

        if (outcome.skipPortal) {
          await settleAttemptPages(attemptPages, null);
          throw new SkipPortalError(outcome.reason);
        }

        const keepOpen =
          outcome.status === 'manual-apply' ||
          outcome.status === 'failed' ||
          outcome.skipAsScreening;
        const keepPage = keepOpen ? outcome.page : null;
        await settleAttemptPages(attemptPages, keepPage);

        const pageUrl = (() => {
          try {
            return keepPage?.url?.() || outcome.companyUrl || '';
          } catch {
            return outcome.companyUrl || '';
          }
        })();

        if (outcome.status === 'manual-apply') {
          const entry = buildManualApplyEntry(job, outcome.companyUrl || extractCompanyUrl(outcome.error) || card.url);
          results.manualApply.push(entry);
          tabs.trackManualApply(entry, entry.companyUrl);
          logger.info(`[wellfound] → Tab OPEN and ready for manual apply`);
          dedup.append({
            site: 'Wellfound',
            job_title: card.title,
            company: card.company,
            job_url: card.url,
            status: 'manual-apply',
            notes: `URL: ${entry.companyUrl} | Resume: ${entry.resume}`,
          });
        } else if (outcome.status === 'unconfirmed') {
          job.reason = outcome.reason;
          results.unconfirmed.push(job);
          tabs.trackFailed(job, pageUrl || job.url);
          dedup.append({ site: 'Wellfound', job_title: card.title, company: card.company, job_url: card.url, status: 'unconfirmed', notes: outcome.reason });
        } else if (outcome.skipAsScreening || /unanswered required/i.test(outcome.reason || '')) {
          // A required question the profile can't answer — the user finishes it on the open tab.
          const entry = { ...job, companyUrl: pageUrl || job.url, reason: `needs your answer: ${String(outcome.reason).replace(/^unanswered required fields:\s*/i, '')}` };
          results.manualApply.push(entry);
          tabs.trackManualApply(entry, entry.companyUrl);
          dedup.append({
            site: 'Wellfound',
            job_title: card.title,
            company: card.company,
            job_url: card.url,
            status: 'manual-apply',
            notes: entry.reason,
          });
          logger.info(`[wellfound] skipped: ${card.title} — ${outcome.reason}`);
        } else if (outcome.status === 'failed') {
          job.reason = outcome.reason || 'apply failed';
          results.failed.push(job);
          tabs.trackFailed(job, pageUrl || job.url);
          console.log(`\n❌ FAILED (inspect & retry):\n   Job: ${card.title} @ ${card.company}\n   Error: ${job.reason}\n   → Tab is OPEN for inspection\n`);
          dedup.append({
            site: 'Wellfound',
            job_title: card.title,
            company: card.company,
            job_url: card.url,
            status: 'failed',
            notes: job.reason,
          });
        } else {
          job.evidence = outcome.evidence;
          results.applied.push(job);
          dedup.append({
            site: 'Wellfound',
            job_title: card.title,
            company: card.company,
            job_url: card.url,
            status: 'applied',
            notes: `auto-applied (score ${score}) | ${evidenceNote(outcome.evidence)}`,
          });
          console.log(`✅ Applied (confirmed): ${card.title} @ ${card.company}`);
          logger.info(`[wellfound] applied: ${card.title} @ ${card.company} → tab closed`);
        }

        await humanDelay(3000, 5000);
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

module.exports = {
  run,
  searchUrl,
  extractCards,
  selectResume,
  extractCompanyUrl,
  buildManualApplyEntry,
  ExternalAtsError,
  RESUME_RN,
  RESUME_FS,
};
