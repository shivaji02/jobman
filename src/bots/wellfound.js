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
const { humanDelay, checkForCaptcha, SkipPortalError } = require('../core/browser');
const { withRetry, isUiError } = require('../core/retry');
const { scoreJob, shouldApply } = require('../core/filter');
const logger = require('../core/logger');

const QUERIES = [
  'react native developer',
  'mobile developer',
  'frontend engineer react',
  'full stack developer node react',
];
const MAX_APPS_PER_RUN = 10;

class ExternalAtsError extends Error {
  constructor(msg = 'skipped — external ATS, skipped') {
    super(msg);
    this.name = 'ExternalAtsError';
  }
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

function searchUrl(query) {
  const slug = roleSlugForQuery(query);
  // Role+location pages render real results; ?query= often lands on a marketing shell.
  return `https://wellfound.com/role/l/${slug}/india`;
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
    const years = profile.experience_years != null ? String(Math.round(Number(profile.experience_years))) : '';
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
        else if (/years? of experience|yearsofexperience|experience/.test(label) && years) setNativeValue(el, years);
        else if (/desired salary|salary|compensation|ctc/.test(label)) {
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

async function applyToJob(browser, job, profile) {
  const page = await browser.newPage();
  try {
    await withRetry(
      () => page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 }),
      { maxAttempts: 2 }
    );
    await new Promise((r) => setTimeout(r, 2000));
    await assertPageNotBlocked(page);
    await checkForCaptcha(page);

    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, a')).find((b) =>
        /^apply( now)?$/i.test((b.textContent || '').trim())
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!clicked) throw new ExternalAtsError('no Easy Apply / Apply Now — external or missing apply');

    await new Promise((r) => setTimeout(r, 2000));

    // Signup wall = not logged in
    const needsSignup = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input[type="password"]')).some((el) => {
        const label = `${el.name || ''} ${el.labels?.[0]?.innerText || ''}`.toLowerCase();
        return /password/.test(label);
      })
    );
    if (needsSignup) {
      throw new SkipPortalError('login required — sign in once via `npm run login`');
    }

    const filled = await fillWellfoundForm(page, profile);
    if (!filled.ok) {
      throw new Error(`unanswered required fields: ${filled.unanswered.join('; ')}`);
    }

    const submitted = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, a')).find((b) =>
        /submit application|send application|apply now/i.test((b.textContent || '').trim()) && !b.disabled
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!submitted) throw new Error('Submit application button not found');

    await new Promise((r) => setTimeout(r, 2500));
    const confirmed = await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      return /application (sent|submitted)|thanks for applying|successfully applied|we.?ve received your application/i.test(
        text
      );
    });
    if (!confirmed) throw new Error('no application-sent confirmation');
  } finally {
    await page.close().catch(() => {});
  }
}

async function run({ profile, dedup, dryRun, newPage, browser }) {
  const results = { reviewed: 0, applied: [], skipped: [], failed: [] };
  const page = await newPage();

  try {
    for (const query of QUERIES) {
      if (results.applied.length >= MAX_APPS_PER_RUN) break;

      await withRetry(() => page.goto(searchUrl(query), { waitUntil: 'domcontentloaded' }), {
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
      results.reviewed += cards.length;
      logger.info(`[wellfound] "${query}": ${cards.length} cards`);

      for (const card of cards) {
        if (results.applied.length >= MAX_APPS_PER_RUN) break;
        if (dedup.has(card.url)) continue;

        const score = scoreJob({
          title: card.title,
          description: card.text,
          experienceText: card.experienceText,
        });
        const job = { title: card.title, company: card.company, url: card.url };

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

        if (dryRun) {
          job.reason = `would apply (score ${score})`;
          results.applied.push(job);
          logger.info(`[wellfound] DRY RUN would apply: ${card.title} @ ${card.company} (score ${score})`);
          continue;
        }

        let lastErr;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            await applyToJob(browser, card, profile);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            if (err instanceof ExternalAtsError || err instanceof SkipPortalError || isUiError(err)) {
              break;
            }
            logger.warn(`[wellfound] attempt ${attempt} failed for "${card.title}": ${err.message}`);
            await humanDelay(1500, 2500);
          }
        }

        if (lastErr instanceof SkipPortalError) throw lastErr;

        if (lastErr instanceof ExternalAtsError || (lastErr && /unanswered required/i.test(lastErr.message))) {
          job.reason = lastErr.message;
          results.skipped.push(job);
          dedup.append({
            site: 'Wellfound',
            job_title: card.title,
            company: card.company,
            job_url: card.url,
            status: 'skipped',
            notes: lastErr.message,
          });
          logger.info(`[wellfound] skipped: ${card.title} — ${lastErr.message}`);
        } else if (lastErr) {
          job.reason = lastErr.message;
          results.failed.push(job);
          dedup.append({
            site: 'Wellfound',
            job_title: card.title,
            company: card.company,
            job_url: card.url,
            status: 'failed',
            notes: lastErr.message,
          });
        } else {
          results.applied.push(job);
          dedup.append({
            site: 'Wellfound',
            job_title: card.title,
            company: card.company,
            job_url: card.url,
            status: 'applied',
            notes: `auto-applied (score ${score})`,
          });
          logger.info(`[wellfound] applied: ${card.title} @ ${card.company}`);
        }

        await humanDelay(3000, 5000);
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  return results;
}

module.exports = { run, searchUrl, extractCards };
