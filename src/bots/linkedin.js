/**
 * LinkedIn bot — Easy Apply ONLY. External-redirect jobs are skipped.
 *
 * Rate-limits aggressively: capped at 15 apps/run with randomized 3-5s
 * delays. Dedup key is the /jobs/view/<id>/ URL.
 */
const { humanDelay, checkForCaptcha, SkipPortalError } = require('../core/browser');
const { scoreJob, shouldApply } = require('../core/filter');

const MAX_APPS_PER_RUN = 15;

function searchUrl(keywords) {
  const params = new URLSearchParams({ keywords, f_E: '2,3', location: 'India' });
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
      const m = link?.href?.match(/\/jobs\/view\/(\d+)/);
      return {
        title: (titleEl?.textContent || link?.textContent || '').trim(),
        url: m ? `https://www.linkedin.com/jobs/view/${m[1]}/` : link?.href || '',
        company: (companyEl?.textContent || '').trim(),
        text: card.textContent.replace(/\s+/g, ' ').slice(0, 1200),
      };
    }).filter((c) => c.url);
  });
}

/** Answer a numeric years-of-experience question from candidate.json (2.5 -> 2 or 3 as required). */
function answerExperienceField(page, profile) {
  return page.evaluate((years) => {
    const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"]'));
    let answeredAll = true;
    for (const input of inputs) {
      const label = input.closest('div')?.textContent || '';
      if (!/experience|years/i.test(label)) continue;
      if (input.value) continue;
      input.value = String(Math.round(years));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // any other required, empty field we can't answer -> report unanswered
    const required = Array.from(document.querySelectorAll('[required], [aria-required="true"]'));
    for (const field of required) {
      const val = field.value ?? field.textContent;
      if (!val) answeredAll = false;
    }
    return answeredAll;
  }, profile.experience_years);
}

async function applyToJob(page, job, profile) {
  await page.goto(job.url, { waitUntil: 'networkidle2' });
  await checkForCaptcha(page);

  const easyApplyBtn = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('button')).find((b) => /easy apply/i.test(b.textContent))
  );
  const hasEasyApply = await page.evaluate((el) => !!el, easyApplyBtn);
  if (!hasEasyApply) throw new SkipPortalNoEasyApply();

  await page.evaluate((el) => el.click(), easyApplyBtn);
  await new Promise((r) => setTimeout(r, 1200));

  // step through the modal: resume/contact steps are prefilled; answer
  // screening questions we can, click Next/Review/Submit; abort if a
  // required field can't be answered from the profile.
  for (let step = 0; step < 6; step++) {
    const ok = await answerExperienceField(page, profile);
    if (!ok) throw new Error('required screening question cannot be answered from profile');

    const advanced = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        /submit application|review|next/i.test(b.textContent) && !b.disabled
      );
      if (!btn) return null;
      const label = btn.textContent.trim();
      btn.click();
      return label;
    });
    if (!advanced) break;
    await new Promise((r) => setTimeout(r, 1000));
    if (/submit application/i.test(advanced)) break;
  }

  const confirmed = await page.evaluate(() =>
    /application sent|applied/i.test(document.body.innerText)
  );
  if (!confirmed) throw new Error('no application-sent confirmation');
}

class SkipPortalNoEasyApply extends Error {
  constructor() {
    super('no Easy Apply — external ATS, skipped');
  }
}

async function run({ profile, dedup, dryRun, newPage }) {
  const results = { reviewed: 0, applied: [], skipped: [], failed: [] };
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
      console.log(`[linkedin] "${role}": ${cards.length} cards after scrolling list`);

      for (const card of cards) {
        if (results.applied.length >= MAX_APPS_PER_RUN) break;
        if (dedup.has(card.url)) {
          console.log(`[linkedin] "${card.title}" @ ${card.company} | dedup — already in log, skipping`);
          continue;
        }

        const score = scoreJob({ title: card.title, description: card.text });
        const job = { title: card.title, company: card.company, url: card.url };
        console.log(
          `[linkedin] "${card.title}" @ ${card.company} | score ${score} | ` +
            (shouldApply(score) ? (dryRun ? 'would apply' : 'applying') : 'below threshold — skip')
        );
        if (!shouldApply(score)) {
          job.reason = `score ${score} below threshold`;
          results.skipped.push(job);
          if (!dryRun) dedup.append({ site: 'LinkedIn', job_title: card.title, company: card.company, job_url: card.url, status: 'skipped', notes: job.reason });
          continue;
        }

        if (dryRun) {
          job.reason = `would apply (score ${score})`;
          results.applied.push(job);
          console.log(`[linkedin] DRY RUN would apply: ${card.title} @ ${card.company} (score ${score})`);
          continue;
        }

        try {
          await applyToJob(page, card, profile);
          results.applied.push(job);
          dedup.append({ site: 'LinkedIn', job_title: card.title, company: card.company, job_url: card.url, status: 'applied', notes: `Easy Apply (score ${score})` });
          console.log(`[linkedin] applied: ${card.title} @ ${card.company}`);
        } catch (err) {
          if (err instanceof SkipPortalNoEasyApply) {
            job.reason = err.message;
            results.skipped.push(job);
            dedup.append({ site: 'LinkedIn', job_title: card.title, company: card.company, job_url: card.url, status: 'skipped', notes: err.message });
          } else {
            job.reason = err.message;
            results.failed.push(job);
            dedup.append({ site: 'LinkedIn', job_title: card.title, company: card.company, job_url: card.url, status: 'failed', notes: err.message });
          }
        }

        await humanDelay(3000, 5000);
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  return results;
}

module.exports = { run };
