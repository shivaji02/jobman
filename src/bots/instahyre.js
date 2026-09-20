/**
 * Instahyre bot — HIGHEST PRIORITY.
 *
 * The "Opportunities" tab default feed is frequently empty ("no matching
 * opportunities found"); real results come from the "Search other jobs"
 * sidebar (Angular/selectize form) — fill Skills + Experience, click "Show
 * results", then read the rendered `.employer-row` cards. Verified live
 * against the real DOM (2026-07-24):
 *   - card:    .employer-row
 *   - title:   .employer-job-name
 *   - company: .employer-company-name
 *   - skills:  .job-skills
 *   - open:    button/a with text "View »" inside the row
 *   - modal buttons include "Apply" AND "Apply on company site" — must match
 *     the exact "Apply" label, not a substring, or we'd trigger an external
 *     redirect instead of the in-app application.
 *
 * Dedup: Instahyre modals don't change the URL, so the dedup key is a stable
 * synthetic URL derived from company + title.
 *
 * Clicks: always use in-page element.click() — Puppeteer native page.click()
 * fails on Angular/selectize overlays ("Node is either not clickable...").
 */
const fs = require('fs');
const { humanDelay, checkForCaptcha, SkipPortalError } = require('../core/browser');
const { withRetry } = require('../core/retry');
const { scoreJob, shouldApply } = require('../core/filter');
const logger = require('../core/logger');

const OPPORTUNITIES_URL = 'https://www.instahyre.com/candidate/opportunities/?job_type=0';
const SEARCH_SKILL = 'React Native';
const MAX_APPS_PER_RUN = 10;
const RESUME_RN = '/Users/neosoft/Downloads/Resumes/shivajirn02.pdf';
const RESUME_FS = '/Users/neosoft/Downloads/Resumes/ShivajiPresidio.pdf';

function selectResume(jobTitle = '', jobText = '') {
  const blob = `${jobTitle} ${jobText}`.toLowerCase();
  if (/react[\s-]?native|\bnative\b|\bmobile\b/.test(blob)) return RESUME_RN;
  return RESUME_FS;
}

function dedupKey(company, title) {
  const slug = (s) =>
    String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `https://www.instahyre.com/#job/${slug(company)}/${slug(title)}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isContextDestroyed(err) {
  return /context was destroyed|because of a navigation|Execution context/i.test(
    (err && err.message) || String(err || '')
  );
}

/** Retry when Angular/Instahyre navigates and tears down the JS world. */
async function withContextRetry(fn, { attempts = 3, delayMs = 800, label = 'step' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isContextDestroyed(err) || i === attempts) throw err;
      logger.warn(`[instahyre] ${label} interrupted by navigation, retry ${i}/${attempts}: ${err.message}`);
      await sleep(delayMs * i);
    }
  }
  throw lastErr;
}

/** In-page click with a short retry if Angular detached the node. */
async function evaluateClick(page, fn, ...args) {
  return withContextRetry(
    async () => {
      let last = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        last = await page.evaluate(fn, ...args);
        if (last) return last;
        await sleep(400 * attempt);
      }
      return last;
    },
    { label: 'js-click' }
  );
}

/** Fill the "Search other jobs" sidebar (Skills + Experience) and click "Show results". */
async function runSidebarSearch(page, experienceYears) {
  await withContextRetry(
    () => page.waitForSelector('#skills-selectized, #skills', { timeout: 15000 }),
    { label: 'skills-input' }
  );
  await sleep(800); // Angular settle — overlay may still cover the input

  // Native page.click / keyboard.type fail here: the selectize input is
  // overlay-covered and never focused. Use the live selectize API instead.
  const searched = await page.evaluate((skill) => {
    const sz = document.querySelector('#skills') && document.querySelector('#skills').selectize;
    if (!sz || typeof sz.onSearchChange !== 'function') return false;
    sz.onSearchChange(skill);
    return true;
  }, SEARCH_SKILL);
  if (!searched) throw new Error('selectize API not available on #skills');

  await page
    .waitForFunction(
      (skill) => {
        const sz = document.querySelector('#skills') && document.querySelector('#skills').selectize;
        return !!(sz && Object.values(sz.options || {}).some((o) => (o.name || o.value) === skill));
      },
      { timeout: 8000 },
      SEARCH_SKILL
    )
    .catch(() => {});

  const picked = await evaluateClick(page, (skill) => {
    const sz = document.querySelector('#skills') && document.querySelector('#skills').selectize;
    if (sz) {
      if (typeof sz.addItem === 'function') sz.addItem(skill);
      else if (typeof sz.setValue === 'function') sz.setValue(skill);
      if ((sz.items || []).includes(skill)) return true;
    }
    const control = document.querySelector('#skills-selectized')?.closest('.selectize-control');
    const opts = Array.from(control?.querySelectorAll('.selectize-dropdown-content [data-selectable], .selectize-dropdown-content .item, .selectize-dropdown-content .option') || []);
    const exact = opts.find((o) => (o.getAttribute('data-value') || o.textContent).trim() === skill);
    const choice = exact || opts[0];
    if (!choice || !choice.isConnected) return false;
    choice.click();
    return true;
  }, SEARCH_SKILL);
  if (!picked) throw new Error('could not select skill in search sidebar');

  await page.evaluate((years) => {
    const yearsInput = document.querySelector('#years');
    if (yearsInput) {
      yearsInput.value = String(years);
      yearsInput.dispatchEvent(new Event('input', { bubbles: true }));
      yearsInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, experienceYears);

  const navAfterSearch = page
    .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 })
    .catch(() => null);
  const clicked = await evaluateClick(page, () => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Show results')
    );
    if (!btn || !btn.isConnected) return false;
    btn.click();
    return true;
  });
  if (!clicked) throw new Error('"Show results" button not found');
  await navAfterSearch;
  await sleep(1500); // Angular render settle after search
  await withContextRetry(
    () => page.waitForSelector('.employer-row, .no-results', { timeout: 15000 }),
    { label: 'search-results', attempts: 2 }
  ).catch(() => {});
}

async function extractCards(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.employer-row'));
    return rows.map((row, index) => ({
      index,
      title: (row.querySelector('.employer-job-name')?.textContent || '').trim(),
      company: (row.querySelector('.employer-company-name')?.textContent || '').trim(),
      skills: (row.querySelector('.job-skills')?.textContent || '').trim(),
      text: row.textContent.replace(/\s+/g, ' ').slice(0, 1200),
    }));
  });
}

async function attachResumeIfPresent(page, resumePath) {
  if (!resumePath || !fs.existsSync(resumePath)) return false;
  const handle = await page.$('input[type="file"]');
  if (!handle) return false;
  await handle.uploadFile(resumePath);
  await handle.dispose().catch(() => {});
  return true;
}

/** Click the Nth card's "View" button, then the modal's exact "Apply" button. */
async function applyToCard(page, index, resumePath) {
  // Cards below the fold don't have their View button rendered until scrolled
  // into view — scroll first, let Angular re-render, then click.
  const scrolled = await page.evaluate((i) => {
    const row = document.querySelectorAll('.employer-row')[i];
    if (!row) return false;
    row.scrollIntoView({ block: 'center' });
    return true;
  }, index);
  if (!scrolled) throw new Error(`card ${index} not found in list`);
  await sleep(800);

  const opened = await evaluateClick(page, (i) => {
    const rows = Array.from(document.querySelectorAll('.employer-row'));
    const row = rows[i];
    if (!row) return false;
    const viewBtn = Array.from(row.querySelectorAll('button, a')).find((b) => /view/i.test(b.textContent));
    if (!viewBtn || !viewBtn.isConnected) return false;
    viewBtn.click();
    return true;
  }, index);
  if (!opened) throw new Error('View button not found');

  await page.waitForSelector('.application-modal, [role="dialog"], .modal', { timeout: 10000 });
  await sleep(1000); // "Hold on, loading..." settle

  const attached = await attachResumeIfPresent(page, resumePath);
  if (attached) logger.info(`[instahyre] attached resume ${resumePath}`);

  const clicked = await evaluateClick(page, () => {
    const modal = document.querySelector('.application-modal, [role="dialog"], .modal') || document;
    // exact match on "Apply" — NOT "Apply on company site" (external redirect)
    const applyBtn = Array.from(modal.querySelectorAll('button')).find(
      (b) => b.textContent.trim() === 'Apply' && !b.disabled && b.isConnected
    );
    if (!applyBtn) return false;
    applyBtn.click();
    return true;
  });
  if (!clicked) throw new Error('exact "Apply" button not found or disabled in modal');

  await sleep(1200);

  const confirmed = await page.evaluate(
    () =>
      !!document.querySelector('[class*="success"], [class*="confirmation"]') ||
      document.body.innerText.includes('Applied')
  );

  await page.evaluate(() => {
    const closeBtn = document.querySelector('button[aria-label="Close"], [class*="close"]');
    if (closeBtn) closeBtn.click();
  });
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(500);

  if (!confirmed) throw new Error('No "Applied" confirmation after clicking Apply');
}

async function run({ profile, dedup, dryRun, newPage }) {
  const results = { reviewed: 0, applied: [], skipped: [], failed: [] };
  const page = await newPage();

  try {
    await withRetry(
      () => page.goto(OPPORTUNITIES_URL, { waitUntil: 'domcontentloaded' }),
      {
        maxAttempts: 2,
        onRetry: (err, attempt, delay) =>
          logger.warn(`[instahyre] navigation retry ${attempt} in ${delay}ms: ${err.message}`),
      }
    );

    // Safety: never log in automatically. Instahyre often redirects after
    // first paint — wait for a stable document before touching the DOM.
    await sleep(2500); // Angular bootstrap settle
    await withContextRetry(
      async () => {
        if (/\/login|\/signin/.test(page.url()) || (await page.$('input[type="password"]'))) {
          throw new SkipPortalError('login required — sign in once via `npm run login`');
        }
        await checkForCaptcha(page);
      },
      { label: 'login-check' }
    );

    await withContextRetry(
      () => runSidebarSearch(page, profile.experience_years),
      { label: 'sidebar-search' }
    );
    logger.info(`[instahyre] searched skill "${SEARCH_SKILL}"`);

    const cards = await withContextRetry(() => extractCards(page), { label: 'extract-cards' });
    results.reviewed = cards.length;
    logger.info(`[instahyre] ${cards.length} job cards after search`);

    for (const card of cards) {
      if (results.applied.length >= MAX_APPS_PER_RUN) break;

      const url = dedupKey(card.company, card.title);
      const resume = selectResume(card.title, `${card.text} ${card.skills}`);
      const job = { title: card.title, company: card.company, url, resume };

      if (dedup.has(url)) {
        logger.info(`[instahyre] dedup skip: ${card.title} @ ${card.company}`);
        continue; // already applied — don't re-log
      }

      const score = scoreJob({ title: card.title, description: `${card.text} ${card.skills}` });
      if (!shouldApply(score)) {
        job.reason = `score ${score} below threshold`;
        results.skipped.push(job);
        if (!dryRun) {
          dedup.append({
            site: 'Instahyre',
            job_title: card.title,
            company: card.company,
            job_url: url,
            status: 'skipped',
            notes: job.reason,
          });
        }
        continue;
      }

      if (dryRun) {
        job.reason = `would apply (score ${score}; resume=${resume})`;
        results.applied.push(job);
        logger.info(`[instahyre] DRY RUN would apply: ${card.title} @ ${card.company} (score ${score}; resume=${resume})`);
        continue;
      }

      let lastErr;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await applyToCard(page, card.index, resume);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (err instanceof SkipPortalError) throw err;
          logger.warn(`[instahyre] attempt ${attempt} failed for "${card.title}": ${err.message}`);
          await page.keyboard.press('Escape').catch(() => {});
          await humanDelay(1500, 2500);
        }
      }

      if (lastErr) {
        job.reason = lastErr.message;
        results.failed.push(job);
        dedup.append({
          site: 'Instahyre',
          job_title: card.title,
          company: card.company,
          job_url: url,
          status: 'failed',
          notes: lastErr.message,
        });
      } else {
        results.applied.push(job);
        dedup.append({
          site: 'Instahyre',
          job_title: card.title,
          company: card.company,
          job_url: url,
          status: 'applied',
          notes: `auto-applied (score ${score}; resume=${resume})`,
        });
        logger.info(`[instahyre] applied: ${card.title} @ ${card.company} (resume=${resume})`);
      }

      await humanDelay(); // 2-3s between applications
    }
  } finally {
    await page.close().catch(() => {});
  }

  return results;
}

module.exports = { run, selectResume, RESUME_RN, RESUME_FS, SEARCH_SKILL };
