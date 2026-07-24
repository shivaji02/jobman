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
 */
const { humanDelay, checkForCaptcha, SkipPortalError } = require('../core/browser');
const { scoreJob, shouldApply } = require('../core/filter');

const OPPORTUNITIES_URL = 'https://www.instahyre.com/candidate/opportunities/?job_type=0';
const SEARCH_SKILL = 'React Native';
const MAX_APPS_PER_RUN = 10;

function dedupKey(company, title) {
  const slug = (s) =>
    String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `https://www.instahyre.com/#job/${slug(company)}/${slug(title)}`;
}

/** Fill the "Search other jobs" sidebar (Skills + Experience) and click "Show results". */
async function runSidebarSearch(page, experienceYears) {
  await page.waitForSelector('#skills-selectized', { timeout: 15000 });
  await page.click('#skills-selectized');
  await page.keyboard.type(SEARCH_SKILL, { delay: 80 });
  await page.waitForSelector('.selectize-dropdown-content', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 500));

  const picked = await page.evaluate((skill) => {
    const dd = document.querySelector('.selectize-dropdown-content');
    if (!dd) return false;
    const opts = Array.from(dd.querySelectorAll('div, li'));
    const exact = opts.find((o) => o.textContent.trim() === skill);
    (exact || opts[0])?.click();
    return !!(exact || opts[0]);
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

  const clicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Show results'));
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!clicked) throw new Error('"Show results" button not found');

  await page.waitForSelector('.employer-row, .no-results', { timeout: 15000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500)); // Angular render settle after search
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

/** Click the Nth card's "View" button, then the modal's exact "Apply" button. */
async function applyToCard(page, index) {
  // Cards below the fold don't have their View button rendered until scrolled
  // into view — scroll first, let Angular re-render, then click.
  const scrolled = await page.evaluate((i) => {
    const row = document.querySelectorAll('.employer-row')[i];
    if (!row) return false;
    row.scrollIntoView({ block: 'center' });
    return true;
  }, index);
  if (!scrolled) throw new Error(`card ${index} not found in list`);
  await new Promise((r) => setTimeout(r, 800));

  const opened = await page.evaluate((i) => {
    const rows = Array.from(document.querySelectorAll('.employer-row'));
    const row = rows[i];
    if (!row) return false;
    const viewBtn = Array.from(row.querySelectorAll('button, a')).find((b) => /view/i.test(b.textContent));
    if (!viewBtn) return false;
    viewBtn.click();
    return true;
  }, index);
  if (!opened) throw new Error('View button not found');

  await page.waitForSelector('.application-modal, [role="dialog"], .modal', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 1000)); // "Hold on, loading..." settle

  const clicked = await page.evaluate(() => {
    const modal = document.querySelector('.application-modal, [role="dialog"], .modal') || document;
    // exact match on "Apply" — NOT "Apply on company site" (external redirect)
    const applyBtn = Array.from(modal.querySelectorAll('button')).find(
      (b) => b.textContent.trim() === 'Apply' && !b.disabled
    );
    if (!applyBtn) return false;
    applyBtn.click();
    return true;
  });
  if (!clicked) throw new Error('exact "Apply" button not found or disabled in modal');

  await new Promise((r) => setTimeout(r, 1200));

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
  await new Promise((r) => setTimeout(r, 500));

  if (!confirmed) throw new Error('No "Applied" confirmation after clicking Apply');
}

async function run({ profile, dedup, dryRun, newPage }) {
  const results = { reviewed: 0, applied: [], skipped: [], failed: [] };
  const page = await newPage();

  try {
    await page.goto(OPPORTUNITIES_URL, { waitUntil: 'domcontentloaded' });

    // Safety: never log in automatically
    if (/\/login|\/signin/.test(page.url()) || (await page.$('input[type="password"]'))) {
      throw new SkipPortalError('login required — sign in once via `npm run login`');
    }
    await new Promise((r) => setTimeout(r, 2500)); // Angular bootstrap settle
    await checkForCaptcha(page);

    await runSidebarSearch(page, profile.experience_years);

    const cards = await extractCards(page);
    results.reviewed = cards.length;
    console.log(`[instahyre] ${cards.length} job cards after search`);

    for (const card of cards) {
      if (results.applied.length >= MAX_APPS_PER_RUN) break;

      const url = dedupKey(card.company, card.title);
      const job = { title: card.title, company: card.company, url };

      if (dedup.has(url)) {
        console.log(`[instahyre] dedup skip: ${card.title} @ ${card.company}`);
        continue; // already applied — don't re-log
      }

      const score = scoreJob({ title: card.title, description: `${card.text} ${card.skills}` });
      if (!shouldApply(score)) {
        job.reason = `score ${score} below threshold`;
        results.skipped.push(job);
        if (!dryRun) dedup.append({ site: 'Instahyre', job_title: card.title, company: card.company, job_url: url, status: 'skipped', notes: job.reason });
        continue;
      }

      if (dryRun) {
        job.reason = `would apply (score ${score})`;
        results.applied.push(job);
        console.log(`[instahyre] DRY RUN would apply: ${card.title} @ ${card.company} (score ${score})`);
        continue;
      }

      let lastErr;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await applyToCard(page, card.index);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (err instanceof SkipPortalError) throw err;
          console.warn(`[instahyre] attempt ${attempt} failed for "${card.title}": ${err.message}`);
          await humanDelay(1500, 2500);
        }
      }

      if (lastErr) {
        job.reason = lastErr.message;
        results.failed.push(job);
        dedup.append({ site: 'Instahyre', job_title: card.title, company: card.company, job_url: url, status: 'failed', notes: lastErr.message });
      } else {
        results.applied.push(job);
        dedup.append({ site: 'Instahyre', job_title: card.title, company: card.company, job_url: url, status: 'applied', notes: `auto-applied (score ${score})` });
        console.log(`[instahyre] applied: ${card.title} @ ${card.company}`);
      }

      await humanDelay(); // 2-3s between applications
    }
  } finally {
    await page.close().catch(() => {});
  }

  return results;
}

module.exports = { run };
