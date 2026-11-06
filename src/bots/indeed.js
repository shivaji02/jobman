/**
 * Indeed India (in.indeed.com) bot.
 *
 * Search:  https://in.indeed.com/jobs?q=<q>&l=<city>&fromage=3&sort=date
 * Result cards carry a stable job key (data-jk), so the dedup key is
 * https://in.indeed.com/viewjob?jk=<jk> (dedup keeps the ?jk= — see core/dedup.js).
 * Each eligible job is opened in its own tab at that URL: "Apply now" runs the
 * smartapply flow in the same tab, which would otherwise destroy the results list.
 *
 * Audit 2026-11-05:
 *   - every Indeed job was silently dropped because dedup stripped ?jk=
 *   - the flow takes ~5-8 s to load; the old walker looked after 1.2 s, saw no
 *     button and handed off "unrecognised apply step" — now waits for the step
 *   - the results page carries decoy [data-jk] nodes (e.g. cdef0123456789ab);
 *     only visible cards with a title link are used
 *
 * Policy:
 *   - sign-in wall / password field → SkipPortalError (never enter credentials)
 *   - Cloudflare / CAPTCHA challenge → checkForCaptcha skips the portal
 *   - "Apply now" (Indeed Apply, smartapply.indeed.com): click through only
 *     Continue/Submit steps that need no typed answers; any real question
 *     → manual-apply with the tab left open for the user
 *   - "Apply on company site" → manual-apply, tab left open
 */
const { humanDelay, blockHeavyAssets, checkForCaptcha, SkipPortalError, createTabTracker, closePageQuietly, settleAttemptPages } = require('../core/browser');
const { withRetry } = require('../core/retry');
const { scoreJob, shouldApply, parseExperienceRange } = require('../core/filter');
const { classifyLocation, byLocationPreference, SEARCH_CITIES } = require('../core/location');
const { selectResume } = require('./wellfound');
const logger = require('../core/logger');
const { planAnswers } = require('../core/screening');
const { waitForSuccess, capture, evidenceNote } = require('../core/evidence');
const { emptyResults, admit } = require('../core/disposition');

const QUERIES = [
  'react native developer',
  'react native engineer',
  'mobile app developer',
  'react developer',
  'full stack developer node react',
];
const MAX_APPS_PER_RUN = Number(process.env.JOBMAN_MAX_APPS) || 30;
const MAX_FLOW_STEPS = 10;
const STEP_WAIT_MS = 20_000;
const SITE = 'Indeed';

function searchUrl(query, city = 'Hyderabad') {
  return `https://in.indeed.com/jobs?q=${encodeURIComponent(query)}&l=${encodeURIComponent(city)}&fromage=3&sort=date`;
}

function jobKey(jk) {
  return `https://in.indeed.com/viewjob?jk=${jk}`;
}

function isLoggedOut(page) {
  return page.evaluate(
    () =>
      !!document.querySelector('input[type="password"]') ||
      /\/auth|\/account\/login/i.test(location.pathname)
  );
}

async function extractCards(page) {
  return page.evaluate(() => {
    const clean = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight));
    const seen = new Set();
    return Array.from(document.querySelectorAll('.job_seen_beacon, [data-testid="slider_item"]'))
      .map((card) => {
        const link = card.querySelector('a[data-jk], h2.jobTitle a, a.jcs-JobTitle');
        const jk = link?.getAttribute('data-jk') || card.querySelector('[data-jk]')?.getAttribute('data-jk');
        return {
          jk,
          visible: visible(card) && visible(link),
          title: clean(card.querySelector('h2.jobTitle, [class*="jobTitle"]')),
          company: clean(card.querySelector('[data-testid="company-name"]')),
          location: clean(card.querySelector('[data-testid="text-location"]')),
          text: clean(card).slice(0, 1200),
        };
      })
      .filter((c) => c.jk && /^[0-9a-f]{16}$/.test(c.jk) && c.visible && c.title && !seen.has(c.jk) && seen.add(c.jk));
  });
}

/** Detect which apply control the job page offers. */
function applyKind(page) {
  return page.evaluate(() => {
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight);
    const btns = Array.from(document.querySelectorAll('button, a')).filter(visible);
    const txt = (b) => (b.textContent || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (btns.some((b) => /^applied\b/i.test(txt(b)))) return 'already-applied';
    if (/you applied (to this job )?on|application submitted on/i.test(document.body.innerText)) return 'already-applied';
    if (btns.some((b) => /apply on company site/i.test(txt(b)))) return 'company-site';
    if (document.querySelector('#indeedApplyButton, button[id*="indeedApply"]')) return 'indeed-apply';
    if (btns.some((b) => /^(easily )?apply now/i.test(txt(b)))) return 'indeed-apply';
    if (/this job has expired|no longer available|job is closed/i.test(document.body.innerText)) return 'expired';
    return '';
  });
}

const FLOW_BUTTON_RE = /^(continue|review( your application)?|submit( your application)?|apply)$/i;

/** Wait for the next actionable state of the smartapply flow. */
async function flowState(flowPage) {
  return flowPage
    .waitForFunction(
      (src) => {
        const re = new RegExp(src, 'i');
        const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight));
        const text = document.body?.innerText || '';
        if (/your application has been submitted|application (has been )?submitted|you('|’)ve applied|applied successfully/i.test(text)) return { kind: 'done' };
        if (Array.from(document.querySelectorAll('input[type="password"]')).some(visible)) return { kind: 'login' };
        if (Array.from(document.querySelectorAll('iframe[src*="recaptcha/api2/bframe"], iframe[src*="hcaptcha.com"]')).some(visible)) return { kind: 'captcha' };
        if (/verify (it'?s|you are) (you|human)|one-time (code|password)|enter the code/i.test(text)) return { kind: 'otp' };
        const btn =
          document.querySelector('[data-testid="continue-button"]') ||
          Array.from(document.querySelectorAll('button')).find((b) => visible(b) && re.test((b.textContent || '').trim()));
        if (btn && visible(btn)) return { kind: 'step', label: (btn.textContent || '').trim() };
        return false;
      },
      { timeout: STEP_WAIT_MS, polling: 400 },
      FLOW_BUTTON_RE.source
    )
    .then((h) => h.jsonValue())
    .catch(() => ({ kind: 'timeout' }));
}

/** Collect unanswered questions on the current flow step (tags them with data-jm ids). */
function collectQuestions(flowPage) {
  return flowPage.evaluate(() => {
    const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const out = [];
    let n = 0;
    const tag = (el) => {
      const id = `jm-${n++}`;
      el.setAttribute('data-jm', id);
      return id;
    };
    const main = document.querySelector('main') || document.body;
    for (const el of main.querySelectorAll('input, select, textarea')) {
      if (!visible(el) || ['hidden', 'radio', 'checkbox', 'file', 'submit', 'button', 'search'].includes(el.type)) continue;
      if (/g-recaptcha|current page/i.test(`${el.name} ${el.getAttribute('aria-label') || ''}`)) continue;
      if (el.value) continue;
      const q = textOf(el.labels?.[0]) || el.getAttribute('aria-label') || textOf(el.closest('fieldset')?.querySelector('legend')) || textOf(el.parentElement);
      out.push({
        id: tag(el),
        question: q.slice(0, 220),
        type: el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : el.type || 'text',
        options: el.tagName === 'SELECT' ? Array.from(el.options).map(textOf).filter(Boolean) : [],
        required: !/\(optional\)/i.test(q),
      });
    }
    for (const group of main.querySelectorAll('fieldset, [role="radiogroup"]')) {
      const radios = Array.from(group.querySelectorAll('input[type="radio"]'));
      if (!radios.length || radios.some((r) => r.checked)) continue;
      if (radios.some((r) => r.name === 'resume-selection')) continue;
      const q = textOf(group.querySelector('legend')) || group.getAttribute('aria-label') || textOf(group).slice(0, 200);
      out.push({ id: tag(group), question: q.slice(0, 220), type: 'radio', options: radios.map((r) => textOf(r.labels?.[0]) || r.value), required: !/\(optional\)/i.test(q) });
    }
    return out;
  });
}

function writeAnswers(flowPage, answers) {
  return flowPage.evaluate((answers) => {
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    for (const [id, v] of Object.entries(answers)) {
      const el = document.querySelector(`[data-jm="${id}"]`);
      if (!el) continue;
      if (el.tagName === 'FIELDSET' || el.getAttribute('role') === 'radiogroup') {
        const r = Array.from(el.querySelectorAll('input[type="radio"]')).find((r) => (textOf(r.labels?.[0]) || r.value) === v);
        if (r) r.click();
      } else if (el.tagName === 'SELECT') {
        const o = Array.from(el.options).find((o) => textOf(o) === v || o.value === v);
        if (o) {
          el.value = o.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        el.focus();
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        for (const t of ['input', 'change', 'blur']) el.dispatchEvent(new Event(t, { bubbles: true }));
      }
    }
  }, answers);
}

/**
 * Walk the Indeed Apply flow, answering only what candidate.json can answer.
 * Returns { status: applied|unconfirmed|manual-apply, reason?, evidence?, submitted }.
 */
async function walkIndeedApply(flowPage, profile, key) {
  let submitted = false;
  let lastSignature = '';
  for (let step = 0; step < MAX_FLOW_STEPS; step++) {
    const state = await flowState(flowPage);
    if (state.kind === 'done') {
      const evidence = await capture(flowPage, { portal: 'indeed', jobKey: key, signal: 'text "application submitted"' });
      return { status: 'applied', evidence, submitted: true };
    }
    if (submitted) break; // submit clicked and the next state isn't the success page
    if (state.kind === 'login') throw new SkipPortalError('login required — sign in once via `npm run login`');
    if (state.kind === 'captcha') return { status: 'manual-apply', reason: 'CAPTCHA in Indeed Apply — needs you', submitted };
    if (state.kind === 'otp') return { status: 'manual-apply', reason: 'verification code (OTP) requested — needs you', submitted };
    if (state.kind === 'timeout') return { status: 'manual-apply', reason: 'unrecognised apply step', submitted };

    const fields = await collectQuestions(flowPage);
    const { answers, missing } = planAnswers(fields, profile);
    if (Object.keys(answers).length) await writeAnswers(flowPage, answers);
    if (missing.length) return { status: 'manual-apply', reason: `needs your answer: ${missing.join('; ')}`, submitted };

    const signature = `${flowPage.url()}|${await flowPage.evaluate(() => (document.querySelector('main') || document.body).innerText.slice(0, 400)).catch(() => '')}`;
    if (signature === lastSignature) {
      return { status: 'manual-apply', reason: 'Indeed did not accept this step (validation) — needs your input', submitted };
    }
    lastSignature = signature;

    const isSubmit = /submit/i.test(state.label);
    await flowPage.evaluate((src) => {
      const re = new RegExp(src, 'i');
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight));
      const btn =
        document.querySelector('[data-testid="continue-button"]') ||
        Array.from(document.querySelectorAll('button')).find((b) => visible(b) && re.test((b.textContent || '').trim()));
      btn?.click();
    }, FLOW_BUTTON_RE.source);
    if (isSubmit) submitted = true;
    await humanDelay(1500, 2500);
  }

  if (submitted) {
    const signal = await waitForSuccess(flowPage, { text: ['your application has been submitted'], timeoutMs: 12000 });
    if (signal) return { status: 'applied', evidence: await capture(flowPage, { portal: 'indeed', jobKey: key, signal }), submitted };
    return { status: 'unconfirmed', reason: 'Submit clicked; no "application submitted" page', submitted };
  }
  return { status: 'manual-apply', reason: 'apply flow too long', submitted };
}

/**
 * Open the job in its own tab and apply. Returns
 * { status: applied|unconfirmed|already-applied|manual-apply|failed, page, description, ... }.
 */
async function applyToJob(browser, card, profile) {
  const page = await browser.newPage();
  const key = jobKey(card.jk);
  let submitted = false;
  try {
    await withRetry(() => page.goto(key, { waitUntil: 'domcontentloaded' }), { maxAttempts: 2 });
    await page.waitForSelector('#jobDescriptionText', { timeout: 12000 }).catch(() => {});
    await checkForCaptcha(page);
    const description = await page.evaluate(() => (document.querySelector('#jobDescriptionText')?.innerText || '').slice(0, 4000));

    const kind = await applyKind(page);
    if (!kind) return { status: 'failed', page, description, reason: 'Apply button not found' };
    if (kind === 'expired') return { status: 'expired', page, description };
    if (kind === 'already-applied') return { status: 'already-applied', page, description };

    const pagesBefore = new Set(await browser.pages());
    await page.evaluate((kind) => {
      const visible = (el) => !!(el.offsetWidth || el.offsetHeight);
      const re = kind === 'company-site' ? /apply on company site/i : /^(easily )?apply now/i;
      const btn =
        (kind === 'indeed-apply' && document.querySelector('#indeedApplyButton, button[id*="indeedApply"]')) ||
        Array.from(document.querySelectorAll('button, a')).find((b) => visible(b) && re.test((b.textContent || '').trim()));
      btn?.click();
    }, kind);
    await humanDelay(1500, 2500);

    const opened = (await browser.pages()).find((p) => !pagesBefore.has(p) && p.url() && p.url() !== 'about:blank');
    if (kind === 'company-site') {
      if (opened) await closePageQuietly(page);
      return opened
        ? { status: 'manual-apply', page: opened, description, companyUrl: opened.url(), reason: 'external company site (ATS)' }
        : { status: 'manual-apply', page, description, companyUrl: page.url(), reason: 'external company site (ATS)' };
    }

    const flowPage = opened || page;
    if (opened) await closePageQuietly(page);
    const result = await walkIndeedApply(flowPage, profile, key);
    submitted = result.submitted;
    return { ...result, page: flowPage, description, companyUrl: flowPage.url() };
  } catch (err) {
    if (err instanceof SkipPortalError) throw err;
    if (submitted) return { status: 'unconfirmed', page, reason: `error after Submit: ${err.message}` };
    return { status: 'failed', page, reason: err.message };
  }
}

function log(dedup, dryRun, card, status, notes) {
  if (dryRun) return;
  dedup.append({ site: SITE, job_title: card.title, company: card.company, job_url: jobKey(card.jk), status, notes });
}

async function run({ profile = {}, dedup, dryRun, newPage, browser }) {
  const results = emptyResults();
  const seenThisRun = new Set();
  const tabs = createTabTracker('indeed');
  const page = await newPage();
  await blockHeavyAssets(page);
  const attempted = () => results.applied.length + results.unconfirmed.length + results.manualApply.length;

  try {
    const searches = SEARCH_CITIES.flatMap((city) => QUERIES.map((query) => ({ city, query })));
    for (const { city, query } of searches) {
      if (attempted() >= MAX_APPS_PER_RUN) break;

      await withRetry(() => page.goto(searchUrl(query, city), { waitUntil: 'domcontentloaded' }), { maxAttempts: 2 });
      await page.waitForSelector('.job_seen_beacon [data-jk], a[data-jk]', { timeout: 15000 }).catch(() => {});
      await checkForCaptcha(page);
      if (!dryRun && (await isLoggedOut(page))) {
        throw new SkipPortalError('login required — sign in once via `npm run login`');
      }

      const cards = (await extractCards(page)).sort(byLocationPreference);
      results.discovered += cards.length;
      logger.info(`[indeed] "${query}" in ${city}: ${cards.length} cards`);

      for (const card of cards) {
        const key = jobKey(card.jk);
        const job = { title: card.title, company: card.company, url: key };
        if (admit(results, { key, seen: seenThisRun, dedup, job, site: SITE, dryRun }) !== 'new') continue;

        const loc = classifyLocation(card.location, card.company);
        const score = scoreJob({ title: card.title, description: card.text });
        const range = parseExperienceRange(card.text);

        let skipReason = '';
        if (!loc.allowed) skipReason = loc.reason;
        else if (range && (range.min > 3.5 || range.max < 1.5)) skipReason = `experience ${range.min}-${range.max} out of range`;
        else if (!shouldApply(score)) skipReason = `score ${score} below threshold`;
        else if (attempted() >= MAX_APPS_PER_RUN) skipReason = 'per-run cap reached';
        if (skipReason) {
          job.reason = skipReason;
          results.skipped.push(job);
          if (!/cap reached/.test(skipReason)) log(dedup, dryRun, card, 'skipped', skipReason);
          continue;
        }

        if (dryRun) {
          job.resume = selectResume(card.title, card.text);
          job.reason = `would apply (score ${score}; resume=${job.resume})`;
          results.applied.push(job);
          logger.info(`[indeed] DRY RUN would apply: ${card.title} @ ${card.company} (score ${score})`);
          continue;
        }

        // One retry, only for technical failures before anything was submitted.
        let outcome;
        const attemptPages = [];
        for (let attempt = 1; attempt <= 2; attempt++) {
          outcome = await applyToJob(browser, card, profile);
          if (outcome.page) attemptPages.push(outcome.page);
          if (outcome.status !== 'failed' || attempt === 2) break;
          logger.warn(`[indeed] attempt ${attempt} failed for "${card.title}": ${outcome.reason}`);
          await humanDelay(1500, 2500);
        }
        job.resume = selectResume(card.title, `${card.text} ${outcome.description || ''}`);
        const keepPage = ['manual-apply', 'failed', 'unconfirmed'].includes(outcome.status) ? outcome.page : null;
        await settleAttemptPages(attemptPages, keepPage);

        if (outcome.status === 'applied') {
          job.evidence = outcome.evidence;
          results.applied.push(job);
          log(dedup, dryRun, card, 'applied', `Indeed Apply (score ${score}) | ${evidenceNote(outcome.evidence)}`);
          console.log(`✅ Applied (confirmed): ${card.title} @ ${card.company}`);
        } else if (outcome.status === 'unconfirmed') {
          job.reason = outcome.reason;
          results.unconfirmed.push(job);
          tabs.trackFailed(job, outcome.companyUrl || key);
          log(dedup, dryRun, card, 'unconfirmed', outcome.reason);
        } else if (outcome.status === 'already-applied') {
          job.reason = 'already applied on Indeed';
          results.alreadyApplied.push(job);
          log(dedup, dryRun, card, 'applied', 'already applied on Indeed');
          continue;
        } else if (outcome.status === 'expired') {
          job.reason = 'posting expired';
          results.skipped.push(job);
          log(dedup, dryRun, card, 'skipped', job.reason);
          continue;
        } else if (outcome.status === 'manual-apply') {
          const entry = { ...job, companyUrl: outcome.companyUrl, reason: outcome.reason };
          results.manualApply.push(entry);
          tabs.trackManualApply(entry, entry.companyUrl);
          log(dedup, dryRun, card, 'manual-apply', `URL: ${entry.companyUrl}${outcome.reason ? ` | ${outcome.reason}` : ''} | Resume: ${job.resume}`);
          logger.info(`[indeed] → needs you: ${card.title} @ ${card.company} — ${outcome.reason}`);
        } else {
          job.reason = outcome.reason || 'apply failed';
          results.failed.push(job);
          tabs.trackFailed(job, key);
          log(dedup, dryRun, card, 'failed', job.reason);
        }
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

module.exports = { run, searchUrl, jobKey, extractCards, walkIndeedApply };
