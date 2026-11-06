/**
 * Employer ATS application adapters: Greenhouse, Lever, Ashby,
 * SmartRecruiters (form-filling) and Workday (hand-off — needs an account).
 *
 * applyOnAts(page, job, { profile, dryRun }) → outcome
 *   { status: 'applied', evidence, submitted: true }
 *   { status: 'unconfirmed', reason, submitted: true }     submit clicked, no proof — never resubmitted
 *   { status: 'manual-apply', reason, submitted: false }   CAPTCHA, login, answer only the user has
 *   { status: 'closed', reason }                           posting no longer open
 *   { status: 'failed', reason, submitted: false }         technical error before submit (retry safe)
 *   { status: 'would-apply', plan }                        dry run: everything but the submit click
 *
 * Safety: never types passwords, never creates accounts, never solves CAPTCHAs,
 * never answers a required question the profile cannot answer (see answers.js).
 */
const { installDeepHelpers, collectQuestions, fillQuestion, comboboxOptions, unfilledRequired, challengeVisible } = require('./form');
const { planForm } = require('./answers');
const { waitForSuccess, capture } = require('../core/evidence');
const logger = require('../core/logger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CLOSED_RE = /no longer (accepting|available|open)|position (has been )?(filled|closed)|job (is )?(not found|closed|expired)|this job (posting )?(has )?expired|page (you.re looking for )?(could not be|cannot be|was not) found|404/i;

const ADAPTERS = {
  greenhouse: {
    formUrl: (job) => job.applyUrl || job.url,
    root: '#application-form, form#application_form, form',
    submit: 'button[type="submit"], #submit_app',
    success: { text: ['thank you for applying', 'application (has been )?(received|submitted)', 'we(?:\'|’)?ve received your application'], url: /confirmation|thank/i },
  },
  lever: {
    formUrl: (job) => (job.url.endsWith('/apply') ? job.url : `${job.url.replace(/\/$/, '')}/apply`),
    root: '#application-form, form',
    submit: '#btn-submit, button[type="submit"]',
    success: { text: ['application submitted', 'thanks for applying'], url: /\/thanks/ },
  },
  ashby: {
    formUrl: (job) => (/\/application$/.test(job.url) ? job.url : `${job.url.replace(/\/$/, '')}/application`),
    root: '.ashby-application-form-container, form',
    submitText: /^submit application$/i,
    success: { text: ['successfully submitted', 'thanks for applying', 'application (was )?(submitted|received)'] },
    rejected: /flagged as (possible )?spam|missing entry for required field|please (fill|complete)/i,
  },
  smartrecruiters: {
    formUrl: (job) => job.applyUrl || job.url,
    open: async (page) => {
      // Posting page → "I'm interested" opens the one-click application form.
      if (/oneclick-ui/.test(page.url())) {
        await page.waitForSelector('>>> #first-name-input', { timeout: 20_000 }).catch(() => {});
        return;
      }
      const clicked = await page.evaluate(() => {
        const b = [...document.querySelectorAll('a, button')].find((e) => /i.?m interested|apply now|^apply$/i.test((e.innerText || '').trim()));
        if (!b) return false;
        b.click();
        return true;
      });
      if (clicked) await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20_000 }).catch(() => {});
      // The Angular one-click form renders late; wait for its first section.
      await page.waitForSelector('>>> oc-personal-information, >>> #first-name-input', { timeout: 20_000 }).catch(() => {});
      await sleep(1500);
    },
    root: 'oc-app-root, body',
    submitText: /^(submit|send)( application)?$/i,
    nextText: /^(next|continue)$/i,
    success: { text: ['thank you for (applying|your application|your interest)', 'application (has been )?(sent|submitted|received)'] },
  },
};

/** Find (and optionally click) the submit or next button — light or shadow DOM. */
async function buttonAction(page, adapter, which, click) {
  await installDeepHelpers(page);
  return page.evaluate(
    (sel, textSrc, click) => {
      const all = window.__jmQA || ((q) => [...document.querySelectorAll(q)]);
      const vis = (e) => !!(e.offsetWidth || e.offsetHeight);
      let b = sel ? all(sel).find(vis) : null;
      if (!b && textSrc) {
        const re = new RegExp(textSrc, 'i');
        // A <button> inside <spl-button> shows slotted text that lives on the host.
        const label = (e) => (e.innerText || e.value || e.textContent || '').trim() || ((e.getRootNode && e.getRootNode().host && e.getRootNode().host.textContent) || '').trim();
        b = all('button, input[type="submit"]').find((e) => vis(e) && re.test(label(e)));
      }
      if (!b || b.disabled) return false;
      if (click) {
        b.scrollIntoView({ block: 'center' });
        b.click();
      }
      return true;
    },
    which === 'submit' ? adapter.submit || '' : '',
    which === 'submit' ? (adapter.submitText ? adapter.submitText.source : '') : adapter.nextText ? adapter.nextText.source : '',
    click
  );
}
const findButton = (page, adapter, which) => buttonAction(page, adapter, which, false);
const clickButton = (page, adapter, which) => buttonAction(page, adapter, which, true);

async function visibleErrors(page) {
  await installDeepHelpers(page);
  return page.evaluate(() =>
    window.__jmQA('[class*="error"], [role="alert"], .ashby-application-form-field-entry [class*="Error"]')
      .filter((e) => e.offsetWidth || e.offsetHeight)
      .map((e) => (e.innerText || '').trim())
      .filter((t) => t && t.length < 200)
      .slice(0, 5)
  );
}

/**
 * Workday: every tenant needs its own candidate account. jobman never creates
 * one and never types a password, but it can reuse a session the user signed
 * in to once in the jobman Chrome profile. It opens the posting, reads the
 * header (a visible "Sign In" button = no session), records the result for the
 * tenant, and hands the job over with the tab left open. When a session exists
 * the tab is left on the application's first step. The multi-page Workday flow
 * (address, "how did you hear", voluntary disclosures, self-identification)
 * needs answers the profile does not hold, so it is never submitted blindly.
 */
async function workdaySession(page) {
  return page.evaluate(() => {
    const vis = (e) => !!(e && (e.offsetWidth || e.offsetHeight));
    const q = (id) => document.querySelector(`[data-automation-id="${id}"]`);
    if (vis(q('utilityButtonSignIn'))) return 'signed-out';
    if (vis(q('utilityButtonAccount')) || vis(q('accountSettingsButton')) || vis(q('utilityButtonSignOut'))) return 'signed-in';
    return 'unknown';
  });
}

async function workdayHandoff(page, job, { dryRun }) {
  const tenant = job.host || 'myworkdayjobs.com';
  try {
    await page.goto(job.url, { waitUntil: 'networkidle2', timeout: 45_000 });
  } catch (err) {
    if (!/timeout/i.test(err.message)) return { status: 'failed', submitted: false, reason: `Workday page did not load: ${err.message}` };
  }
  await page.waitForSelector('[data-automation-id="jobPostingHeader"], [data-automation-id="utilityButtonBar"]', { timeout: 15_000 }).catch(() => {});
  const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 1500)).catch(() => '');
  if (CLOSED_RE.test(text) && !/\bApply\b/.test(text)) return { status: 'closed', reason: 'Workday says the posting is closed' };
  const session = await workdaySession(page);
  job.workdaySession = session;
  if (session !== 'signed-in') {
    return {
      status: 'manual-apply',
      submitted: false,
      keepOpen: !dryRun,
      session,
      reason: `Workday (${tenant}): no signed-in candidate session — sign in once in the jobman Chrome and later runs reuse it (jobman never creates accounts or enters passwords)`,
    };
  }
  if (!dryRun) {
    await page.evaluate(() => document.querySelector('[data-automation-id="adventureButton"]')?.click()).catch(() => {});
    await sleep(2500);
  }
  return {
    status: 'manual-apply',
    submitted: false,
    keepOpen: !dryRun,
    session,
    reason: `Workday (${tenant}): signed-in session reused — tab is open on the application; Workday's multi-page form (address, source, disclosures) needs your answers`,
  };
}

async function applyOnAts(page, job, { profile, dryRun = false } = {}) {
  if (job.ats === 'workday') return workdayHandoff(page, job, { dryRun });
  const adapter = ADAPTERS[job.ats];
  if (!adapter) return { status: 'manual-apply', submitted: false, reason: `no adapter for ${job.ats || 'this career site'}` };

  const url = adapter.formUrl(job);
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45_000 });
  } catch (err) {
    if (!/timeout/i.test(err.message)) return { status: 'failed', submitted: false, reason: `form did not load: ${err.message}` };
  }
  await sleep(1500);
  if (adapter.open) await adapter.open(page);

  const pageState = await page.evaluate(() => ({
    text: (document.body?.innerText || '').slice(0, 3000),
    password: !!document.querySelector('input[type="password"]'),
    title: document.title,
  }));
  if (CLOSED_RE.test(`${pageState.title} ${pageState.text.slice(0, 600)}`) && !/submit/i.test(pageState.text)) {
    return { status: 'closed', reason: 'employer page says the posting is closed' };
  }
  if (pageState.password) return { status: 'manual-apply', submitted: false, reason: 'login required on the employer site' };
  const challenge = await challengeVisible(page);
  if (challenge) return { status: 'manual-apply', submitted: false, reason: `${challenge} on the form — never solved automatically` };

  // ---- fill, one page at a time (SmartRecruiters: Personal info → Next → questions/consent → Submit) ----
  const summary = { questions: 0, filled: 0, missing: [], steps: 0 };
  const sources = new Set();
  for (let step = 0; step < 6; step++) {
    summary.steps = step + 1;
    const root = await page.evaluate((r) => r.split(',').map((s) => s.trim()).find((s) => (window.__jmQ || document.querySelector.bind(document))(s)) || 'body', adapter.root);
    const questions = await collectQuestions(page, root);
    if (!questions.length && step === 0) return { status: 'failed', submitted: false, reason: 'no application form found on the page' };
    for (const q of questions) {
      if (q.kind === 'combobox') q.options = await comboboxOptions(page, `[data-jm-q="${q.qid}"]`);
    }
    const plan = planForm(questions, profile, job);
    summary.questions += questions.length;
    summary.filled += plan.fills.length;
    plan.fills.forEach((f) => sources.add(f.source));
    if (plan.missing.length) {
      summary.missing = plan.missing;
      if (!dryRun) {
        // Pre-fill what the profile can answer so the hand-off is only the missing bits.
        for (const f of plan.fills) await fillQuestion(page, f.q, f.value).catch(() => false);
      }
      return { status: 'manual-apply', submitted: false, keepOpen: !dryRun, plan: summary, reason: `needs your answer: ${plan.missing.join('; ')}` };
    }

    const notApplied = [];
    for (const f of plan.fills) {
      const ok = await fillQuestion(page, f.q, f.value).catch((err) => {
        logger.debug(`[ats] fill "${f.q.label}" failed: ${err.message}`);
        return false;
      });
      if (!ok && f.q.required) notApplied.push(f.q.label);
    }
    await sleep(800);
    const stillEmpty = [...new Set([...notApplied, ...(await unfilledRequired(page, questions))])];
    if (stillEmpty.length) {
      return { status: 'manual-apply', submitted: false, keepOpen: !dryRun, plan: summary, reason: `could not fill required: ${stillEmpty.join('; ').slice(0, 300)}` };
    }

    // Last page has the submit button; earlier pages have "Next".
    if (await findButton(page, adapter, 'submit')) break;
    if (!adapter.nextText || !(await findButton(page, adapter, 'next'))) break;
    if (dryRun && step > 0) break;
    const before = questions.map((q) => q.label).join('|');
    await clickButton(page, adapter, 'next');
    // Wait for the next page's questions to render (SPA step change, no navigation).
    for (let t = 0; t < 12; t++) {
      await sleep(1000);
      const now = await collectQuestions(page, root).catch(() => []);
      if (now.length && now.map((q) => q.label).join('|') !== before) break;
    }
    const errs = await visibleErrors(page);
    if (errs.length && (await findButton(page, adapter, 'next'))) {
      return { status: 'manual-apply', submitted: false, keepOpen: !dryRun, plan: summary, reason: `form would not advance: ${errs[0].slice(0, 160)}` };
    }
  }

  if (dryRun) return { status: 'would-apply', plan: summary, reason: `would submit ${summary.filled} answers over ${summary.steps} page(s) (${[...sources].join(', ')})` };

  // ---- submit (once) ----
  const clicked = await clickButton(page, adapter, 'submit');
  if (!clicked) return { status: 'failed', submitted: false, reason: 'submit button not found or disabled' };

  const signal = await waitForSuccess(page, { text: adapter.success.text, timeoutMs: 20_000 });
  const urlProof = adapter.success.url && adapter.success.url.test(page.url()) ? `url ${page.url()}` : null;
  if (signal || urlProof) {
    const evidence = await capture(page, { portal: job.ats, jobKey: job.url, signal: signal || urlProof });
    return { status: 'applied', submitted: true, evidence };
  }
  const after = await challengeVisible(page);
  if (after) return { status: 'manual-apply', submitted: false, keepOpen: true, reason: `${after} appeared on submit — finish it in the open tab (form is filled)` };
  const errors = await visibleErrors(page);
  const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 4000)).catch(() => '');
  if ((adapter.rejected && adapter.rejected.test(bodyText)) || errors.length) {
    return { status: 'manual-apply', submitted: false, keepOpen: true, reason: `employer form rejected the submission: ${(errors[0] || bodyText.match(adapter.rejected)?.[0] || '').slice(0, 160)}` };
  }
  return { status: 'unconfirmed', submitted: true, keepOpen: true, reason: 'submit clicked but no confirmation seen — not resubmitted' };
}

module.exports = { applyOnAts, ADAPTERS, CLOSED_RE, workdaySession };
