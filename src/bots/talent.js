/**
 * Talent.com (in.talent.com) bot — job aggregator.
 *
 * Search:  https://in.talent.com/jobs?k=<query>&l=<city>
 * Job page: https://in.talent.com/view?id=<id>
 *
 * A job page has either an on-site "Quick Apply" button or an "Apply" link that
 * redirects to the employer's site (/redirect?id=...). Policy:
 *   - external apply → open the destination in a tab and LEAVE IT OPEN for the
 *     user to finish manually (status manual-apply)
 *   - Quick Apply → fill only profile-backed fields; if anything is unanswered,
 *     a login/password/CAPTCHA appears, or submission can't be confirmed, leave
 *     the tab open for manual completion
 * Never enters passwords.
 */
const { humanDelay, blockHeavyAssets, checkForCaptcha, SkipPortalError, createTabTracker, settleAttemptPages, closePageQuietly } = require('../core/browser');
const { withRetry } = require('../core/retry');
const { scoreJob, shouldApply } = require('../core/filter');
const { classifyLocation, byLocationPreference, SEARCH_CITIES } = require('../core/location');
const { selectResume, RESUME_RN, RESUME_FS } = require('./wellfound');
const logger = require('../core/logger');
const { waitForSuccess, capture, evidenceNote } = require('../core/evidence');
const { emptyResults, admit, claimGate } = require('../core/disposition');

const QUERIES = [
  'react native developer',
  'mobile developer',
  'react developer',
  'full stack developer node react',
  'react native immediate joiner',
];
const MAX_APPS_PER_RUN = Number(process.env.JOBMAN_MAX_APPS) || 30;
const SITE = 'Talent.com';

function searchUrl(query, city = 'Hyderabad') {
  return `https://in.talent.com/jobs?k=${encodeURIComponent(query)}&l=${encodeURIComponent(city)}`;
}

async function extractCards(page) {
  return page.evaluate(() => {
    const seen = new Set();
    return Array.from(document.querySelectorAll('article[class*="JobCard"]'))
      .map((card) => {
        const link = card.querySelector('a[href*="/view?id="]');
        const m = (link?.href || '').match(/[?&]id=(\d+)/);
        const url = m ? `https://in.talent.com/view?id=${m[1]}` : '';
        return {
          title: (card.querySelector('h2')?.textContent || '').trim(),
          company: (card.querySelector('[class*="JobCard_company"]')?.textContent || '').trim(),
          location: (card.querySelector('[class*="JobCard_location"]')?.textContent || '').trim(),
          url,
          text: card.textContent.replace(/\s+/g, ' ').slice(0, 1200),
        };
      })
      .filter((c) => c.url && !seen.has(c.url) && seen.add(c.url));
  });
}

/** Dismiss the cookie banner by declining non-essential cookies, if present. */
async function dismissCookies(page) {
  await page
    .evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        /^(reject|decline|necessary only|only necessary)/i.test((b.textContent || '').trim())
      );
      if (btn) btn.click();
    })
    .catch(() => {});
}

/** Find what the job page offers: { quick: bool, externalHref: string } */
function readApplyOptions(page) {
  return page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll('a, button'));
    const quick = controls.some((b) => /^quick apply$/i.test((b.textContent || '').trim()) && b.tagName === 'BUTTON');
    const ext = controls.find(
      (b) => b.tagName === 'A' && /^(quick apply|apply( now)?)$/i.test((b.textContent || '').trim()) && b.getAttribute('href')
    );
    return { quick, externalHref: ext ? new URL(ext.getAttribute('href'), location.href).href : '' };
  });
}

/** Fill profile-backed fields in whatever form/dialog is open. */
function fillQuickApplyForm(page, profile) {
  return page.evaluate((profile) => {
    const root = document.querySelector('[role="dialog"], form') || document;
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight);
    const [first, ...rest] = String(profile.name || '').split(' ');
    const unanswered = [];
    for (const el of Array.from(root.querySelectorAll('input:not([type=hidden]):not([type=file]):not([type=checkbox]), textarea, select')).filter(visible)) {
      const label = `${el.labels?.[0]?.innerText || ''} ${el.name || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
      if (el.type === 'password') return { ok: false, reason: 'password requested', unanswered: ['password'] };
      let value = '';
      if (/e-?mail/.test(label)) value = profile.email;
      else if (/first/.test(label)) value = first;
      else if (/last|surname/.test(label)) value = rest.join(' ');
      else if (/phone|mobile/.test(label)) value = String(profile.phone || '').replace(/^\+91-?/, '');
      else if (/name/.test(label)) value = profile.name;
      else if (/notice/.test(label)) value = 'Immediate';
      if (value && !el.value) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
        setter ? setter.call(el, value) : (el.value = value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (!el.value && el.required) {
        unanswered.push(label.trim().slice(0, 60));
      }
    }
    return { ok: unanswered.length === 0, unanswered };
  }, profile);
}

async function applyToJob(browser, job, profile) {
  const page = await browser.newPage();
  await blockHeavyAssets(page);
  const resume = selectResume(job.title, job.text);
  try {
    await withRetry(() => page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 }), { maxAttempts: 2 });
    // Wait for the apply control to hydrate instead of a fixed 2s sleep.
    await page
      .waitForFunction(
        () => Array.from(document.querySelectorAll('a, button')).some((b) => /^(quick apply|apply( now)?)$/i.test((b.textContent || '').trim())),
        { timeout: 8000 }
      )
      .catch(() => {});
    await dismissCookies(page);
    await checkForCaptcha(page);

    const options = await readApplyOptions(page);

    if (options.quick) {
      await page.evaluate(() => {
        Array.from(document.querySelectorAll('button')).find((b) => /^quick apply$/i.test((b.textContent || '').trim()))?.click();
      });
      await page.waitForSelector('[role="dialog"], form input', { timeout: 3000 }).catch(() => {});
      if (await page.$('input[type="password"]')) {
        return { status: 'manual-apply', page, resume, companyUrl: page.url(), note: 'login/password requested' };
      }
      const filled = await fillQuickApplyForm(page, profile);
      const fileInput = await page.$('input[type="file"]');
      if (fileInput) await fileInput.uploadFile(resume).catch(() => {});
      if (filled.ok) {
        const clicked = await page.evaluate(() => {
          const root = document.querySelector('[role="dialog"], form') || document;
          const btn = Array.from(root.querySelectorAll('button, input[type=submit]')).find((b) =>
            /^(submit|send|apply|apply now|submit application)$/i.test((b.textContent || b.value || '').trim())
          );
          if (btn) btn.click();
          return !!btn;
        });
        if (clicked) {
          // "applied"/"thank you" alone matched almost any page — use the strict shared signals.
          const signal = await waitForSuccess(page, { timeoutMs: 8000 });
          if (signal) return { status: 'applied', page, resume, evidence: await capture(page, { portal: 'talent', jobKey: job.url, signal }) };
          return { status: 'unconfirmed', page, resume, reason: 'Quick Apply submitted; no confirmation shown' };
        }
      }
      return {
        status: 'manual-apply',
        page,
        resume,
        companyUrl: page.url(),
        note: filled.unanswered?.length ? `unanswered: ${filled.unanswered.join(', ')}` : 'quick apply not confirmed',
      };
    }

    if (options.externalHref) {
      // Don't follow /redirect in the bot: Talent's CloudFront blocks bursts of
      // automated redirect hits with 403. The job tab stays open (its Apply link
      // works when you click it) and the redirect URL is logged for manual use.
      return { status: 'manual-apply', page, resume, companyUrl: options.externalHref, note: 'external apply' };
    }

    return { status: 'failed', page, resume, reason: 'no apply control found' };
  } catch (err) {
    return { status: 'failed', page, resume, reason: err.message };
  }
}

function log(dedup, dryRun, card, status, notes) {
  if (dryRun) return;
  dedup.append({ site: SITE, job_title: card.title, company: card.company, job_url: card.url, status, notes });
}

async function run({ profile = {}, dedup, dryRun, newPage, browser }) {
  const results = emptyResults();
  const seenThisRun = new Set();
  const tabs = createTabTracker('talent');
  const page = await newPage();
  await blockHeavyAssets(page);

  try {
    const searches = SEARCH_CITIES.flatMap((city) => QUERIES.map((query) => ({ city, query })));
    for (const { city, query } of searches) {
      if (results.applied.length + results.unconfirmed.length + results.manualApply.length >= MAX_APPS_PER_RUN) break;

      await withRetry(() => page.goto(searchUrl(query, city), { waitUntil: 'domcontentloaded' }), { maxAttempts: 2 });
      await dismissCookies(page);
      await page.waitForSelector('article[class*="JobCard"]', { timeout: 15000 }).catch(() => {});
      await checkForCaptcha(page);

      const cards = (await extractCards(page)).sort(byLocationPreference);
      results.discovered += cards.length;
      logger.info(`[talent] "${query}" in ${city}: ${cards.length} cards`);

      for (const card of cards) {
        const job = { title: card.title, company: card.company, url: card.url };
        if (admit(results, { key: card.url, seen: seenThisRun, dedup, job, site: SITE, dryRun }) !== 'new') continue;

        const loc = classifyLocation(card.location, card.company);
        const score = scoreJob({ title: card.title, description: card.text });

        if (!loc.allowed || !shouldApply(score)) {
          job.reason = !loc.allowed ? loc.reason : `score ${score} below threshold`;
          results.skipped.push(job);
          log(dedup, dryRun, card, 'skipped', job.reason);
          continue;
        }
        if (results.applied.length + results.unconfirmed.length + results.manualApply.length >= MAX_APPS_PER_RUN) {
          job.reason = 'per-run cap reached';
          results.skipped.push(job);
          continue;
        }

        // Parallel runs: atomically claim the job across portal workers (no-op otherwise).
        if (!(await claimGate(results, dedup, card.url, job))) continue;

        if (dryRun) {
          job.reason = `would apply (score ${score}; ${loc.reason})`;
          results.applied.push(job);
          logger.info(`[talent] DRY RUN would apply: ${card.title} @ ${card.company} (score ${score})`);
          continue;
        }

        const outcome = await applyToJob(browser, card, profile);
        const keepPage = outcome.status === 'applied' ? null : outcome.page;
        await settleAttemptPages(outcome.page ? [outcome.page] : [], keepPage);

        if (outcome.status === 'applied') {
          job.evidence = outcome.evidence;
          results.applied.push(job);
          log(dedup, dryRun, card, 'applied', `quick apply (score ${score}) | ${evidenceNote(outcome.evidence)}`);
          console.log(`✅ Applied (confirmed): ${card.title} @ ${card.company}`);
        } else if (outcome.status === 'unconfirmed') {
          job.reason = outcome.reason;
          results.unconfirmed.push(job);
          tabs.trackFailed(job, card.url);
          log(dedup, dryRun, card, 'unconfirmed', outcome.reason);
        } else if (outcome.status === 'manual-apply') {
          const entry = { ...job, companyUrl: outcome.companyUrl || card.url, resume: outcome.resume, reason: outcome.note || 'external apply (aggregator redirect)' };
          results.manualApply.push(entry);
          tabs.trackManualApply(entry, entry.companyUrl);
          log(dedup, dryRun, card, 'manual-apply', `URL: ${entry.companyUrl} | ${outcome.note || ''} | Resume: ${outcome.resume}`);
          logger.info(`[talent] → Tab OPEN and ready for manual apply: ${card.title} @ ${card.company}`);
        } else {
          job.reason = outcome.reason || 'apply failed';
          results.failed.push(job);
          tabs.trackFailed(job, card.url);
          log(dedup, dryRun, card, 'failed', job.reason);
        }
        await humanDelay(); // 2-3.5s, per CLAUDE.md rate-limit rule
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

module.exports = { run, searchUrl, extractCards, RESUME_RN, RESUME_FS };
