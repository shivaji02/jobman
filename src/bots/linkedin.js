/**
 * LinkedIn bot — Easy Apply when available; otherwise leave job tab open for manual apply.
 * Successful applies close their tab; manual-apply and failed tabs stay open.
 *
 * Rate-limits aggressively: capped at 15 apps/run with randomized 3-5s
 * delays. Dedup key is the /jobs/view/<id>/ URL.
 */
const { humanDelay, checkForCaptcha, SkipPortalError, createTabTracker, settleAttemptPages, closePageQuietly } = require('../core/browser');
const logger = require('../core/logger');

const MAX_APPS_PER_RUN = Number(process.env.JOBMAN_MAX_APPS) || 15;
const LINKEDIN_THRESHOLD = 30;

const TARGET_TITLES = {
  'react native': 100,
  'native developer': 100,
  'mobile developer': 90,
  'mobile engineer': 90,
  'frontend engineer': 70,
  'frontend developer': 70,
  'front end developer': 70,
  frontend: 65,
  'front end': 65,
  'react developer': 70,
  'react engineer': 70,
  'full stack': 60,
  fullstack: 60,
};

const SENIORITY_MAP = {
  junior: 40,
  fresher: 40,
  '0-2 years': 40,
  entry: 40,
  mid: 50,
  '2-4 years': 50,
  'mid-level': 50,
  senior: 20,
  '5+ years': 20,
  lead: 10,
  principal: 5,
};

const POSITIVE_KEYWORDS = [
  'react',
  'react native',
  'node',
  'typescript',
  'javascript',
  'startup',
  'remote',
  'india',
  'flexible',
];

const NEGATIVE_KEYWORDS = ['senior', 'lead', '10+ years', 'principal', '8+ years', 'architect'];

const LOCATION_SCORES = {
  remote: 50,
  india: 40,
  hyderabad: 30,
  bangalore: 30,
  bengaluru: 30,
  mumbai: 30,
  delhi: 30,
  'on site': 10,
  onsite: 10,
};

function searchUrl(keywords) {
  // f_AL=true = Easy Apply only; f_E=2,3 = Entry/Associate (≈1–5 yrs)
  const params = new URLSearchParams({
    keywords,
    f_AL: 'true',
    f_E: '2,3',
    location: 'India',
  });
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

/**
 * The results list is lazy-rendered — only ~7 cards exist in the DOM until the
 * pane is scrolled. Scroll the list container until the card count stops
 * growing (or a max of 15 passes).
 */
async function scrollResultsList(page) {
  let prevCount = 0;
  for (let pass = 0; pass < 15; pass++) {
    const count = await page.evaluate(() => {
      const cards = document.querySelectorAll('[data-occludable-job-id], .jobs-search-results__list-item');
      const pane =
        document.querySelector('.jobs-search-results-list, [class*="jobs-search-results-list"]') ||
        cards[cards.length - 1]?.closest('ul')?.parentElement;
      if (pane) pane.scrollTop = pane.scrollHeight;
      else window.scrollTo(0, document.body.scrollHeight);
      return cards.length;
    });
    await new Promise((r) => setTimeout(r, 900));
    if (count === prevCount && pass > 1) break;
    prevCount = count;
  }
  return prevCount;
}

async function extractCards(page) {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('[data-occludable-job-id], .jobs-search-results__list-item'));
    return cards.map((card) => {
      const link = card.querySelector('a[href*="/jobs/view/"]');
      const titleEl = card.querySelector('.artdeco-entity-lockup__title, .job-card-list__title--link');
      const companyEl = card.querySelector('.artdeco-entity-lockup__subtitle, [class*="subtitle"]');
      const locationEl = card.querySelector('.job-card-container__metadata-wrapper, .artdeco-entity-lockup__caption');
      const m = link?.href?.match(/\/jobs\/view\/(\d+)/);
      return {
        title: (titleEl?.textContent || link?.textContent || '').trim(),
        url: m ? `https://www.linkedin.com/jobs/view/${m[1]}/` : link?.href || '',
        company: (companyEl?.textContent || '').trim(),
        location: (locationEl?.textContent || '').trim(),
        text: card.textContent.replace(/\s+/g, ' ').slice(0, 1200),
      };
    }).filter((c) => c.url);
  });
}

function normalizeText(value = '') {
  return String(value).toLowerCase().replace(/[-_/|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function calculateTitleScore(jobTitle = '') {
  const title = normalizeText(jobTitle);
  for (const [keyword, score] of Object.entries(TARGET_TITLES)) {
    if (title.includes(keyword)) return score;
  }
  return 0;
}

function calculateSeniorityScore(text = '') {
  const blob = normalizeText(text);
  for (const [keyword, score] of Object.entries(SENIORITY_MAP)) {
    if (blob.includes(keyword)) return score;
  }
  return 25;
}

function calculateKeywordScore(text = '') {
  const blob = normalizeText(text);
  let score = 0;

  for (const keyword of POSITIVE_KEYWORDS) {
    if (blob.includes(keyword)) score += 10;
  }
  for (const keyword of NEGATIVE_KEYWORDS) {
    if (blob.includes(keyword)) score -= 20;
  }

  return Math.max(0, Math.min(50, score));
}

function calculateLocationScore(location = '') {
  const blob = normalizeText(location);
  for (const [keyword, score] of Object.entries(LOCATION_SCORES)) {
    if (blob.includes(keyword)) return score;
  }
  return 0;
}

function calculateLinkedinScore(job = {}) {
  const text = [job.description, job.text].filter(Boolean).join(' ');
  const titleScore = calculateTitleScore(job.title);
  const seniorityScore = calculateSeniorityScore([job.title, text].join(' '));
  const keywordScore = calculateKeywordScore([job.title, text].join(' '));
  const locationScore = calculateLocationScore(job.location);
  let totalScore = titleScore + seniorityScore + keywordScore + locationScore;

  // LinkedIn list cards often have thin metadata. If the title does not resemble
  // a target role, avoid letting generic "remote + React mention" postings pass.
  if (titleScore === 0 && keywordScore <= 30) {
    totalScore = Math.min(totalScore, LINKEDIN_THRESHOLD - 1);
  }

  return {
    titleScore,
    seniorityScore,
    keywordScore,
    locationScore,
    totalScore,
  };
}

function shouldApplyLinkedin(scoring) {
  return scoring.totalScore >= LINKEDIN_THRESHOLD;
}

function formatScoreBreakdown(job, scoring) {
  return (
    `[linkedin] Score breakdown for "${job.title}" @ ${job.company}: ` +
    `title=${scoring.titleScore}, seniority=${scoring.seniorityScore}, ` +
    `keywords=${scoring.keywordScore}, location=${scoring.locationScore}, total=${scoring.totalScore}`
  );
}

/**
 * Fill Easy Apply screening fields from profile. Never invents salary/CTC —
 * if those are required and missing from profile, returns { ok: false, reason }.
 */
function fillScreeningFields(page, profile) {
  return page.evaluate((profile) => {
    const years = Number(profile.experience_years) || 0;
    const wholeYears = Math.floor(years);
    const months = Math.round((years - wholeYears) * 12);
    const notice = profile.notice_period_days != null ? String(profile.notice_period_days) : '';
    const portfolio =
      profile.portfolio_url ||
      profile.links?.portfolio ||
      profile.links?.github ||
      profile.links?.linkedin ||
      '';
    const currentCtc = profile.current_ctc || profile.salary_current || '';
    const expectedCtc = profile.expected_ctc || profile.salary_expected || '';

    function labelFor(el) {
      const fromLabel = el.labels?.[0]?.innerText || '';
      const aria = el.getAttribute('aria-label') || '';
      const nearby = el.closest('div')?.innerText || '';
      return `${fromLabel} ${aria} ${nearby}`.replace(/\s+/g, ' ').slice(0, 200);
    }

    function setValue(el, value) {
      if (el.tagName === 'SELECT') {
        const opts = Array.from(el.options);
        const match =
          opts.find((o) => o.value === String(value)) ||
          opts.find((o) => o.textContent.trim() === String(value)) ||
          opts.find((o) => o.textContent.includes(String(value)));
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

    const dialog = document.querySelector('[role="dialog"]') || document;

    const fields = Array.from(dialog.querySelectorAll('input, select, textarea'));
    for (const field of fields) {
      if (field.type === 'hidden' || field.type === 'checkbox' || field.type === 'radio') continue;
      if (field.value) continue;
      const label = labelFor(field);

      if (/current ctc|current (annual )?compensation|current salary/i.test(label)) {
        if (!currentCtc) continue;
        setValue(field, currentCtc);
      } else if (/expected ctc|expected (annual )?compensation|expected salary/i.test(label)) {
        if (!expectedCtc) continue;
        setValue(field, expectedCtc);
      } else if (/notice period/i.test(label)) {
        if (!notice) continue;
        setValue(field, notice);
      } else if (/portfolio|github|website|personal (site|url)|linkedin/i.test(label)) {
        if (!portfolio) continue;
        setValue(field, portfolio);
      } else if (/additional months of experience/i.test(label)) {
        setValue(field, months);
      } else if (/years of (professional )?experience|total years/i.test(label)) {
        setValue(field, wholeYears);
      } else if (/experience|years/i.test(label) && (field.type === 'text' || field.type === 'number')) {
        setValue(field, Math.round(years));
      }
    }

    // Ensure a resume radio is selected if present
    const resumeRadios = Array.from(dialog.querySelectorAll('input[type="radio"]'));
    if (resumeRadios.length && !resumeRadios.some((r) => r.checked)) {
      resumeRadios[0].click();
    }

    const unanswered = [];
    for (const field of fields) {
      if (field.type === 'hidden' || field.type === 'checkbox' || field.type === 'radio') continue;
      const required = field.required || field.getAttribute('aria-required') === 'true';
      if (!required) continue;
      if (field.value) continue;
      unanswered.push(labelFor(field).slice(0, 80) || field.type);
    }
    if (unanswered.length) {
      return { ok: false, reason: `unanswered required fields: ${unanswered.join('; ')}` };
    }
    return { ok: true };
  }, profile);
}

const PAGE_TIMEOUT_MS = 45_000;
const EASY_APPLY_WAIT_MS = 15_000;

async function findEasyApplyButton(page) {
  return page.evaluateHandle(() => {
    const candidates = Array.from(
      document.querySelectorAll('button.jobs-apply-button, button[aria-label*="Easy Apply" i], button')
    );
    return (
      candidates.find((b) => {
        const label = `${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`;
        return /easy apply/i.test(label) && !b.disabled;
      }) || null
    );
  });
}

async function waitForEasyApplyButton(page) {
  await page.waitForFunction(
    () => {
      const buttons = Array.from(
        document.querySelectorAll('button.jobs-apply-button, button[aria-label*="Easy Apply" i], button')
      );
      return buttons.some((b) => {
        const label = `${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`;
        return /easy apply/i.test(label) && !b.disabled;
      });
    },
    { timeout: EASY_APPLY_WAIT_MS }
  );
}

async function waitForEasyApplyModal(page) {
  await page.waitForFunction(
    () => {
      // LinkedIn's newer Easy Apply UI often has no role="dialog" — detect by form chrome
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog) {
        const text = (dialog.innerText || '').toLowerCase();
        if (/contact info|resume|next|submit application|review|phone|email|apply to/i.test(text)) {
          return true;
        }
      }
      const body = (document.body?.innerText || '').toLowerCase();
      const hasStepper = /\d+\s*\/\s*\d+\s*pages/.test(body);
      const hasNext = Array.from(document.querySelectorAll('button')).some((b) =>
        /^(next|review|submit application)$/i.test((b.textContent || '').trim())
      );
      const hasApplyHeader = /apply to\s+\S+/i.test(body);
      return (hasStepper || hasApplyHeader) && hasNext;
    },
    { timeout: EASY_APPLY_WAIT_MS }
  );
}



async function debugPageState(page, context) {
  const state = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
      .slice(0, 20)
      .map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 80))
      .filter(Boolean);
    return {
      title: document.title,
      url: location.href,
      buttonCount: document.querySelectorAll('button').length,
      buttons,
      hasLoginForm: !!document.querySelector('input[type="password"]'),
      hasDialog: !!document.querySelector('[role="dialog"]'),
    };
  }).catch((err) => ({ error: err.message }));
  logger.info(`[linkedin] timeout debug (${context})`, state);
}

function isTransientError(err) {
  const msg = (err && err.message) || '';
  return /timeout|timed out|net::|Navigation|Target closed|Protocol error|modal did not open|detached|Node is detached/i.test(
    msg
  );
}

async function clickEasyApply(page) {
  // Prefer coordinate click — ElementHandles go stale when LinkedIn re-renders
  const box = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => {
      const label = `${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`;
      return /easy apply/i.test(label) && !b.disabled;
    });
    if (!btn) return null;
    btn.scrollIntoView({ block: 'center', inline: 'center' });
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!box) throw new SkipPortalNoEasyApply();
  await page.mouse.click(box.x, box.y, { delay: 50 });
}

async function dismissBlockingOverlays(page) {
  // Prefer continuing an in-progress Easy Apply draft before dismissing anything
  const continued = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) =>
      /continue applying|resume application|review job post/i.test(
        `${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`
      )
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (continued) {
    await new Promise((r) => setTimeout(r, 1000));
    return true;
  }

  // Only dismiss Premium/upsell overlays — not draft-continue prompts
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const b of buttons) {
      const aria = (b.getAttribute('aria-label') || '').trim();
      if (/dismiss.*premium|dismiss job search smarter/i.test(aria)) b.click();
    }
  });
  await new Promise((r) => setTimeout(r, 300));
  return false;
}

async function openEasyApplyModal(page, job) {
  const maxAttempts = 3; // initial try + 2 retries
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
      await checkForCaptcha(page);
      await new Promise((r) => setTimeout(r, 800)); // let LinkedIn hydrate apply button

      const resumed = await dismissBlockingOverlays(page);
      if (resumed) {
        try {
          await waitForEasyApplyModal(page);
          return;
        } catch {
          // fall through to fresh Easy Apply click
        }
      }

      try {
        await waitForEasyApplyButton(page);
      } catch (waitErr) {
        const easyApplyBtn = await findEasyApplyButton(page);
        const hasEasyApply = await page.evaluate((el) => !!el, easyApplyBtn);
        if (!hasEasyApply) throw new SkipPortalNoEasyApply();
        throw waitErr;
      }

      await dismissBlockingOverlays(page);
      await clickEasyApply(page);

      try {
        await waitForEasyApplyModal(page);
      } catch {
        throw new Error('Easy Apply modal did not open');
      }
      return;
    } catch (err) {
      lastErr = err;
      if (err instanceof SkipPortalNoEasyApply) throw err;
      await debugPageState(page, `attempt ${attempt}/${maxAttempts}: ${err.message}`);
      if (attempt === maxAttempts || !isTransientError(err)) break;
      const backoff = 500 * 2 ** (attempt - 1); // 500ms, 1000ms
      logger.info(`[linkedin] Easy Apply load failed; retrying in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

async function clickModalAction(page) {
  return page.evaluate(() => {
    // Prefer buttons near the Easy Apply footer (Next/Review/Submit), not nav chrome
    const candidates = Array.from(document.querySelectorAll('button')).filter((b) =>
      /submit application|review|next|continue/i.test((b.textContent || '').trim()) && !b.disabled
    );
    // Prefer exact matches over loose ones; pick the last (usually the modal footer CTA)
    const btn =
      candidates.find((b) => /^submit application$/i.test((b.textContent || '').trim())) ||
      candidates.find((b) => /^review$/i.test((b.textContent || '').trim())) ||
      candidates.find((b) => /^next$/i.test((b.textContent || '').trim())) ||
      candidates[candidates.length - 1];
    if (!btn) return null;
    const label = (btn.textContent || '').trim();
    btn.click();
    return label;
  });
}

async function applyToJob(browser, job, profile) {
  const page = await browser.newPage();
  try {
    await openEasyApplyModal(page, job);

    for (let step = 0; step < 10; step++) {
      const filled = await fillScreeningFields(page, profile);
      if (!filled.ok) {
        return { status: 'failed', page, reason: filled.reason };
      }

      const advanced = await clickModalAction(page);
      if (!advanced) break;
      await new Promise((r) => setTimeout(r, 1400));

      // Stuck on same step with validation errors → abort (tab stays open)
      const stillInvalid = await page.evaluate(() => {
        const text = document.body?.innerText || '';
        return /invalid input/i.test(text) && /\d+\s*\/\s*\d+\s*pages/.test(text);
      });
      if (stillInvalid) {
        return {
          status: 'failed',
          page,
          reason: 'required screening question cannot be answered from profile',
        };
      }

      if (/submit application/i.test(advanced)) break;
    }

    const confirmed = await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      return /application (sent|submitted)|your application was sent|successfully submitted/i.test(text);
    });
    if (!confirmed) {
      await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const scope = dialog || document;
        const dismiss = Array.from(scope.querySelectorAll('button')).find((b) =>
          /^(done|dismiss)$/i.test((b.textContent || '').trim()) ||
          /^dismiss$/i.test(b.getAttribute('aria-label') || '')
        );
        if (dismiss) dismiss.click();
      });
      await new Promise((r) => setTimeout(r, 800));
      const alreadyApplied = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => {
          const label = `${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`.toLowerCase();
          return /\bapplied\b/.test(label);
        });
        return !!btn;
      });
      if (!alreadyApplied) {
        return { status: 'failed', page, reason: 'no application-sent confirmation' };
      }
    }

    return { status: 'applied', page };
  } catch (err) {
    if (err instanceof SkipPortalNoEasyApply) {
      // Leave job detail tab open for manual / external apply
      return {
        status: 'manual-apply',
        page,
        companyUrl: job.url,
        reason: 'no Easy Apply — complete on this tab or company site',
      };
    }
    return { status: 'failed', page, reason: err.message };
  }
}

class SkipPortalNoEasyApply extends Error {
  constructor() {
    super('no Easy Apply — external ATS, skipped');
  }
}

async function run({ profile, dedup, dryRun, newPage, browser }) {
  const results = { reviewed: 0, applied: [], manualApply: [], skipped: [], failed: [] };
  const tabs = createTabTracker('linkedin');
  const page = await newPage();

  try {
    for (const role of profile.target_roles || ['react native developer']) {
      if (results.applied.length >= MAX_APPS_PER_RUN) break;

      // LinkedIn never reaches networkidle (constant background polling) —
      // wait for the job list to actually render instead.
      await page.goto(searchUrl(role), { waitUntil: 'domcontentloaded' });

      if (await page.$('input[type="password"]')) {
        throw new SkipPortalError('login required — sign in once via `npm run login`');
      }
      await page
        .waitForSelector('.jobs-search-results__list-item, [data-occludable-job-id]', { timeout: 15000 })
        .catch(() => {});
      await checkForCaptcha(page);

      await scrollResultsList(page);
      const cards = await extractCards(page);
      results.reviewed += cards.length;
      logger.info(`[linkedin] "${role}": ${cards.length} cards after scrolling list`);

      for (const card of cards) {
        if (results.applied.length >= MAX_APPS_PER_RUN) break;
        if (dedup.has(card.url)) {
          logger.info(`[linkedin] "${card.title}" @ ${card.company} | dedup — already in log, skipping`);
          continue;
        }

        const job = {
          title: card.title,
          company: card.company,
          url: card.url,
          location: card.location,
          description: card.text,
        };
        const scoring = calculateLinkedinScore(job);
        const score = scoring.totalScore;
        const passesThreshold = shouldApplyLinkedin(scoring);
        logger.info(formatScoreBreakdown(job, scoring));
        logger.info(
          `[linkedin] "${card.title}" @ ${card.company} | score ${score} | ` +
            (passesThreshold ? (dryRun ? 'would apply' : 'applying') : 'below threshold — skip')
        );
        if (!passesThreshold) {
          job.reason = `score ${score} below threshold`;
          results.skipped.push(job);
          if (!dryRun) dedup.append({ site: 'LinkedIn', job_title: card.title, company: card.company, job_url: card.url, status: 'skipped', notes: job.reason });
          continue;
        }

        if (dryRun) {
          job.reason = `would apply (score ${score})`;
          results.applied.push(job);
          logger.info(`[linkedin] DRY RUN would apply: ${card.title} @ ${card.company} (score ${score})`);
          continue;
        }

        const outcome = await applyToJob(browser, card, profile);
        const keepOpen = outcome.status === 'manual-apply' || outcome.status === 'failed';
        const keepPage = keepOpen ? outcome.page : null;
        await settleAttemptPages(outcome.page ? [outcome.page] : [], keepPage);

        const pageUrl = (() => {
          try {
            return keepPage?.url?.() || outcome.companyUrl || card.url;
          } catch {
            return outcome.companyUrl || card.url;
          }
        })();

        if (outcome.status === 'applied') {
          results.applied.push(job);
          dedup.append({ site: 'LinkedIn', job_title: card.title, company: card.company, job_url: card.url, status: 'applied', notes: `Easy Apply (score ${score})` });
          console.log(`✅ Applied: ${card.title} @ ${card.company}`);
          logger.info(`[linkedin] applied: ${card.title} @ ${card.company} → tab closed`);
        } else if (outcome.status === 'manual-apply') {
          const entry = {
            title: card.title,
            company: card.company,
            url: card.url,
            companyUrl: outcome.companyUrl || pageUrl || card.url,
            reason: outcome.reason || 'manual-apply — no Easy Apply',
          };
          results.manualApply.push(entry);
          tabs.trackManualApply(entry, entry.companyUrl);
          console.log(`⚠️  Manual Apply: ${card.title} @ ${card.company} | URL: ${entry.companyUrl}`);
          logger.info(`[linkedin] → Tab OPEN and ready for manual apply`);
          dedup.append({
            site: 'LinkedIn',
            job_title: card.title,
            company: card.company,
            job_url: card.url,
            status: 'manual-apply',
            notes: entry.reason,
          });
        } else if (/unanswered required|cannot be answered from profile/i.test(outcome.reason || '')) {
          job.reason = outcome.reason;
          results.skipped.push(job);
          // Screening can't be completed — leave tab open for manual fill
          tabs.trackFailed({ ...job, reason: job.reason }, pageUrl);
          console.log(`\n❌ FAILED (inspect & retry):\n   Job: ${card.title} @ ${card.company}\n   Error: ${job.reason}\n   → Tab is OPEN for inspection\n`);
          dedup.append({ site: 'LinkedIn', job_title: card.title, company: card.company, job_url: card.url, status: 'skipped', notes: outcome.reason });
          logger.info(`[linkedin] skipped (screening): ${card.title} — ${outcome.reason}`);
        } else {
          job.reason = outcome.reason || 'apply failed';
          results.failed.push(job);
          tabs.trackFailed(job, pageUrl);
          console.log(`\n❌ FAILED (inspect & retry):\n   Job: ${card.title} @ ${card.company}\n   Error: ${job.reason}\n   → Tab is OPEN for inspection\n`);
          dedup.append({ site: 'LinkedIn', job_title: card.title, company: card.company, job_url: card.url, status: 'failed', notes: job.reason });
          logger.info(`[linkedin] failed: ${card.title} — ${job.reason}`);
        }

        await humanDelay(3000, 5000);
      }
    }
  } catch (err) {
    tabs.printSummary();
    throw err;
  } finally {
    await closePageQuietly(page);
  }

  tabs.printSummary();
  return results;
}

module.exports = {
  run,
  calculateTitleScore,
  calculateSeniorityScore,
  calculateKeywordScore,
  calculateLocationScore,
  calculateLinkedinScore,
  shouldApplyLinkedin,
  formatScoreBreakdown,
  LINKEDIN_THRESHOLD,
};
