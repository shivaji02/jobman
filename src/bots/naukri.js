/**
 * Naukri bot — flow proven manually (2 applications submitted 2026-07-23).
 *
 * Search results pages, client-side experience filtering (the site's slider
 * filter is threshold-based, not a range), job cards open in a new tab, and
 * the Apply flow's CTC screening drawer is dismissed via "Skip this question".
 * Job URLs are stable and used directly as the dedup key.
 */
const { humanDelay, checkForCaptcha, SkipPortalError } = require('../core/browser');
const { scoreJob, shouldApply, parseExperienceRange } = require('../core/filter');

const QUERIES = ['react native developer', 'mobile developer', 'frontend engineer react', 'full stack developer node react'];
const MAX_APPS_PER_RUN = 10;

function searchUrl(query) {
  const slug = query.trim().toLowerCase().replace(/\s+/g, '-');
  return `https://www.naukri.com/${slug}-jobs?k=${encodeURIComponent(query)}`;
}

async function extractCards(page) {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.cust-job-tuple, [class*="jobTuple"]'));
    return cards.map((card) => {
      const titleEl = card.querySelector('.title, a.title');
      const companyEl = card.querySelector('.comp-name, [class*="company"]');
      const expEl = card.querySelector('.exp, [class*="experience"]');
      return {
        title: (titleEl?.textContent || '').trim(),
        url: titleEl?.href || '',
        company: (companyEl?.textContent || '').trim(),
        experienceText: (expEl?.textContent || '').trim(),
        text: card.textContent.replace(/\s+/g, ' ').slice(0, 1200),
      };
    }).filter((c) => c.url);
  });
}

/** Job only offers "Apply on company site" (external ATS) — skip, don't retry. */
class ExternalAtsError extends Error {
  constructor() {
    super('skipped — external ATS (apply on company site)');
    this.name = 'ExternalAtsError';
  }
}

/** Open a job in a new tab, apply, dismiss the CTC drawer, verify via confirmation URL. */
async function applyToJob(browser, job) {
  const page = await browser.newPage();
  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 2000));
    await checkForCaptcha(page);

    // Apply buttons hydrate late — wait for either variant before deciding.
    await page
      .waitForSelector('#apply-button, #company-site-button, [class*="apply-button"], [id*="apply"]', { timeout: 10000 })
      .catch(() => {});

    const outcome = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, a'));
      // On-site apply: exact "Apply" (or the #apply-button id). Must NOT match
      // "Apply on company site" — that redirects to an external ATS.
      const onSite =
        document.querySelector('#apply-button') ||
        buttons.find((b) => /^apply$/i.test(b.textContent.trim()));
      if (onSite) {
        onSite.click();
        return 'clicked';
      }
      const external =
        document.querySelector('#company-site-button') ||
        buttons.find((b) => /apply on company site/i.test(b.textContent.trim()));
      if (external) return 'external';
      if (buttons.some((b) => /login to apply|register to apply/i.test(b.textContent.trim()))) return 'login';
      // No apply control at all — snapshot visible button labels so the
      // failure log says what the page actually offered.
      const labels = buttons
        .map((b) => b.textContent.trim())
        .filter((t) => t && t.length <= 40)
        .slice(0, 10);
      return `none: [${[...new Set(labels)].join(' | ')}]`;
    });
    if (outcome === 'external') throw new ExternalAtsError();
    if (outcome === 'login') throw new Error('login required — session logged out on job page');
    if (outcome !== 'clicked') throw new Error(`Apply button not found — page buttons ${outcome.slice(5)}`);

    await new Promise((r) => setTimeout(r, 1500));

    // dismiss CTC / screening chatbot drawer if present
    await page.evaluate(() => {
      const skipBtn = Array.from(document.querySelectorAll('button, a, span')).find((b) =>
        /skip this question/i.test(b.textContent)
      );
      if (skipBtn) skipBtn.click();
    });
    await new Promise((r) => setTimeout(r, 1500));

    const confirmed = /myapply|saveapply/i.test(page.url()) || (await page.evaluate(() =>
      document.body.innerText.toLowerCase().includes('application') && document.body.innerText.toLowerCase().includes('sent')
    ));
    if (!confirmed) throw new Error('No apply confirmation detected');
  } finally {
    await page.close().catch(() => {});
  }
}

async function run({ dedup, dryRun, newPage, browser }) {
  const results = { reviewed: 0, applied: [], skipped: [], failed: [] };
  const page = await newPage();

  try {
    for (const query of QUERIES) {
      if (results.applied.length >= MAX_APPS_PER_RUN) break;

      // networkidle2 never resolves on Naukri (continuous background XHR/analytics)
      // and leaves the page on an interim state that looks like a CAPTCHA — use
      // domcontentloaded + an explicit wait for job cards instead.
      await page.goto(searchUrl(query), { waitUntil: 'domcontentloaded' });

      if (await page.$('input[type="password"]')) {
        throw new SkipPortalError('login required — sign in once via `npm run login`');
      }
      await page.waitForSelector('.cust-job-tuple, .srp-jobtuple-wrapper', { timeout: 15000 }).catch(() => {});
      await checkForCaptcha(page);

      const cards = await extractCards(page);
      results.reviewed += cards.length;
      console.log(`[naukri] "${query}": ${cards.length} cards`);

      for (const card of cards) {
        if (results.applied.length >= MAX_APPS_PER_RUN) break;

        if (dedup.has(card.url)) continue; // already applied

        const range = parseExperienceRange(card.experienceText);
        if (range && (range.min > 3.5 || range.max < 1.5)) {
          const job = { title: card.title, company: card.company, url: card.url, reason: `experience ${card.experienceText} out of range` };
          results.skipped.push(job);
          if (!dryRun) dedup.append({ site: 'Naukri', job_title: card.title, company: card.company, job_url: card.url, status: 'skipped', notes: job.reason });
          continue;
        }

        const score = scoreJob({ title: card.title, description: card.text, experienceText: card.experienceText });
        const job = { title: card.title, company: card.company, url: card.url };
        if (!shouldApply(score)) {
          job.reason = `score ${score} below threshold`;
          results.skipped.push(job);
          if (!dryRun) dedup.append({ site: 'Naukri', job_title: card.title, company: card.company, job_url: card.url, status: 'skipped', notes: job.reason });
          continue;
        }

        if (dryRun) {
          job.reason = `would apply (score ${score})`;
          results.applied.push(job);
          console.log(`[naukri] DRY RUN would apply: ${card.title} @ ${card.company} (score ${score})`);
          continue;
        }

        let lastErr;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            await applyToJob(browser, card);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            if (err instanceof ExternalAtsError) break; // not a failure — never retry
            console.warn(`[naukri] attempt ${attempt} failed for "${card.title}": ${err.message}`);
            await humanDelay(1500, 2500);
          }
        }

        if (lastErr instanceof ExternalAtsError) {
          job.reason = lastErr.message;
          results.skipped.push(job);
          dedup.append({ site: 'Naukri', job_title: card.title, company: card.company, job_url: card.url, status: 'skipped', notes: lastErr.message });
          console.log(`[naukri] skipped (external ATS): ${card.title} @ ${card.company}`);
        } else if (lastErr) {
          job.reason = lastErr.message;
          results.failed.push(job);
          dedup.append({ site: 'Naukri', job_title: card.title, company: card.company, job_url: card.url, status: 'failed', notes: lastErr.message });
        } else {
          results.applied.push(job);
          dedup.append({ site: 'Naukri', job_title: card.title, company: card.company, job_url: card.url, status: 'applied', notes: `auto-applied (score ${score})` });
          console.log(`[naukri] applied: ${card.title} @ ${card.company}`);
        }

        await humanDelay();
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  return results;
}

module.exports = { run };
