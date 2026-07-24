/**
 * Cutshort bot — Indian quick-apply job board.
 *
 * Category listing pages work best:
 *   https://cutshort.io/jobs/react-native-jobs
 * Job detail:
 *   https://cutshort.io/job/<Slug>-<id>
 *
 * Apply button: "Apply to this job" / "Apply now". Requires candidate session
 * (npm run login). Never fills passwords; CTC only if present in profile.
 */
const { humanDelay, checkForCaptcha, SkipPortalError } = require('../core/browser');
const { withRetry, isUiError } = require('../core/retry');
const { scoreJob, shouldApply, parseExperienceRange } = require('../core/filter');
const logger = require('../core/logger');

const QUERIES = [
  'react native developer',
  'mobile developer',
  'frontend engineer react',
  'full stack developer node react',
];
const MAX_APPS_PER_RUN = 10;

class ExternalAtsError extends Error {
  constructor(msg = 'skipped — external ATS / no on-site apply') {
    super(msg);
    this.name = 'ExternalAtsError';
  }
}

function queryToSlug(query) {
  const q = query.toLowerCase();
  if (/react native/.test(q)) return 'react-native';
  if (/mobile/.test(q)) return 'mobile-developer';
  if (/frontend|front-end|react/.test(q)) return 'frontend-developer';
  if (/full.?stack|node/.test(q)) return 'fullstack-developer';
  return query
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function searchUrl(query) {
  // Category pages render job cards; ?q= lands on a category index.
  return `https://cutshort.io/jobs/${queryToSlug(query)}-jobs`;
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

    const anchors = Array.from(document.querySelectorAll('a[href*="/job/"]'));
    const seen = new Set();
    const cards = [];

    for (const a of anchors) {
      const href = abs(a.getAttribute('href'));
      // Individual jobs: /job/Title-Company-id  (not /jobs/category)
      if (!/\/job\/[^/]+/.test(href) || /\/jobs\//.test(href)) continue;
      if (seen.has(href)) continue;
      seen.add(href);

      const block =
        a.closest('section, article, li, [class*="job"], [class*="card"], div') || a.parentElement;
      let walk = a.parentElement;
      for (let i = 0; i < 6 && walk; i++) {
        if (/\bat\s+\S+/i.test(walk.innerText || '') && /yrs|Apply now/i.test(walk.innerText || '')) {
          break;
        }
        walk = walk.parentElement;
      }
      const scope = walk || block;
      const text = (scope?.innerText || a.textContent || '').replace(/\s+/g, ' ').slice(0, 1200);

      const heading = scope?.querySelector?.('h2, h3');
      let title = (heading?.textContent || a.textContent || '').trim().replace(/\s+/g, ' ');
      if (!title || title.length < 3 || /^apply/i.test(title) || /^at /i.test(title)) {
        const fromUrl = href.split('/job/')[1] || '';
        title = fromUrl
          .replace(/-[A-Za-z0-9]{6,}$/, '')
          .replace(/-/g, ' ')
          .trim();
      }

      let company = '';
      const atEl = Array.from(scope?.querySelectorAll?.('h3, h4, p, span, a') || []).find((el) =>
        /^at\s+/i.test((el.textContent || '').trim())
      );
      if (atEl) company = (atEl.textContent || '').replace(/^at\s+/i, '').trim();
      if (!company) {
        const companyMatch = text.match(/\bat\s+([^|]+?)(?:\s+Posted by|\s+Apply now|\s+\d+\s*-\s*\d+\s*yrs)/i);
        company = (companyMatch?.[1] || '').trim();
      }

      const expMatch = text.match(/(\d+\s*-\s*\d+\s*yrs?|\d+\+?\s*yrs?)/i);

      cards.push({
        title,
        url: href.split('?')[0],
        company,
        experienceText: (expMatch?.[1] || '').trim(),
        text,
      });
    }
    return cards.filter((c) => c.url && c.title);
  });
}

function fillScreeningFields(page, profile) {
  return page.evaluate((profile) => {
    const setVal = (el, value) => {
      el.focus();
      el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const years = profile.experience_years != null ? String(Math.round(Number(profile.experience_years))) : '';
    const notice = profile.notice_period_days != null ? String(profile.notice_period_days) : '';
    const currentCtc = profile.current_ctc || profile.salary_current || '';
    const expectedCtc = profile.expected_ctc || profile.salary_expected || '';
    const phone = profile.phone || '';
    const email = profile.email || '';
    const name = profile.name || '';

    const unanswered = [];
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (el.type === 'hidden' || el.type === 'password' || el.type === 'file' || el.type === 'checkbox' || el.type === 'radio') {
        continue;
      }
      const label = `${el.labels?.[0]?.innerText || ''} ${el.getAttribute('aria-label') || ''} ${el.placeholder || ''} ${el.name || ''}`.toLowerCase();
      if (el.value) continue;

      if (/email/.test(label) && email) setVal(el, email);
      else if (/phone|mobile|whatsapp/.test(label) && phone) setVal(el, phone.replace(/^\+91-?/, ''));
      else if (/full name|your name|^name$/.test(label) && name) setVal(el, name);
      else if (/notice/.test(label) && notice) setVal(el, notice);
      else if (/current.*(ctc|salary|compensation)/.test(label)) {
        if (currentCtc) setVal(el, currentCtc);
      } else if (/expected.*(ctc|salary|compensation)|ctc|salary/.test(label)) {
        if (expectedCtc) setVal(el, expectedCtc);
      } else if (/experience|years/.test(label) && years) setVal(el, years);

      const required = el.required || el.getAttribute('aria-required') === 'true';
      if (required && !el.value) {
        unanswered.push((el.labels?.[0]?.innerText || el.placeholder || el.name || el.type).slice(0, 60));
      }
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
    await checkForCaptcha(page);

    // Candidate login wall
    const loginWall = await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      const hasApply = Array.from(document.querySelectorAll('button, a')).some((b) =>
        /apply to this job|apply now/i.test(b.textContent || '')
      );
      if (/candidate login|sign in to apply|login to apply/i.test(text) && !hasApply) return true;
      return !!document.querySelector('input[type="password"]');
    });
    if (loginWall) {
      throw new SkipPortalError('login required — sign in once via `npm run login`');
    }

    const outcome = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, a'));
      const apply = buttons.find((b) => /apply to this job|^apply now$/i.test((b.textContent || '').trim()));
      if (apply) {
        apply.click();
        return 'clicked';
      }
      const external = buttons.find((b) => /apply on company|company website|external/i.test(b.textContent || ''));
      if (external) return 'external';
      if (buttons.some((b) => /candidate login|login to apply/i.test(b.textContent || ''))) return 'login';
      return 'none';
    });

    if (outcome === 'external') throw new ExternalAtsError();
    if (outcome === 'login') throw new SkipPortalError('login required — sign in once via `npm run login`');
    if (outcome !== 'clicked') throw new Error('Apply button not found on Cutshort job page');

    await new Promise((r) => setTimeout(r, 2000));

    // Multi-step screening modal
    for (let step = 0; step < 6; step++) {
      if (await page.$('input[type="password"]')) {
        throw new SkipPortalError('login required — sign in once via `npm run login`');
      }

      const filled = await fillScreeningFields(page, profile);
      if (!filled.ok) {
        throw new Error(`unanswered required fields: ${filled.unanswered.join('; ')}`);
      }

      const advanced = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button, a')).find((b) =>
          /submit|send application|apply|next|continue/i.test((b.textContent || '').trim()) &&
          !/candidate login|employer login/i.test(b.textContent || '') &&
          !b.disabled
        );
        if (!btn) return null;
        const label = (btn.textContent || '').trim();
        btn.click();
        return label;
      });

      if (!advanced) break;
      await new Promise((r) => setTimeout(r, 1200));
      if (/submit|send application|^apply$/i.test(advanced)) break;
    }

    const confirmed = await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      return /application (sent|submitted)|successfully applied|applied successfully|screening submitted|we have received/i.test(
        text
      );
    });
    if (!confirmed) throw new Error('no application confirmation on Cutshort');
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
      await page.waitForSelector('a[href*="/job/"]', { timeout: 20000 }).catch(() => {});
      await checkForCaptcha(page);

      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await new Promise((r) => setTimeout(r, 600));
      }

      const cards = await extractCards(page);
      results.reviewed += cards.length;
      logger.info(`[cutshort] "${query}": ${cards.length} cards`);

      for (const card of cards) {
        if (results.applied.length >= MAX_APPS_PER_RUN) break;
        if (dedup.has(card.url)) continue;

        const range = parseExperienceRange(card.experienceText);
        if (range && (range.min > 3.5 || range.max < 1.5)) {
          const job = {
            title: card.title,
            company: card.company,
            url: card.url,
            reason: `experience ${card.experienceText} out of range`,
          };
          results.skipped.push(job);
          if (!dryRun) {
            dedup.append({
              site: 'Cutshort',
              job_title: card.title,
              company: card.company,
              job_url: card.url,
              status: 'skipped',
              notes: job.reason,
            });
          }
          continue;
        }

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
              site: 'Cutshort',
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
          logger.info(`[cutshort] DRY RUN would apply: ${card.title} @ ${card.company} (score ${score})`);
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
            logger.warn(`[cutshort] attempt ${attempt} failed for "${card.title}": ${err.message}`);
            await humanDelay(1500, 2500);
          }
        }

        if (lastErr instanceof SkipPortalError) throw lastErr;

        if (lastErr instanceof ExternalAtsError || (lastErr && /unanswered required/i.test(lastErr.message))) {
          job.reason = lastErr.message;
          results.skipped.push(job);
          dedup.append({
            site: 'Cutshort',
            job_title: card.title,
            company: card.company,
            job_url: card.url,
            status: 'skipped',
            notes: lastErr.message,
          });
          logger.info(`[cutshort] skipped: ${card.title} — ${lastErr.message}`);
        } else if (lastErr) {
          job.reason = lastErr.message;
          results.failed.push(job);
          dedup.append({
            site: 'Cutshort',
            job_title: card.title,
            company: card.company,
            job_url: card.url,
            status: 'failed',
            notes: lastErr.message,
          });
        } else {
          results.applied.push(job);
          dedup.append({
            site: 'Cutshort',
            job_title: card.title,
            company: card.company,
            job_url: card.url,
            status: 'applied',
            notes: `auto-applied (score ${score})`,
          });
          logger.info(`[cutshort] applied: ${card.title} @ ${card.company}`);
        }

        await humanDelay(2000, 3000);
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  return results;
}

module.exports = { run, searchUrl, extractCards };
