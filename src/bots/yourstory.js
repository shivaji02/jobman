/**
 * YourStory bot.
 *
 * Reality check (2026-07-24): yourstory.com/jobs is YourStory Media's own
 * "Work with Us" careers page (a handful of editorial/sales roles). There is
 * no searchable startup job board anymore — ?search= is ignored. Apply is a
 * mailto: to hr@yourstory.com, so we never auto-submit; matching roles (if
 * any) are logged as skipped with a clear reason.
 *
 * Still implements the standard bot contract so dry-runs / reports work and
 * the portal can be re-enabled if YourStory ships a real board again.
 */
const { humanDelay, checkForCaptcha, SkipPortalError } = require('../core/browser');
const { withRetry } = require('../core/retry');
const { scoreJob, shouldApply } = require('../core/filter');
const logger = require('../core/logger');

const QUERIES = [
  'react native developer',
  'mobile developer',
  'frontend engineer react',
  'full stack developer node react',
];
const MAX_APPS_PER_RUN = 10;

class MailtoApplyError extends Error {
  constructor() {
    super('skipped — YourStory apply is mailto only (no on-site form)');
    this.name = 'MailtoApplyError';
  }
}

function searchUrl(query) {
  return `https://yourstory.com/jobs?search=${encodeURIComponent(query)}`;
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

    // Careers openings: /jobs/details/<uuid>
    const detailLinks = Array.from(document.querySelectorAll('a[href*="/jobs/details/"]'));
    const fromDetails = detailLinks.map((a) => {
      const title = (a.textContent || '').trim().replace(/\s+/g, ' ');
      const block = (a.closest('a, li, div, article')?.innerText || title).replace(/\s+/g, ' ');
      const company = /yourstory/i.test(block) ? 'YourStory Media' : 'YourStory Media';
      return {
        title: title.split(/Bangalore|Bengaluru|Remote|India/i)[0].trim() || title,
        url: abs(a.getAttribute('href')).replace(/#$/, ''),
        company,
        experienceText: '',
        text: block.slice(0, 1200),
      };
    });

    // Fallback: heading + location cards on the Work with Us page
    const headings = Array.from(document.querySelectorAll('h2, h3, a'))
      .filter((el) => {
        const t = (el.textContent || '').trim();
        return t.length > 5 && t.length < 120 && /manager|reporter|engineer|developer|designer|intern/i.test(t);
      })
      .map((el) => {
        const title = (el.textContent || '').trim().replace(/\s+/g, ' ');
        const href = el.closest('a')?.href || el.href || '';
        return {
          title,
          url: href && /\/jobs\//.test(href) ? abs(href).replace(/#$/, '') : '',
          company: 'YourStory Media',
          experienceText: '',
          text: title,
        };
      })
      .filter((c) => c.url);

    const seen = new Set();
    const out = [];
    for (const c of [...fromDetails, ...headings]) {
      if (!c.url || seen.has(c.url)) continue;
      seen.add(c.url);
      out.push(c);
    }
    return out;
  });
}

async function applyToJob(browser, job) {
  const page = await browser.newPage();
  try {
    await withRetry(() => page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 }), {
      maxAttempts: 2,
    });
    await new Promise((r) => setTimeout(r, 1500));
    await checkForCaptcha(page);

    if (await page.$('input[type="password"]')) {
      throw new SkipPortalError('login required — sign in once via `npm run login`');
    }

    const outcome = await page.evaluate(() => {
      const mailto = Array.from(document.querySelectorAll('a[href^="mailto:"]')).find((a) =>
        /hr@|careers@|apply|job/i.test(a.href + a.textContent)
      );
      if (mailto) return 'mailto';

      const applyBtn = Array.from(document.querySelectorAll('button, a')).find((b) =>
        /^apply( now)?$/i.test((b.textContent || '').trim())
      );
      if (applyBtn) {
        applyBtn.click();
        return 'clicked';
      }
      return 'none';
    });

    if (outcome === 'mailto') throw new MailtoApplyError();
    if (outcome === 'none') throw new Error('Apply button not found on YourStory job page');

    await new Promise((r) => setTimeout(r, 1500));
    const confirmed = await page.evaluate(() =>
      /thank you|application (sent|submitted)|successfully submitted/i.test(document.body?.innerText || '')
    );
    if (!confirmed) throw new Error('no application confirmation on YourStory');
  } finally {
    await page.close().catch(() => {});
  }
}

async function run({ dedup, dryRun, newPage, browser }) {
  const results = { reviewed: 0, applied: [], skipped: [], failed: [] };
  const page = await newPage();

  try {
    // Search params are ignored by the site — one careers page covers all queries.
    await withRetry(() => page.goto(searchUrl(QUERIES[0]), { waitUntil: 'domcontentloaded' }), {
      maxAttempts: 2,
    });
    await page.waitForSelector('a[href*="/jobs/details/"], h1, h2', { timeout: 15000 }).catch(() => {});
    await checkForCaptcha(page);

    const cards = await extractCards(page);
    results.reviewed = cards.length;
    logger.info(`[yourstory] careers page: ${cards.length} openings (startup job board no longer exists)`);

    if (cards.length === 0) {
      results.note =
        'YourStory /jobs is YourStory Media internal careers only — no searchable startup job board';
      return results;
    }

    for (const card of cards) {
      if (results.applied.length >= MAX_APPS_PER_RUN) break;
      if (dedup.has(card.url)) continue;

      const score = scoreJob({ title: card.title, description: card.text, experienceText: card.experienceText });
      const job = { title: card.title, company: card.company, url: card.url };

      if (!shouldApply(score)) {
        job.reason = `score ${score} below threshold`;
        results.skipped.push(job);
        if (!dryRun) {
          dedup.append({
            site: 'YourStory',
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
        logger.info(`[yourstory] DRY RUN would apply: ${card.title} @ ${card.company} (score ${score})`);
        continue;
      }

      try {
        await withRetry(() => applyToJob(browser, card), { maxAttempts: 2 });
        results.applied.push(job);
        dedup.append({
          site: 'YourStory',
          job_title: card.title,
          company: card.company,
          job_url: card.url,
          status: 'applied',
          notes: `auto-applied (score ${score})`,
        });
        logger.info(`[yourstory] applied: ${card.title} @ ${card.company}`);
      } catch (err) {
        if (err instanceof MailtoApplyError || err instanceof SkipPortalError) {
          job.reason = err.message;
          results.skipped.push(job);
          dedup.append({
            site: 'YourStory',
            job_title: card.title,
            company: card.company,
            job_url: card.url,
            status: 'skipped',
            notes: err.message,
          });
          logger.info(`[yourstory] skipped: ${card.title} — ${err.message}`);
          if (err instanceof SkipPortalError) throw err;
        } else {
          job.reason = err.message;
          results.failed.push(job);
          dedup.append({
            site: 'YourStory',
            job_title: card.title,
            company: card.company,
            job_url: card.url,
            status: 'failed',
            notes: err.message,
          });
          logger.warn(`[yourstory] failed: ${card.title} — ${err.message}`);
        }
      }

      await humanDelay(2000, 3000);
    }
  } finally {
    await page.close().catch(() => {});
  }

  return results;
}

module.exports = { run, searchUrl, extractCards };
