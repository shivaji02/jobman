/**
 * Naukri bot — flow proven manually (2 applications submitted 2026-07-23).
 *
 * Search results pages, client-side experience filtering (the site's slider
 * filter is threshold-based, not a range), job cards open in a new tab.
 * Screening drawer questions are answered from profile defaults (relocate,
 * experience, notice, CTC) — never skipped when an answer is known.
 * Job URLs are stable and used directly as the dedup key.
 */
const { humanDelay, checkForCaptcha, SkipPortalError } = require('../core/browser');
const { withRetry } = require('../core/retry');
const { scoreJob, shouldApply, parseExperienceRange } = require('../core/filter');
const logger = require('../core/logger');

const QUERIES = ['react native developer', 'react native engineer', 'mobile developer', 'frontend engineer react', 'full stack developer node react'];
const MAX_APPS_PER_RUN = 10;
const MAX_SCREENING_ROUNDS = 10;

const RESUME_RN = '/Users/neosoft/Downloads/Resumes/shivajirn02.pdf';
const RESUME_FS = '/Users/neosoft/Downloads/Resumes/ShivajiPresidio.pdf';

/** Pick resume path from job title keywords. Default: Full Stack. */
function selectResume(jobTitle = '') {
  const t = String(jobTitle).toLowerCase();
  if (/react[\s-]?native|\bnative\b|\bmobile\b/.test(t)) return RESUME_RN;
  return RESUME_FS;
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
  const blob = [job.title, job.experienceText, job.text, job.description].filter(Boolean).join(' ');
  const experience = pickExperienceYears(blob);
  const ctc = profile.expected_ctc || profile.current_ctc || '15-20 LPA';
  return {
    relocate: 'Yes',
    experience,
    notice: 'Immediate',
    noticeFallback: '15 days',
    ctc,
    startup: 'Yes',
    availability: 'Immediate',
    employmentStatus: 'Available for immediate joining',
    location: 'Open to relocation',
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
 * Prefers href/data attrs; falls back to click + popup/redirect capture.
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
  if (href && /^https?:\/\//i.test(href) && !/naukri\.com/i.test(href)) return href;

  const popupPromise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      browser.off('targetcreated', onTarget);
      resolve('');
    }, 8000);
    async function onTarget(target) {
      if (target.type() !== 'page') return;
      clearTimeout(timer);
      browser.off('targetcreated', onTarget);
      try {
        const p = await target.page();
        if (!p) return resolve('');
        await p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
        const url = p.url();
        await p.close().catch(() => {});
        resolve(url || '');
      } catch {
        resolve('');
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

  const popupUrl = await popupPromise;
  if (popupUrl && !/naukri\.com/i.test(popupUrl)) return popupUrl;

  await new Promise((r) => setTimeout(r, 2000));
  const current = page.url();
  if (current && !/naukri\.com/i.test(current)) return current;

  return href || '';
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
      answer = pickOption(answers.experience, [String(Math.round(Number(answers.experience))), '2.7', '3', '2']);
      if (!answer && fillText(answers.experience)) answer = answers.experience;
    } else if (/notice period|serving notice|how soon can you join|availability|available to join|joining/i.test(q)) {
      key = 'notice';
      answer = pickOption(answers.notice, [
        'Immediate',
        'Immediately',
        '0 days',
        '0',
        answers.noticeFallback,
        '15 days',
        '15',
      ]);
      if (!answer && fillText(answers.notice)) answer = answers.notice;
    } else if (/current ctc|expected ctc|current salary|expected salary|ctc|compensation|package/i.test(q)) {
      key = 'ctc';
      answer = pickOption(answers.ctc, ['15-20 LPA', '15 - 20 LPA', '15 to 20', '15', '20']);
      if (!answer && fillText(answers.ctc)) answer = answers.ctc;
      if (!answer) optionalSkip = true; // CTC optional — skip only this question
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
    } else if (/preferred location|current location|location/i.test(q)) {
      key = 'location';
      answer = pickOption(answers.location, ['Anywhere', 'Open to relocation', 'Remote', 'India']);
      if (!answer && fillText(answers.location)) answer = answers.location;
    } else if (/willing|agree|comfortable|okay with/i.test(q)) {
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

  for (let round = 0; round < MAX_SCREENING_ROUNDS; round++) {
    const result = await answerOneScreeningRound(page, answers);
    if (result.status === 'idle') break;
    if (result.status === 'answered' || result.status === 'skipped_optional') {
      filled.push({
        key: result.key,
        question: result.question,
        answer: result.answer,
      });
      await new Promise((r) => setTimeout(r, 900));
      continue;
    }
    if (result.status === 'unanswered') {
      logger.warn(`[naukri] unanswered screening: ${result.question}`);
      break;
    }
    break;
  }

  logger.info(`[naukri] screening answers for "${job.title}":\n${formatScreeningLog(answers, filled)}`);
  return { answers, filled };
}

/** Open a job in a new tab, apply + screen, return immediately (optimistic success). */
async function applyToJob(browser, job, profile = {}) {
  const page = await browser.newPage();
  try {
    await withRetry(
      () => page.goto(job.url, { waitUntil: 'domcontentloaded' }),
      { maxAttempts: 2 }
    );
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

    if (outcome === 'external') {
      const companyUrl = await resolveExternalCompanyUrl(page, browser);
      throw new ExternalAtsError(companyUrl);
    }
    if (outcome === 'login') throw new Error('login required — session logged out on job page');
    if (outcome !== 'clicked') throw new Error(`Apply button not found — page buttons ${outcome.slice(5)}`);

    await new Promise((r) => setTimeout(r, 1500));

    // Clicking Apply sometimes redirects straight to an external ATS.
    const afterClickUrl = page.url();
    if (afterClickUrl && !/naukri\.com/i.test(afterClickUrl)) {
      throw new ExternalAtsError(afterClickUrl);
    }

    // Answer screening questions (relocate / experience / notice / CTC / etc.)
    await handleScreeningDrawer(page, job, profile);

    // Optimistic: form filled + apply clicked — assume success (no confirmation wait).
    return { status: 'applied', resume: selectResume(job.title) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function run({ profile = {}, dedup, dryRun, newPage, browser }) {
  const results = { reviewed: 0, applied: [], skipped: [], failed: [], manualApply: [] };
  const page = await newPage();

  try {
    for (const query of QUERIES) {
      if (results.applied.length >= MAX_APPS_PER_RUN) break;

      // networkidle2 never resolves on Naukri (continuous background XHR/analytics)
      // and leaves the page on an interim state that looks like a CAPTCHA — use
      // domcontentloaded + an explicit wait for job cards instead.
      await withRetry(
        () => page.goto(searchUrl(query), { waitUntil: 'domcontentloaded' }),
        { maxAttempts: 2 }
      );

      if (await page.$('input[type="password"]')) {
        throw new SkipPortalError('login required — sign in once via `npm run login`');
      }
      await page.waitForSelector('.cust-job-tuple, .srp-jobtuple-wrapper', { timeout: 15000 }).catch(() => {});
      await checkForCaptcha(page);

      const cards = await extractCards(page);
      results.reviewed += cards.length;
      logger.info(`[naukri] "${query}": ${cards.length} cards`);

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
          const preview = buildScreeningAnswers(card, profile);
          const resume = selectResume(card.title);
          job.reason = `would apply (score ${score}; exp=${preview.experience}, notice=${preview.notice}, relocate=${preview.relocate}; resume=${resume})`;
          job.resume = resume;
          results.applied.push(job);
          logger.info(`[naukri] DRY RUN would apply: ${card.title} @ ${card.company} (score ${score})`);
          logger.info(`[naukri] DRY RUN screening:\n${formatScreeningLog(preview, [])}`);
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
            if (err instanceof ExternalAtsError) break; // manual apply — never retry
            logger.warn(`[naukri] attempt ${attempt} failed for "${card.title}": ${err.message}`);
            await humanDelay(1500, 2500);
          }
        }

        if (lastErr instanceof ExternalAtsError) {
          const entry = handleExternalATS(job, lastErr);
          results.manualApply.push(entry);
          dedup.append({
            site: 'Naukri',
            job_title: card.title,
            company: card.company,
            job_url: card.url,
            status: 'manual-apply',
            notes: `URL: ${entry.companyUrl} | Resume: ${entry.resume}`,
          });
        } else if (lastErr) {
          job.reason = lastErr.message;
          results.failed.push(job);
          dedup.append({ site: 'Naukri', job_title: card.title, company: card.company, job_url: card.url, status: 'failed', notes: lastErr.message });
        } else {
          const resume = selectResume(card.title);
          job.resume = resume;
          results.applied.push(job);
          dedup.append({
            site: 'Naukri',
            job_title: card.title,
            company: card.company,
            job_url: card.url,
            status: 'applied',
            notes: `auto-applied (score ${score}; resume=${resume})`,
          });
          console.log(`✅ Applied: ${card.title} @ ${card.company}`);
          logger.info(`[naukri] applied: ${card.title} @ ${card.company}`);
        }

        await humanDelay();
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  // End-of-run summary for the console
  console.log(
    `\n[naukri] Summary — Applied: ${results.applied.length} · ` +
      `Manual Apply: ${results.manualApply.length} · Failed: ${results.failed.length}`
  );
  if (results.manualApply.length) {
    console.log('[naukri] Manual Apply list:');
    for (const j of results.manualApply) {
      console.log(`  ⚠️  ${j.title} @ ${j.company} | URL: ${j.companyUrl} | Resume: ${j.resume}`);
    }
  }

  return results;
}

module.exports = {
  run,
  pickExperienceYears,
  buildScreeningAnswers,
  formatScreeningLog,
  selectResume,
  extractCompanyUrl,
  handleExternalATS,
  ExternalAtsError,
  RESUME_RN,
  RESUME_FS,
};
