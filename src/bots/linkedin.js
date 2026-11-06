/**
 * LinkedIn bot — Easy Apply when available; otherwise leave job tab open for manual apply.
 * Successful applies close their tab; manual-apply and failed tabs stay open.
 *
 * Rate-limits aggressively: capped at 15 apps/run with randomized 3-5s
 * delays. Dedup key is the /jobs/view/<id>/ URL.
 */
const { humanDelay, checkForCaptcha, SkipPortalError, createTabTracker, settleAttemptPages, closePageQuietly } = require('../core/browser');
const logger = require('../core/logger');
const { classifyLocation, byLocationPreference, SEARCH_CITIES } = require('../core/location');
const { scoreJob, shouldApply, parseExperienceRange } = require('../core/filter');
const { planAnswers } = require('../core/screening');
const { waitForSuccess, capture, evidenceNote } = require('../core/evidence');
const { emptyResults, admit, claimGate } = require('../core/disposition');

// Nov 2026 UI: Easy Apply renders in a native <dialog data-testid="dialog">.
const DIALOG_SELECTOR = 'dialog[open], [data-testid="dialog"], [role="dialog"]';

const MAX_APPS_PER_RUN = Number(process.env.JOBMAN_MAX_APPS) || 30;
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

// Hyderabad is first preference; Mumbai is excluded outright (see core/location).
const LOCATION_SCORES = {
  hyderabad: 50,
  secunderabad: 50,
  bangalore: 40,
  bengaluru: 40,
  chennai: 40,
  kochi: 30,
  coimbatore: 30,
  trivandrum: 30,
  thiruvananthapuram: 30,
  visakhapatnam: 30,
};

function searchUrl(keywords, city = 'Hyderabad') {
  // f_AL=true = Easy Apply only; f_E=2,3 = Entry/Associate (≈1–5 yrs)
  // f_TPR=r604800 = past week; sortBy=DD = most recent first
  const params = new URLSearchParams({
    keywords,
    f_AL: 'true',
    f_E: '2,3',
    f_TPR: 'r604800',
    sortBy: 'DD',
    location: `${city}, India`,
  });
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

/**
 * The results list is lazy-rendered — only some cards exist in the DOM until the
 * pane is scrolled. Scroll the list container until the card count stops
 * growing (or a max of 15 passes).
 *
 * Nov 2026: /jobs/search/ redirects to /jobs/search-results/ with hashed class
 * names; cards are `[componentkey="job-card-component-ref-<jobId>"]` inside a
 * `[data-testid="lazy-column"]`. The legacy selectors are kept as a fallback.
 */
const CARD_SELECTOR = '[componentkey^="job-card-component-ref-"], [data-occludable-job-id], .jobs-search-results__list-item';

async function scrollResultsList(page) {
  let prevCount = 0;
  for (let pass = 0; pass < 15; pass++) {
    const count = await page.evaluate((sel) => {
      const cards = document.querySelectorAll(sel);
      const last = cards[cards.length - 1];
      let pane = document.querySelector('.jobs-search-results-list, [class*="jobs-search-results-list"]');
      if (!pane && last) {
        // nearest scrollable ancestor of the card list
        for (let el = last.parentElement; el && el !== document.body; el = el.parentElement) {
          if (el.scrollHeight > el.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(el).overflowY)) {
            pane = el;
            break;
          }
        }
      }
      if (last) last.scrollIntoView({ block: 'end' });
      if (pane) pane.scrollTop = pane.scrollHeight;
      else window.scrollTo(0, document.body.scrollHeight);
      return cards.length;
    }, CARD_SELECTOR);
    await new Promise((r) => setTimeout(r, 600));
    if (count === prevCount && pass > 1) break;
    prevCount = count;
  }
  return prevCount;
}

/**
 * Pure: turn a new-UI card's text lines into { title, company, location, appliedOnPortal }.
 * Lines look like: ["Senior Software Engineer", "SS&C Technologies", "Hyderabad (Hybrid)",
 * "2 school alumni work here", "Viewed", "·", "Easy Apply"].
 */
function parseCardLines(lines = []) {
  const clean = lines
    .map((l) => String(l || '').replace(/\s+/g, ' ').trim())
    .filter((l) => l && l !== '·' && !/^selected,/i.test(l));
  const title = (clean[0] || '').replace(/\s*\(verified job\)\s*$/i, '').replace(/\s+with verification$/i, '').trim();
  let rest = clean.slice(1);
  if (rest[0] && rest[0].toLowerCase() === title.toLowerCase()) rest = rest.slice(1); // a11y duplicate
  return {
    title,
    company: rest[0] || '',
    location: rest[1] || '',
    appliedOnPortal: clean.some((l) => /^applied\b/i.test(l)),
    easyApply: clean.some((l) => /^easy apply$/i.test(l)),
  };
}

async function extractCards(page) {
  const raw = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('[componentkey^="job-card-component-ref-"]')) {
      const id = el.getAttribute('componentkey').replace('job-card-component-ref-', '');
      if (!/^\d+$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      const card = el.closest('[data-display-contents]') || el;
      out.push({ id, lines: (card.innerText || '').split('\n'), text: (card.innerText || '').replace(/\s+/g, ' ').slice(0, 1200) });
    }
    if (out.length) return { modern: true, cards: out };
    // Legacy UI (pre Nov 2026)
    const legacy = Array.from(document.querySelectorAll('[data-occludable-job-id], .jobs-search-results__list-item')).map((card) => {
      const link = card.querySelector('a[href*="/jobs/view/"]');
      const m = link?.href?.match(/\/jobs\/view\/(\d+)/);
      return {
        id: m ? m[1] : '',
        title: (card.querySelector('.artdeco-entity-lockup__title, .job-card-list__title--link')?.textContent || link?.textContent || '').trim(),
        company: (card.querySelector('.artdeco-entity-lockup__subtitle, [class*="subtitle"]')?.textContent || '').trim(),
        location: (card.querySelector('.job-card-container__metadata-wrapper, .artdeco-entity-lockup__caption')?.textContent || '').trim(),
        text: card.textContent.replace(/\s+/g, ' ').slice(0, 1200),
      };
    });
    return { modern: false, cards: legacy };
  });
  return raw.cards
    .map((c) => {
      const parsed = raw.modern ? parseCardLines(c.lines) : { title: c.title, company: c.company, location: c.location, appliedOnPortal: /\bapplied\b/i.test(c.text) };
      return { ...parsed, url: c.id ? `https://www.linkedin.com/jobs/view/${c.id}/` : '', text: c.text };
    })
    .filter((c) => c.url && c.title);
}

/** Click the results pager's "next" control if there is one. Returns true when it moved. */
async function gotoNextResultsPage(page) {
  const moved = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="pagination-controls-next-button"], button[aria-label="View next page"]');
    if (!btn || btn.disabled || !(btn.offsetWidth || btn.offsetHeight)) return false;
    btn.click();
    return true;
  });
  if (moved) await new Promise((r) => setTimeout(r, 2500));
  return moved;
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
 * Fill Easy Apply fields from the profile (core/screening.js). The page only
 * reports questions; answers are computed in Node from candidate.json and
 * written back with the native value setter (React ignores `el.value = x`).
 * Returns { ok, missing[] } — missing = required questions the profile can't
 * answer truthfully (left for the user, never guessed).
 */
async function fillScreeningFields(page, profile, resumePath = '') {
  const fields = await page.evaluate((DIALOG) => {
    const dialog = document.querySelector(DIALOG) || document;
    const vis = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const out = [];
    let n = 0;
    const tag = (el) => {
      const id = `jm-${Date.now().toString(36)}-${n++}`;
      el.setAttribute('data-jm', id);
      return id;
    };
    for (const el of dialog.querySelectorAll('input, select, textarea')) {
      if (!vis(el) || ['hidden', 'checkbox', 'radio', 'file', 'submit', 'button'].includes(el.type)) continue;
      const isSelect = el.tagName === 'SELECT';
      const placeholderSelected = isSelect && /select an option|^select$|choose/i.test(textOf(el.selectedOptions?.[0]));
      if (el.value && !placeholderSelected) continue;
      const question =
        textOf(el.labels?.[0]) || el.getAttribute('aria-label') || textOf(el.closest('fieldset')?.querySelector('legend')) || textOf(el.parentElement);
      out.push({
        id: tag(el),
        question: question.slice(0, 220),
        type: isSelect ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : el.type || 'text',
        options: isSelect ? Array.from(el.options).map(textOf).filter((t) => t && !/select an option|^select$/i.test(t)) : [],
        required: el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(question),
      });
    }
    for (const fs of dialog.querySelectorAll('fieldset')) {
      const radios = Array.from(fs.querySelectorAll('input[type="radio"]'));
      if (!radios.length || radios.some((r) => r.checked)) continue;
      const options = radios.map((r) => textOf(r.labels?.[0]) || r.value || '');
      out.push({
        id: tag(fs),
        question: (textOf(fs.querySelector('legend')) || textOf(fs).split(' ').slice(0, 25).join(' ')).slice(0, 220),
        type: 'radio',
        options,
        required: true, // LinkedIn blocks Next on an unanswered radio group
        isResume: options.some((o) => /\.pdf|\.docx?/i.test(o)),
      });
    }
    return out;
  }, DIALOG_SELECTOR);

  const resumeName = String(resumePath).split('/').pop();
  const resumeAnswers = {};
  for (const f of fields.filter((f) => f.isResume)) {
    resumeAnswers[f.id] = f.options.find((o) => resumeName && o.includes(resumeName)) || f.options[0];
  }
  const { answers, missing } = planAnswers(fields.filter((f) => !f.isResume), profile);
  Object.assign(answers, resumeAnswers);

  if (Object.keys(answers).length) {
    await page.evaluate((answers) => {
      const setNative = (el, v) => {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        for (const t of ['input', 'change', 'blur']) el.dispatchEvent(new Event(t, { bubbles: true }));
      };
      const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
      for (const [id, v] of Object.entries(answers)) {
        const el = document.querySelector(`[data-jm="${id}"]`);
        if (!el) continue;
        if (el.tagName === 'FIELDSET') {
          const r = Array.from(el.querySelectorAll('input[type="radio"]')).find((r) => (textOf(r.labels?.[0]) || r.value) === v);
          if (r) r.click();
        } else if (el.tagName === 'SELECT') {
          const o = Array.from(el.options).find((o) => textOf(o) === v || o.value === v);
          if (o) {
            el.value = o.value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        } else {
          el.focus();
          setNative(el, v);
        }
      }
    }, answers);
  }
  return { ok: missing.length === 0, missing, filled: Object.keys(answers).length };
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
  await waitForEasyApplyModalShell(page);
  if (!(await waitForModalAction(page, EASY_APPLY_WAIT_MS))) throw new Error('Easy Apply modal did not open');
}

async function waitForEasyApplyModalShell(page) {
  await page.waitForFunction(
    () => {
      // LinkedIn's newer Easy Apply UI often has no role="dialog" — detect by form chrome
      const dialog = document.querySelector('dialog[open], [data-testid="dialog"], [role="dialog"]');
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
      hasDialog: !!document.querySelector('dialog[open], [data-testid="dialog"], [role="dialog"]'),
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
  // Portals run in parallel tabs; mouse events need this tab to be the active one.
  await page.bringToFront().catch(() => {});
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
        // Coordinate click missed (tab lost focus / layout shift) — a DOM click works in any tab.
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find((b) =>
            /easy apply/i.test(`${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`) && !b.disabled
          );
          if (btn) btn.click();
        });
        try {
          await waitForEasyApplyModal(page);
        } catch {
          throw new Error('Easy Apply modal did not open');
        }
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

/** The dialog renders its header first and the form/footer later — wait for a footer action. */
async function waitForModalAction(page, timeout = 10000) {
  return page
    .waitForFunction(
      () => {
        const scope = document.querySelector('dialog[open], [data-testid="dialog"], [role="dialog"]') || document;
        return Array.from(scope.querySelectorAll('button')).some(
          (b) => /^(next|review|submit application|continue)$/i.test((b.textContent || '').trim()) && !b.disabled
        );
      },
      { timeout, polling: 300 }
    )
    .then(() => true)
    .catch(() => false);
}

async function clickModalAction(page) {
  await waitForModalAction(page);
  return page.evaluate(() => {
    // Prefer buttons near the Easy Apply footer (Next/Review/Submit), not nav chrome
    const scope = document.querySelector('dialog[open], [data-testid="dialog"], [role="dialog"]') || document;
    const candidates = Array.from(scope.querySelectorAll('button')).filter((b) =>
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

/**
 * Walk Easy Apply. Outcomes:
 *   applied      — "application sent" (or Applied state) seen; evidence captured
 *   unconfirmed  — Submit was clicked but no confirmation: NEVER retried
 *   manual-apply — no Easy Apply, or a required question the profile can't answer
 *   failed       — technical error before Submit (safe to retry)
 */
async function applyToJob(browser, job, profile) {
  const page = await browser.newPage();
  let submitted = false;
  try {
    // Cards carry no description; score the full posting before applying.
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await page.waitForSelector('[componentkey^="JobDetails_AboutTheJob_"], .jobs-description', { timeout: 12000 }).catch(() => {});
    const description = await page
      .evaluate(() => (document.querySelector('[componentkey^="JobDetails_AboutTheJob_"], .jobs-description')?.innerText || '').slice(0, 5000))
      .catch(() => '');
    if (description) {
      const range = parseExperienceRange((description.match(/\d+(?:\.\d+)?\s*(?:\+|-|–|to)\s*\d*\s*\+?\s*(?:yrs?|years?)/i) || [])[0] || '');
      const score = scoreJob({ title: job.title, description });
      if (range && range.min > 3.5) return { status: 'rejected', page, reason: `experience ${range.min}+ yrs in description` };
      if (!shouldApply(score)) return { status: 'rejected', page, reason: `score ${score} below threshold (full description)` };
    }
    await openEasyApplyModal(page, job);

    for (let step = 0; step < 12; step++) {
      await waitForModalAction(page);
      const filled = await fillScreeningFields(page, profile, job.resume);
      if (!filled.ok) {
        return { status: 'manual-apply', page, companyUrl: job.url, reason: `needs your answer: ${filled.missing.join('; ')}`, missing: filled.missing };
      }

      const advanced = await clickModalAction(page);
      if (!advanced) break;
      if (/submit application/i.test(advanced)) submitted = true;
      await new Promise((r) => setTimeout(r, 1200));
      if (submitted) break;

      // Stuck on same step with validation errors → hand to the user (tab stays open)
      const stillInvalid = await page.evaluate(() => {
        const text = document.body?.innerText || '';
        return /invalid input|please enter a valid|enter a whole number|make a selection/i.test(text) && /\d+\s*\/\s*\d+\s*pages/.test(text);
      });
      if (stillInvalid) {
        return { status: 'manual-apply', page, companyUrl: job.url, reason: 'LinkedIn rejected an answer — needs your input on this tab' };
      }
    }

    if (!submitted) return { status: 'failed', page, reason: 'never reached "Submit application"' };

    let signal = await waitForSuccess(page, { text: ['application sent', 'your application was sent'], timeoutMs: 10000 });
    if (!signal) {
      // Toast may have been missed — the job page itself flips to an "Applied" state.
      signal = await page
        .evaluate(() => {
          const el = Array.from(document.querySelectorAll('button, span, div')).find((b) =>
            /^applied\b/i.test((b.textContent || '').trim()) && (b.textContent || '').trim().length < 40
          );
          return el ? `job page shows "${el.textContent.trim().slice(0, 30)}"` : null;
        })
        .catch(() => null);
    }
    if (!signal) return { status: 'unconfirmed', page, reason: 'Submit clicked; no "application sent" confirmation' };

    const evidence = await capture(page, { portal: 'linkedin', jobKey: job.url, signal });
    await page.evaluate(() => {
      const scope = document.querySelector('dialog[open], [data-testid="dialog"], [role="dialog"]') || document;
      const dismiss = Array.from(scope.querySelectorAll('button')).find((b) =>
        /^(done|dismiss)$/i.test((b.textContent || '').trim()) || /^dismiss$/i.test(b.getAttribute('aria-label') || '')
      );
      if (dismiss) dismiss.click();
    }).catch(() => {});
    return { status: 'applied', page, evidence };
  } catch (err) {
    if (err instanceof SkipPortalNoEasyApply) {
      // Leave job detail tab open for manual / external apply
      return {
        status: 'manual-apply',
        page,
        companyUrl: job.url,
        reason: 'no Easy Apply — external ATS',
      };
    }
    if (submitted) return { status: 'unconfirmed', page, reason: `error after Submit: ${err.message}` };
    return { status: 'failed', page, reason: err.message };
  }
}

class SkipPortalNoEasyApply extends Error {
  constructor() {
    super('no Easy Apply — external ATS, skipped');
  }
}

const SITE = 'LinkedIn';
const MAX_RESULT_PAGES = 3;

async function run({ profile, dedup, dryRun, newPage, browser }) {
  const results = emptyResults();
  const seenThisRun = new Set(); // same job shows up under several city/query searches
  const tabs = createTabTracker('linkedin');
  const page = await newPage();
  const log = (card, status, notes) => {
    if (!dryRun) dedup.append({ site: SITE, job_title: card.title, company: card.company, job_url: card.url, status, notes });
  };

  try {
    const roles = [
      ...(profile.target_roles || ['react native developer']),
      'React Native immediate joiner',
      'React Native urgent hiring',
    ];
    const searches = SEARCH_CITIES.flatMap((city) => roles.map((role) => ({ city, role })));
    for (const { city, role } of searches) {
      if (results.applied.length >= MAX_APPS_PER_RUN) break;

      // LinkedIn never reaches networkidle (constant background polling) —
      // wait for the job list to actually render instead.
      await page.goto(searchUrl(role, city), { waitUntil: 'domcontentloaded' });

      if (await page.$('input[type="password"]')) {
        throw new SkipPortalError('login required — sign in once via `npm run login`');
      }
      await page.waitForSelector(CARD_SELECTOR, { timeout: 15000 }).catch(() => {});
      await checkForCaptcha(page);

      const cards = [];
      for (let p = 0; p < MAX_RESULT_PAGES; p++) {
        await scrollResultsList(page);
        cards.push(...(await extractCards(page)));
        if (!(await gotoNextResultsPage(page))) break;
      }
      results.discovered += cards.length;
      logger.info(`[linkedin] "${role}" in ${city}: ${cards.length} cards`);
      cards.sort(byLocationPreference);

      for (const card of cards) {
        if (results.applied.length >= MAX_APPS_PER_RUN) break;
        const job = { title: card.title, company: card.company, url: card.url, location: card.location, description: card.text };
        const gate = admit(results, { key: card.url, seen: seenThisRun, dedup, job, site: SITE, dryRun });
        if (gate !== 'new') continue;

        if (card.appliedOnPortal) {
          results.alreadyApplied.push({ ...job, reason: 'already applied on LinkedIn' });
          log(card, 'applied', 'already applied on LinkedIn (card shows Applied)');
          continue;
        }

        const loc = classifyLocation(card.location, card.company);
        if (!loc.allowed) {
          job.reason = loc.reason;
          results.skipped.push(job);
          log(card, 'skipped', loc.reason);
          continue;
        }
        // Shared hard rejects (senior/lead/.NET/native-only/Java-only) apply here too —
        // the LinkedIn title score alone would accept "Lead Mobile developer, .NET".
        if (scoreJob({ title: card.title, description: card.text }) < 0) {
          job.reason = 'role rejected (seniority / tech stack)';
          results.skipped.push(job);
          log(card, 'skipped', job.reason);
          continue;
        }
        // Cards rarely carry experience, but titles do ("9+ Yrs", "3-5 years").
        const range = parseExperienceRange((card.title.match(/\d+(?:\.\d+)?\s*(?:\+|-|–|to)?\s*\d*\s*\+?\s*(?:yrs?|years?)/i) || [])[0] || '');
        if (range && (range.min > 3.5 || range.max < 1.5)) {
          job.reason = `experience ${range.min}-${range.max} yrs out of range`;
          results.skipped.push(job);
          log(card, 'skipped', job.reason);
          continue;
        }
        const scoring = calculateLinkedinScore(job);
        const score = scoring.totalScore;
        const passesThreshold = shouldApplyLinkedin(scoring);
        logger.debug(formatScoreBreakdown(job, scoring));
        if (!passesThreshold) {
          job.reason = `score ${score} below threshold`;
          results.skipped.push(job);
          log(card, 'skipped', job.reason);
          continue;
        }

        // Parallel runs: atomically claim the job across portal workers (no-op otherwise).
        if (!(await claimGate(results, dedup, card.url, job))) continue;

        if (dryRun) {
          job.reason = `would apply (score ${score})`;
          results.applied.push(job);
          logger.info(`[linkedin] DRY RUN would apply: ${card.title} @ ${card.company} (score ${score})`);
          continue;
        }

        logger.info(`[linkedin] "${card.title}" @ ${card.company} | score ${score} | applying`);
        // One retry, and only when nothing was submitted (status 'failed').
        let outcome;
        const attemptPages = [];
        for (let attempt = 1; attempt <= 2; attempt++) {
          outcome = await applyToJob(browser, card, profile);
          if (outcome.page) attemptPages.push(outcome.page);
          if (outcome.status !== 'failed' || attempt === 2) break;
          logger.warn(`[linkedin] attempt ${attempt} failed before Submit for "${card.title}": ${outcome.reason} — retrying`);
          await humanDelay(1500, 2500);
        }
        if (outcome.status === 'rejected') {
          await settleAttemptPages(attemptPages, null);
          job.reason = outcome.reason;
          results.skipped.push(job);
          log(card, 'skipped', job.reason);
          continue;
        }
        const keepPage = outcome.status === 'applied' ? null : outcome.page;
        await settleAttemptPages(attemptPages, keepPage);
        const pageUrl = (() => {
          try {
            return keepPage?.url?.() || outcome.companyUrl || card.url;
          } catch {
            return outcome.companyUrl || card.url;
          }
        })();

        if (outcome.status === 'applied') {
          job.evidence = outcome.evidence;
          results.applied.push(job);
          log(card, 'applied', `Easy Apply (score ${score}) | ${evidenceNote(outcome.evidence)}`);
          console.log(`✅ Applied (confirmed): ${card.title} @ ${card.company}`);
        } else if (outcome.status === 'unconfirmed') {
          job.reason = outcome.reason;
          results.unconfirmed.push(job);
          tabs.trackFailed(job, pageUrl);
          log(card, 'unconfirmed', outcome.reason);
          logger.warn(`[linkedin] UNCONFIRMED (will not resubmit): ${card.title} — ${outcome.reason}`);
        } else if (outcome.status === 'manual-apply') {
          const entry = { ...job, companyUrl: outcome.companyUrl || pageUrl, reason: outcome.reason || 'manual-apply' };
          results.manualApply.push(entry);
          tabs.trackManualApply(entry, entry.companyUrl);
          log(card, 'manual-apply', entry.reason);
          logger.info(`[linkedin] → needs you: ${card.title} — ${entry.reason}`);
        } else {
          job.reason = outcome.reason || 'apply failed';
          results.failed.push(job);
          tabs.trackFailed(job, pageUrl);
          log(card, 'failed', job.reason);
          logger.info(`[linkedin] failed: ${card.title} — ${job.reason}`);
        }

        await humanDelay(3000, 5000);
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
  parseCardLines,
  fillScreeningFields,
  openEasyApplyModal,
  calculateTitleScore,
  calculateSeniorityScore,
  calculateKeywordScore,
  calculateLocationScore,
  calculateLinkedinScore,
  shouldApplyLinkedin,
  formatScoreBreakdown,
  LINKEDIN_THRESHOLD,
};
