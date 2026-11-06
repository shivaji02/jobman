/**
 * Naukri bot — flow proven manually (2 applications submitted 2026-07-23).
 *
 * Search results pages, client-side experience filtering (the site's slider
 * filter is threshold-based, not a range), job cards open in a new tab.
 * Screening drawer questions are answered from profile defaults (relocate,
 * experience, notice, CTC) — never skipped when an answer is known.
 * Job URLs are stable and used directly as the dedup key.
 */
const { humanDelay, blockHeavyAssets, checkForCaptcha, SkipPortalError, createTabTracker, settleAttemptPages, closePageQuietly } = require('../core/browser');
const { withRetry } = require('../core/retry');
const { scoreJob, shouldApply, parseExperienceRange } = require('../core/filter');
const logger = require('../core/logger');
const { classifyLocation, SEARCH_CITIES } = require('../core/location');
const { waitForSuccess, capture, evidenceNote } = require('../core/evidence');
const { emptyResults, admit } = require('../core/disposition');
const { planAnswers } = require('../core/screening');

const QUERIES = ['react native developer', 'react native engineer', 'mobile developer', 'frontend engineer react', 'full stack developer node react'];
const MAX_APPS_PER_RUN = Number(process.env.JOBMAN_MAX_APPS) || 30;
const MAX_SCREENING_ROUNDS = 10;

const { RESUME_RN, RESUME_FS, selectResume: pickResume } = require('../core/resume');

/** Pick resume path from job title keywords. Default: Full Stack. */
function selectResume(jobTitle = '', jobText = '') {
  return pickResume(jobTitle, jobText);
}

/** Pull company/ATS URL from an ExternalAtsError or error message. */
function extractCompanyUrl(error) {
  if (!error) return '';
  if (error.companyUrl) return String(error.companyUrl);
  const msg = String(error.message || error);
  const m = msg.match(/https?:\/\/[^\s)\]|'"]+/i);
  if (m && !/naukri\.com/i.test(m[0])) return m[0].replace(/[.,;]+$/, '');
  return '';
}

/**
 * Log + print manual-apply instructions for external ATS redirects.
 * Returns the report entry (does not write CSV — caller does).
 */
function handleExternalATS(job, error) {
  const resume = selectResume(job.title);
  const url = extractCompanyUrl(error) || job.url || '';
  const entry = {
    title: job.title,
    company: job.company,
    url: job.url,
    companyUrl: url,
    resume,
    reason: `manual-apply — external ATS | Resume: ${resume}`,
  };
  const line = `⚠️  Manual Apply: ${job.title} @ ${job.company} | URL: ${url} | Resume: ${resume}`;
  console.log(line);
  logger.info(`[naukri] [manual-apply] ${job.title} @ ${job.company} | URL: ${url} | Resume: ${resume}`);
  return entry;
}

/**
 * Pick reported experience years from job text.
 * Junior / 0-2 / fresher-friendly → 2.7; mid-level / 2-4 / higher → 3; else 2.7.
 */
function pickExperienceYears(jobText = '') {
  const t = String(jobText).toLowerCase();
  const junior =
    /0\s*[-–to]+\s*2(\s*(yrs?|years?))?/i.test(t) ||
    /\bjunior\b/.test(t) ||
    /fresher[- ]friendly|\bfresher\b/.test(t);
  const midOrHigher =
    /2\s*[-–to]+\s*4(\s*(yrs?|years?))?/i.test(t) ||
    /\bmid[- ]level\b/.test(t) ||
    /3\s*[-–to]+\s*[4-9](\s*(yrs?|years?))?/i.test(t) ||
    /4\s*\+?\s*(yrs?|years?)/i.test(t) ||
    /\b(senior|lead|staff|principal)\b/.test(t);
  if (junior) return '2.7';
  if (midOrHigher) return '3';
  return '2.7';
}

/** Build canonical screening answers for a job + profile. */
function buildScreeningAnswers(job = {}, profile = {}) {
  // Audit 2026-11-05: experience used to be bumped to "3" for mid/senior postings
  // (pickExperienceYears), "current CTC" got the *expected* CTC (or a hard-coded
  // 15-20 LPA), and "current location" got Hyderabad. All answers now come
  // straight from candidate.json; anything missing is left for the user.
  const years = Number(profile.experience_years);
  const experience = Number.isFinite(years) ? String(years) : '';
  return {
    relocate: profile.willing_to_relocate === false ? 'No' : 'Yes',
    experience,
    currentCtc: profile.current_ctc || '',
    expectedCtc: profile.expected_ctc || '',
    currentLocation: profile.current_location || '',
    yesToWillingness: profile.screening_defaults?.answer_yes_to_willingness === true,
    notice: 'Immediate',
    noticeFallback: '15 days',
    ctc: profile.expected_ctc || '',
    startup: 'Yes',
    availability: 'Immediate',
    employmentStatus: 'Available for immediate joining',
    location: 'Hyderabad',
  };
}

function formatScreeningLog(answers, filled) {
  const other = filled
    .filter((f) => !['relocate', 'experience', 'notice', 'ctc'].includes(f.key))
    .map((f) => `${f.question}: ${f.answer}`);
  const byKey = Object.fromEntries(filled.map((f) => [f.key, f.answer]));
  return [
    `- Relocate: ${byKey.relocate || answers.relocate}`,
    `- Experience: ${byKey.experience || answers.experience}`,
    `- Notice: ${byKey.notice || answers.notice}`,
    `- Other: ${other.length ? other.join('; ') : '(none)'}`,
  ].join('\n');
}

/**
 * Naukri's `experience=N` returns only postings whose range contains N years.
 * Pushing this into discovery removed most of the 149 "experience out of range"
 * rejections per run (4-8, 5-10, 6-11 yrs …). N = candidate's whole years
 * rounded (2.7 → 3), which still covers 1-3, 2-4, 2-5, 3-5 ranges.
 */
const SEARCH_EXPERIENCE_YEARS = Number(process.env.JOBMAN_NAUKRI_EXPERIENCE) || 3;

function searchUrl(query, city) {
  const slug = query.trim().toLowerCase().replace(/\s+/g, '-');
  // jobAge=3 → posted in the last 3 days; sort=r → most recent first
  const recent = `jobAge=3&sort=r&experience=${SEARCH_EXPERIENCE_YEARS}`;
  if (!city) return `https://www.naukri.com/${slug}-jobs?k=${encodeURIComponent(query)}&${recent}`;
  return `https://www.naukri.com/${slug}-jobs-in-${city}?k=${encodeURIComponent(query)}&l=${encodeURIComponent(city)}&${recent}`;
}

/**
 * Classify Naukri job-page apply controls from a snapshot (no browser).
 * Returns: already-applied | on-site | external | login | none
 */
function classifyNaukriApplyState({
  applyButtonText = '',
  applyButtonDisabled = false,
  buttons = [],
  companySitePresent = false,
  loginToApply = false,
  bodyText = '',
} = {}) {
  const applyLabel = String(applyButtonText || '').replace(/\s+/g, ' ').trim();
  const labels = (buttons || []).map((b) => String(b || '').replace(/\s+/g, ' ').trim());
  const body = String(bodyText || '').replace(/\s+/g, ' ');

  if (/^applied$/i.test(applyLabel) || (/applied/i.test(applyLabel) && applyButtonDisabled)) {
    return 'already-applied';
  }
  if (labels.some((t) => /^(applied|already applied)$/i.test(t))) return 'already-applied';
  if (/you have already applied|already applied to this (job|position)/i.test(body)) {
    return 'already-applied';
  }

  if (/^apply$/i.test(applyLabel) && !applyButtonDisabled) return 'on-site';
  if (labels.some((t) => /^apply$/i.test(t))) return 'on-site';
  if (companySitePresent || labels.some((t) => /apply on company site/i.test(t))) return 'external';
  if (loginToApply || labels.some((t) => /login to apply|register to apply/i.test(t))) return 'login';
  return 'none';
}

function isAlreadyAppliedPage(snapshot) {
  return classifyNaukriApplyState(snapshot) === 'already-applied';
}

/**
 * Failed / manual-apply tabs stay open only for jobs that still need action.
 * Already-applied (CSV log or page state) always closes.
 */
function shouldKeepNaukriTab(outcomeStatus, { alreadyAppliedInLog = false } = {}) {
  if (alreadyAppliedInLog) return false;
  if (outcomeStatus === 'already-applied' || outcomeStatus === 'applied' || outcomeStatus === 'skipped') {
    return false;
  }
  return outcomeStatus === 'manual-apply' || outcomeStatus === 'failed';
}

async function extractCards(page) {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.cust-job-tuple, [class*="jobTuple"]'));
    return cards.map((card) => {
      const titleEl = card.querySelector('.title, a.title');
      const companyEl = card.querySelector('.comp-name, [class*="company"]');
      const expEl = card.querySelector('.exp, [class*="experience"]');
      const locEl = card.querySelector('.locWraper, .loc, [class*="location"], [class*="locWraper"]');
      return {
        location: (locEl?.textContent || '').trim(),
        title: (titleEl?.textContent || '').trim(),
        url: titleEl?.href || '',
        company: (companyEl?.textContent || '').trim(),
        experienceText: (expEl?.textContent || '').trim(),
        text: card.textContent.replace(/\s+/g, ' ').slice(0, 1200),
      };
    }).filter((c) => c.url);
  });
}

/** Job only offers "Apply on company site" (external ATS) — manual apply, don't retry. */
class ExternalAtsError extends Error {
  constructor(companyUrl = '') {
    const url = companyUrl || '';
    super(url ? `external ATS (apply on company site): ${url}` : 'external ATS (apply on company site)');
    this.name = 'ExternalAtsError';
    this.companyUrl = url;
  }
}

/**
 * Resolve the company/ATS URL for an external apply button.
 * Prefers href/data attrs; falls back to click + popup/redirect.
 * Never closes tabs — popup/redirect pages stay open for manual apply.
 * Returns { url, page? } where page is a newly opened ATS tab when applicable.
 */
async function resolveExternalCompanyUrl(page, browser) {
  const href = await page.evaluate(() => {
    const el =
      document.querySelector('#company-site-button') ||
      Array.from(document.querySelectorAll('button, a')).find((b) =>
        /apply on company site/i.test((b.textContent || '').trim())
      );
    if (!el) return '';
    return (
      el.href ||
      el.getAttribute('href') ||
      el.getAttribute('data-url') ||
      el.getAttribute('data-href') ||
      el.getAttribute('data-redirect') ||
      ''
    );
  });
  if (href && /^https?:\/\//i.test(href) && !/naukri\.com/i.test(href)) {
    return { url: href, page: null };
  }

  const popupPromise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      browser.off('targetcreated', onTarget);
      resolve({ url: '', page: null });
    }, 8000);
    async function onTarget(target) {
      if (target.type() !== 'page') return;
      if (target.opener() !== page.target()) return; // another portal's tab (parallel run)
      clearTimeout(timer);
      browser.off('targetcreated', onTarget);
      try {
        const p = await target.page();
        if (!p) return resolve({ url: '', page: null });
        await p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
        const url = p.url();
        // Leave popup open for the user to complete manual apply
        resolve({ url: url || '', page: p });
      } catch {
        resolve({ url: '', page: null });
      }
    }
    browser.on('targetcreated', onTarget);
  });

  await page.evaluate(() => {
    const el =
      document.querySelector('#company-site-button') ||
      Array.from(document.querySelectorAll('button, a')).find((b) =>
        /apply on company site/i.test((b.textContent || '').trim())
      );
    if (el) el.click();
  });

  const popup = await popupPromise;
  if (popup.url && !/naukri\.com/i.test(popup.url)) return popup;

  await new Promise((r) => setTimeout(r, 2000));
  const current = page.url();
  if (current && !/naukri\.com/i.test(current)) return { url: current, page: null };

  return { url: href || '', page: null };
}

/** Navigate job tab to external ATS URL when we only have an href (no popup). */
async function openExternalOnPage(page, url) {
  if (!url) return page.url();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (err) {
    logger.warn(`[naukri] could not open external URL ${url}: ${err.message}`);
  }
  return page.url() || url;
}

/**
 * Answer one visible Naukri screening question (chatbot drawer or form).
 * Returns { status, key?, question?, answer? }.
 */
function answerOneScreeningRound(page, answers) {
  return page.evaluate((answers) => {
    const root =
      document.querySelector('[class*="chatbot"], [class*="Chatbot"], [class*="screening"], [class*="drawer"], [class*="modal"], [role="dialog"]') ||
      document.body;

    const visible = (el) => {
      if (!el) return false;
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const clickable = Array.from(root.querySelectorAll('button, a, span, div, li, label'))
      .filter(visible)
      .filter((el) => {
        const t = (el.textContent || '').trim();
        return t.length > 0 && t.length <= 80 && el.children.length <= 2;
      });

    // Prefer the latest bot/question bubble text.
    const questionEls = Array.from(
      root.querySelectorAll('[class*="question"], [class*="bot"], [class*="msg"], [class*="message"], p, h2, h3, h4, label')
    ).filter(visible);
    let question = '';
    for (let i = questionEls.length - 1; i >= 0; i--) {
      const t = (questionEls[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length >= 8 && t.length <= 220 && /\?|experience|ctc|notice|relocat|salary|available|startup|location|willing/i.test(t)) {
        question = t;
        break;
      }
    }
    if (!question) {
      const bodySlice = (root.innerText || '').replace(/\s+/g, ' ').slice(0, 800);
      const m = bodySlice.match(/[^?.!]{8,160}\?/);
      question = m ? m[0].trim() : '';
    }

    const q = question.toLowerCase();
    if (!q) {
      // No screening UI — maybe already applied.
      const skipBtn = clickable.find((b) => /skip this question/i.test(b.textContent));
      if (!skipBtn) return { status: 'idle' };
      return { status: 'idle' };
    }

    function pickOption(preferred, fallbacks = []) {
      const wants = [preferred, ...fallbacks].map((s) => String(s).toLowerCase());
      for (const want of wants) {
        const exact = clickable.find((el) => el.textContent.trim().toLowerCase() === want);
        if (exact) {
          exact.click();
          return exact.textContent.trim();
        }
      }
      for (const want of wants) {
        const partial = clickable.find((el) => {
          const t = el.textContent.trim().toLowerCase();
          return t.includes(want) || want.includes(t);
        });
        if (partial) {
          partial.click();
          return partial.textContent.trim();
        }
      }
      return null;
    }

    function fillText(value) {
      const inputs = Array.from(root.querySelectorAll('input:not([type="hidden"]), textarea, select')).filter(visible);
      const empty = inputs.find((el) => !el.value || el.value === '0' || el.selectedIndex === 0);
      const el = empty || inputs[inputs.length - 1];
      if (!el) return false;
      if (el.tagName === 'SELECT') {
        const opts = Array.from(el.options);
        const match =
          opts.find((o) => o.textContent.trim().toLowerCase() === String(value).toLowerCase()) ||
          opts.find((o) => o.textContent.toLowerCase().includes(String(value).toLowerCase())) ||
          opts.find((o) => String(value).toLowerCase().includes(o.textContent.trim().toLowerCase()));
        if (!match) return false;
        el.value = match.value;
      } else {
        el.focus();
        el.value = String(value);
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    function clickSend() {
      const send = clickable.find((b) => /^(send|submit|next|continue|save|done)$/i.test(b.textContent.trim()));
      if (send) {
        send.click();
        return true;
      }
      return false;
    }

    let key = 'other';
    let answer = null;
    let optionalSkip = false;

    if (/relocat|willing to (re)?locate|open to (re)?locat/i.test(q)) {
      key = 'relocate';
      answer = pickOption(answers.relocate, ['Yes', 'Y']);
      if (!answer && fillText(answers.relocate)) answer = answers.relocate;
    } else if (/total experience|years? of experience|how many years|experience in years|relevant experience/i.test(q)) {
      key = 'experience';
      // exact years first, then whole years rounded DOWN (never overstated)
      answer = answers.experience && pickOption(answers.experience, [answers.experience, String(Math.floor(Number(answers.experience)))]);
      if (!answer && fillText(answers.experience)) answer = answers.experience;
    } else if (/notice period|serving notice|how soon can you join|availability|available to join|joining/i.test(q)) {
      key = 'notice';
      answer = pickOption(answers.notice, [
        'Immediate',
        'Immediately',
        'Available now',
        'Immediate joiner',
        '0 days',
        '0',
        answers.noticeFallback,
        '15 days',
        '15',
      ]);
      if (!answer && fillText(answers.notice)) answer = answers.notice;
    } else if (/current ctc|expected ctc|current salary|expected salary|ctc|compensation|package/i.test(q)) {
      key = 'ctc';
      const isCurrent = /current|present|existing|last drawn/i.test(q);
      const value = isCurrent ? answers.currentCtc : answers.expectedCtc;
      if (value) {
        const lakhs = (String(value).match(/\d+(?:\.\d+)?/) || [])[0] || '';
        answer = pickOption(value, [value, lakhs]);
        if (!answer && fillText(value)) answer = value;
      }
      if (!answer) optionalSkip = true; // skip only if Naukri marks it optional; else unanswered → user
    } else if (/startup/i.test(q)) {
      key = 'startup';
      answer = pickOption(answers.startup, ['Yes', 'Y']);
      if (!answer && fillText(answers.startup)) answer = answers.startup;
    } else if (/current (employment )?status|employment status|currently employed|working/i.test(q)) {
      key = 'employmentStatus';
      answer = pickOption(answers.employmentStatus, [
        'Available for immediate joining',
        'Immediate joiner',
        'Not working',
        'Serving notice',
        answers.availability,
      ]);
      if (!answer && fillText(answers.employmentStatus)) answer = answers.employmentStatus;
    } else if (/current location|currently (based|located|residing)|where are you (based|located)/i.test(q)) {
      key = 'location';
      if (answers.currentLocation) {
        answer = pickOption(answers.currentLocation, [answers.currentLocation]);
        if (!answer && fillText(answers.currentLocation)) answer = answers.currentLocation;
      }
    } else if (/preferred location|location/i.test(q)) {
      key = 'location';
      answer = pickOption(answers.location, ['Hyderabad', 'Bangalore', 'Bengaluru', 'Chennai', 'Open to relocation', 'Anywhere', 'India']);
      if (!answer && fillText(answers.location)) answer = answers.location;
    } else if (answers.yesToWillingness && /willing|agree|comfortable|okay with/i.test(q)) {
      // Blanket "Yes" (bonds, shifts, travel…) only with explicit opt-in in candidate.json.
      key = 'other';
      answer = pickOption('Yes', ['Yes', 'Y']);
      if (!answer && fillText('Yes')) answer = 'Yes';
    }

    if (answer) {
      clickSend();
      return { status: 'answered', key, question, answer };
    }

    if (optionalSkip) {
      const skipBtn = clickable.find((b) => /skip this question|skip/i.test(b.textContent));
      if (skipBtn) {
        skipBtn.click();
        return { status: 'skipped_optional', key, question, answer: '(skipped — optional CTC)' };
      }
    }

    // Unknown required question — do not invent; leave for retry/failure path
    return { status: 'unanswered', question };
  }, answers);
}

async function handleScreeningDrawer(page, job, profile) {
  const answers = buildScreeningAnswers(job, profile);
  const filled = [];
  let unanswered = '';

  for (let round = 0; round < MAX_SCREENING_ROUNDS; round++) {
    const result = await answerOneScreeningRound(page, answers);
    if (result.status === 'idle') break;
    if (result.status === 'answered' || result.status === 'skipped_optional') {
      filled.push({
        key: result.key,
        question: result.question,
        answer: result.answer,
      });
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    if (result.status === 'unanswered') {
      logger.warn(`[naukri] unanswered screening: ${result.question}`);
      unanswered = result.question || 'unknown question';
      break;
    }
    break;
  }

  logger.info(`[naukri] screening answers for "${job.title}":\n${formatScreeningLog(answers, filled)}`);
  return { answers, filled, unanswered };
}

/**
 * Click Apply and read Naukri's own apply-API response.
 *
 * Audit 2026-11-05: clicks fired as soon as #apply-button rendered landed before
 * React attached its handlers and were silently ignored ("verified not applied").
 * We now wait for hydration, and use the apply-workflow API reply as proof:
 *   { jobs: [{ status: 200, message: "You have successfully applied to this job." }],
 *     quotaDetails: { dailyApplied, dailyQuota } }
 * No API call at all = nothing was submitted, so one re-click is safe.
 * Returns { api: {status, message, quota} | null, clicks }.
 */
async function clickApplyForReal(page) {
  let api = null;
  const onResponse = async (res) => {
    if (!/apply-workflow\/v\d+\/apply/.test(res.url()) || res.request().method() !== 'POST') return;
    try {
      const body = JSON.parse(await res.text());
      const j = (body.jobs || [])[0] || {};
      const typeOf = (t) => (/radio/i.test(t) ? 'radio' : /list|check|drop/i.test(t) ? 'select' : 'text');
      const questions = (j.questionnaire || []).map((q) => ({
        id: String(q.questionId),
        question: q.questionName || '',
        type: typeOf(q.questionType || ''),
        options: Object.values(q.answerOption || {}).map(String),
        required: q.isMandatory !== false,
      }));
      api = { status: j.status, message: j.message || '', quota: body.quotaDetails || null, httpStatus: res.status(), questions };
    } catch {
      api = { status: res.status(), message: '', quota: null, httpStatus: res.status() };
    }
  };
  page.on('response', onResponse);
  try {
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 15000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500)); // hydration settle
    let clicks = 0;
    for (let attempt = 1; attempt <= 2 && !api; attempt++) {
      await page.bringToFront().catch(() => {});
      try {
        await page.click('[data-jm-apply="1"]', { delay: 60 });
      } catch {
        await page.evaluate(() => document.querySelector('[data-jm-apply="1"]')?.click()).catch(() => {});
      }
      clicks++;
      const deadline = Date.now() + 8000;
      while (!api && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
      // A visible screening drawer means the click registered even before any API reply.
      const drawer = await page
        .evaluate(() => Array.from(document.querySelectorAll('[class*="chatbot"], [class*="Chatbot"]')).some((el) => el.offsetWidth || el.offsetHeight))
        .catch(() => false);
      if (api || drawer) break;
      if (attempt === 1) logger.warn('[naukri] Apply click produced no apply request — re-clicking once (nothing was submitted)');
    }
    return { api, clicks };
  } finally {
    page.off('response', onResponse);
  }
}

/**
 * Re-open a Naukri job page and read its apply state.
 * Returns { state: 'applied'|'not-applied'|'unknown', signal }.
 */
async function verifyNaukriJobState(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const signal = await waitForSuccess(page, { selector: '#already-applied, .already-applied', text: [], timeoutMs: 10000 });
    if (signal) return { state: 'applied', signal };
    const applyVisible = await page.evaluate(() => {
      const b = document.querySelector('#apply-button');
      return !!(b && (b.offsetWidth || b.offsetHeight) && /^apply$/i.test(b.textContent.trim()));
    });
    return { state: applyVisible ? 'not-applied' : 'unknown', signal: '' };
  } catch {
    return { state: 'unknown', signal: '' };
  }
}

/**
 * Open a job in a new tab, apply + screen.
 * Caller closes the page on success or already-applied; keeps it open for
 * manual-apply / failed only when the job is not already applied.
 * Returns { status: 'applied'|'already-applied'|'manual-apply'|'failed', page, ... }.
 */
async function applyToJob(browser, job, profile = {}) {
  const page = await browser.newPage();
  await blockHeavyAssets(page);
  const resume = selectResume(job.title);
  let clicked = false;
  try {
    await withRetry(
      () => page.goto(job.url, { waitUntil: 'domcontentloaded' }),
      { maxAttempts: 2 }
    );

    // Apply / Applied controls hydrate late — wait for them (replaces a fixed 2s sleep).
    await page
      .waitForSelector(
        '#apply-button, #company-site-button, [class*="apply-button"], [id*="apply"], [class*="already-applied"], [id*="already-applied"]',
        { timeout: 10000 }
      )
      .catch(() => {});
    await checkForCaptcha(page);

    const outcome = await page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const labelOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

      // Applied jobs render <span id="already-applied">Applied</span> (no button) —
      // missing this produced ~450 false "Apply button not found" failures.
      const appliedEl = document.querySelector('#already-applied, .already-applied, [class*="already-applied"]');
      if (appliedEl && visible(appliedEl)) return 'already-applied';

      const applyEl = document.querySelector('#apply-button');
      if (applyEl && visible(applyEl)) {
        const t = labelOf(applyEl);
        // After a prior apply Naukri keeps #apply-button but relabels it Applied.
        if (/^applied$/i.test(t) || applyEl.disabled) return 'already-applied';
        if (/^apply$/i.test(t)) {
          applyEl.setAttribute('data-jm-apply', '1');
          return 'clicked';
        }
      }

      const controls = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter(visible);
      if (controls.some((b) => /^(applied|already applied)$/i.test(labelOf(b)))) return 'already-applied';

      const body = (document.body.innerText || '').replace(/\s+/g, ' ');
      if (/you have already applied|already applied to this (job|position)/i.test(body)) {
        return 'already-applied';
      }

      // On-site apply: exact "Apply". Must NOT match "Apply on company site".
      const onSite = controls.find((b) => /^apply$/i.test(labelOf(b)));
      if (onSite) {
        onSite.setAttribute('data-jm-apply', '1');
        return 'clicked';
      }
      const external =
        document.querySelector('#company-site-button') ||
        controls.find((b) => /apply on company site/i.test(labelOf(b)));
      if (external) return 'external';
      if (controls.some((b) => /login to apply|register to apply/i.test(labelOf(b)))) return 'login';
      const labels = controls
        .map(labelOf)
        .filter((t) => t && t.length <= 40)
        .slice(0, 10);
      return `none: [${[...new Set(labels)].join(' | ')}]`;
    });

    if (outcome === 'external') {
      const resolved = await resolveExternalCompanyUrl(page, browser);
      let companyUrl = resolved.url || '';
      let trackPage = resolved.page || page;
      if (!resolved.page && companyUrl) {
        companyUrl = await openExternalOnPage(page, companyUrl);
        trackPage = page;
      } else if (!companyUrl) {
        companyUrl = page.url() || job.url;
      }
      return {
        status: 'manual-apply',
        page: trackPage,
        companyUrl,
        resume,
        error: new ExternalAtsError(companyUrl),
      };
    }
    if (outcome === 'already-applied') {
      return { status: 'already-applied', page, resume, reason: 'already applied on Naukri' };
    }
    if (outcome === 'login') {
      return {
        status: 'failed',
        page,
        resume,
        reason: 'login required — session logged out on job page',
      };
    }
    let applyApi = null;
    if (outcome === 'clicked') {
      clicked = true;
      ({ api: applyApi } = await clickApplyForReal(page));
      if (applyApi?.quota) logger.info(`[naukri] apply quota: ${applyApi.quota.dailyApplied}/${applyApi.quota.dailyQuota} today`);
      if (applyApi?.status === 200 || /successfully applied/i.test(applyApi?.message || '')) {
        const quota = applyApi.quota ? ` (daily ${applyApi.quota.dailyApplied}/${applyApi.quota.dailyQuota})` : '';
        await new Promise((r) => setTimeout(r, 1500));
        const evidence = await capture(page, { portal: 'naukri', jobKey: job.url, signal: `apply API: "${applyApi.message || 'status 200'}"${quota}` });
        return { status: 'applied', page, resume, evidence, submitted: true };
      }
      if (applyApi?.questions?.length) {
        // Naukri returned the exact questionnaire — decide up front from candidate.json.
        const { missing } = planAnswers(applyApi.questions, profile);
        if (missing.length) {
          return { status: 'manual-apply', page, companyUrl: page.url(), resume, submitted: false, reason: `needs your answer: ${missing.join('; ')}` };
        }
      }
      if (/already applied/i.test(applyApi?.message || '')) {
        return { status: 'already-applied', page, resume, reason: 'already applied on Naukri (apply API)' };
      }
      if (/quota|limit/i.test(applyApi?.message || '') || (applyApi?.quota && applyApi.quota.dailyApplied >= applyApi.quota.dailyQuota)) {
        throw new SkipPortalError(`Naukri daily apply quota reached (${applyApi.message || 'quota'})`);
      }
    }
    if (outcome !== 'clicked') {
      return {
        status: 'failed',
        page,
        resume,
        reason: `Apply button not found — page buttons ${String(outcome).replace(/^none:\s*/, '')}`,
      };
    }

    await new Promise((r) => setTimeout(r, 700));

    // Clicking Apply sometimes redirects straight to an external ATS.
    const afterClickUrl = page.url();
    if (afterClickUrl && !/naukri\.com/i.test(afterClickUrl)) {
      return {
        status: 'manual-apply',
        page,
        companyUrl: afterClickUrl,
        resume,
        error: new ExternalAtsError(afterClickUrl),
      };
    }

    // Answer screening questions (relocate / experience / notice / CTC / etc.)
    const screening = await handleScreeningDrawer(page, job, profile);
    if (screening.unanswered) {
      // Apply was clicked but Naukri holds the application until the drawer is
      // completed — the user must answer; the tab stays open.
      return { status: 'manual-apply', page, companyUrl: page.url(), resume, submitted: true, reason: `needs your answer: ${screening.unanswered}` };
    }

    // Previously this returned 'applied' optimistically. Now require proof.
    let signal = await waitForSuccess(page, {
      selector: '#already-applied, .already-applied',
      text: ['you have successfully applied', 'successfully applied', 'application (?:has been )?sent'],
      timeoutMs: 8000,
    });
    if (!signal) {
      // Naukri often moves to a post-apply page — re-open the JOB page and read its state.
      const verdict = await verifyNaukriJobState(page, job.url);
      if (verdict.state === 'applied') signal = `job page re-opened: ${verdict.signal}`;
      else if (verdict.state === 'not-applied') {
        // Verified: the Apply click did not register. Safe to retry in a later run (bounded).
        return { status: 'failed', page, resume, submitted: false, reason: 'verified not applied — Apply click did not register' };
      }
    }
    if (!signal) return { status: 'unconfirmed', page, resume, submitted: true, reason: 'Apply clicked; Naukri never showed Applied' };
    const evidence = await capture(page, { portal: 'naukri', jobKey: job.url, signal });
    return { status: 'applied', page, resume, evidence, submitted: true };
  } catch (err) {
    if (err instanceof ExternalAtsError) {
      const companyUrl = err.companyUrl || page.url() || job.url;
      if (companyUrl && /naukri\.com/i.test(page.url()) && !/naukri\.com/i.test(companyUrl)) {
        await openExternalOnPage(page, companyUrl);
      }
      return { status: 'manual-apply', page, companyUrl, resume, error: err };
    }
    if (err instanceof SkipPortalError) throw err; // quota / login — stop the portal cleanly
    if (clicked) return { status: 'unconfirmed', page, resume, submitted: true, reason: `error after Apply click: ${err.message}` };
    return { status: 'failed', page, resume, reason: err.message, error: err };
  }
}

async function run({ profile = {}, dedup, dryRun, newPage, browser }) {
  const results = emptyResults();
  const seenThisRun = new Set(); // same job shows up under several city/query searches
  const tabs = createTabTracker('naukri');
  const page = await newPage();
  await blockHeavyAssets(page);
  const log = (card, status, notes) => {
    if (!dryRun) dedup.append({ site: 'Naukri', job_title: card.title, company: card.company, job_url: card.url, status, notes });
  };
  const attempted = () => results.applied.length + results.unconfirmed.length;

  try {
    // Hyderabad first, then the other southern cities; each city x each query.
    const searches = SEARCH_CITIES.flatMap((city) => QUERIES.map((query) => ({ city, query })));
    for (const { city, query } of searches) {
      if (attempted() >= MAX_APPS_PER_RUN) break;

      // networkidle2 never resolves on Naukri (continuous background XHR/analytics)
      // and leaves the page on an interim state that looks like a CAPTCHA — use
      // domcontentloaded + an explicit wait for job cards instead.
      await withRetry(
        () => page.goto(searchUrl(query, city), { waitUntil: 'domcontentloaded' }),
        { maxAttempts: 2 }
      );

      if (await page.$('input[type="password"]')) {
        throw new SkipPortalError('login required — sign in once via `npm run login`');
      }
      await page.waitForSelector('.cust-job-tuple, .srp-jobtuple-wrapper', { timeout: 15000 }).catch(() => {});
      await checkForCaptcha(page);

      const cards = await extractCards(page);
      results.discovered += cards.length;
      logger.info(`[naukri] "${query}" in ${city}: ${cards.length} cards`);

      for (const card of cards) {
        const job = { title: card.title, company: card.company, url: card.url };
        if (admit(results, { key: card.url, seen: seenThisRun, dedup, job, site: 'Naukri', dryRun }) !== 'new') continue;

        const loc = classifyLocation(card.location || '', card.company);
        if (!loc.allowed) {
          job.reason = loc.reason;
          results.skipped.push(job);
          log(card, 'skipped', loc.reason);
          continue;
        }

        const range = parseExperienceRange(card.experienceText);
        if (range && (range.min > 3.5 || range.max < 1.5)) {
          job.reason = `experience ${card.experienceText} out of range`;
          results.skipped.push(job);
          log(card, 'skipped', job.reason);
          continue;
        }

        const score = scoreJob({ title: card.title, description: card.text, experienceText: card.experienceText });
        if (!shouldApply(score)) {
          job.reason = `score ${score} below threshold`;
          results.skipped.push(job);
          log(card, 'skipped', job.reason);
          continue;
        }
        if (attempted() >= MAX_APPS_PER_RUN) {
          job.reason = 'per-run cap reached';
          results.skipped.push(job);
          continue;
        }

        if (dryRun) {
          const preview = buildScreeningAnswers(card, profile);
          const resume = selectResume(card.title);
          job.reason = `would apply (score ${score}; exp=${preview.experience}, notice=${preview.notice}, relocate=${preview.relocate}; resume=${resume})`;
          job.resume = resume;
          results.applied.push(job);
          logger.info(`[naukri] DRY RUN would apply: ${card.title} @ ${card.company} (score ${score})`);
          continue;
        }

        const attemptPages = [];
        let outcome;
        for (let attempt = 1; attempt <= 2; attempt++) {
          outcome = await applyToJob(browser, card, profile);
          if (outcome.page) attemptPages.push(outcome.page);
          // Retry only technical failures where Apply was never clicked —
          // a second click after an uncertain submit could double-apply.
          if (outcome.status !== 'failed' || outcome.submitted || attempt === 2) break;
          if (/Apply button not found|login required/i.test(outcome.reason || '')) break;
          logger.warn(`[naukri] attempt ${attempt} failed for "${card.title}": ${outcome.reason}`);
          await humanDelay(1500, 2500);
        }

        const keepOpen = ['manual-apply', 'failed', 'unconfirmed'].includes(outcome.status);
        const keepPage = keepOpen ? outcome.page : null;
        await settleAttemptPages(attemptPages, keepPage);
        const pageUrl = (() => {
          try {
            return keepPage?.url?.() || outcome.companyUrl || '';
          } catch {
            return outcome.companyUrl || '';
          }
        })();

        if (outcome.status === 'already-applied') {
          job.reason = 'already applied on Naukri';
          results.alreadyApplied.push(job);
          log(card, 'applied', 'already applied on Naukri (page shows Applied)');
          continue; // nothing was submitted — no rate-limit delay needed
        }

        if (outcome.status === 'applied') {
          job.resume = outcome.resume || selectResume(card.title);
          job.evidence = outcome.evidence;
          results.applied.push(job);
          log(card, 'applied', `auto-applied (score ${score}; resume=${job.resume}) | ${evidenceNote(outcome.evidence)}`);
          console.log(`✅ Applied (confirmed): ${card.title} @ ${card.company}`);
        } else if (outcome.status === 'unconfirmed') {
          job.reason = outcome.reason;
          results.unconfirmed.push(job);
          tabs.trackFailed(job, pageUrl || job.url);
          log(card, 'unconfirmed', outcome.reason);
          logger.warn(`[naukri] UNCONFIRMED (will not resubmit): ${card.title} — ${outcome.reason}`);
        } else if (outcome.status === 'manual-apply') {
          const entry = outcome.reason
            ? { ...job, resume: outcome.resume, companyUrl: outcome.companyUrl || pageUrl, reason: outcome.reason }
            : handleExternalATS(job, outcome.error || new ExternalAtsError(outcome.companyUrl));
          entry.companyUrl = outcome.companyUrl || entry.companyUrl || pageUrl;
          results.manualApply.push(entry);
          tabs.trackManualApply(entry, entry.companyUrl);
          logger.info(`[naukri] → needs you: ${card.title} — ${entry.reason}`);
          log(card, 'manual-apply', `URL: ${entry.companyUrl} | ${entry.reason} | Resume: ${entry.resume}`);
        } else {
          job.reason = outcome.reason || 'apply failed';
          results.failed.push(job);
          tabs.trackFailed(job, pageUrl || job.url);
          logger.warn(`[naukri] [failed] ${card.title} — ${job.reason} → Tab OPEN for inspection`);
          log(card, 'failed', job.reason);
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

module.exports = {
  run,
  searchUrl,
  verifyNaukriJobState,
  applyToJob,
  pickExperienceYears,
  buildScreeningAnswers,
  formatScreeningLog,
  selectResume,
  extractCompanyUrl,
  handleExternalATS,
  ExternalAtsError,
  classifyNaukriApplyState,
  isAlreadyAppliedPage,
  shouldKeepNaukriTab,
  RESUME_RN,
  RESUME_FS,
};
