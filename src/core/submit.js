/**
 * Approved-submission adapters: portals whose apply routine works from the job URL
 * alone, so an approved job can be submitted without re-running that portal's
 * searches. Each returns the bot's own outcome shape
 *   { status: applied|unconfirmed|manual-apply|already-applied|failed|rejected|expired,
 *     evidence?, reason?, companyUrl?, page?, submitted? }
 * and does its own verification (success text / "Applied" state + screenshot).
 *
 * Careers/google use the saved ATS metadata; Foundit uses the saved direct detail
 * URL with an identity check. Instahyre and YourStory still require a portal flow
 * that cannot safely be reconstructed from the persisted posting record.
 */
function jkFrom(url) {
  try {
    return new URL(url).searchParams.get('jk') || '';
  } catch {
    return '';
  }
}

const ADAPTERS = {
  linkedin: ({ browser, profile, job }) => require('../bots/linkedin').applyToJob(browser, job, profile),
  naukri: ({ browser, profile, job }) => require('../bots/naukri').applyToJob(browser, job, profile),
  talent: ({ browser, profile, job }) => require('../bots/talent').applyToJob(browser, job, profile),
  wellfound: ({ browser, profile, job }) => require('../bots/wellfound').applyToJob(browser, job, profile),
  indeed: ({ browser, profile, job }) => require('../bots/indeed').applyToJob(browser, { ...job, jk: job.jk || jkFrom(job.url) }, profile),
  foundit: ({ browser, job }) => require('../bots/foundit').applyApprovedJob(browser, job),
  careers: (ctx) => applyOnAts(ctx),
  google: (ctx) => applyOnAts(ctx),
};

async function applyOnAts({ browser, profile, job: saved }) {
  // Approvals saved by the pipeline keep only url/title/company; the ATS type is
  // recoverable from the URL itself (2026-11-23: AiPrise Ashby jobs were handed off).
  let job = saved;
  if (!job.ats) {
    const ref = require('./ats').parseAtsUrl(job.url);
    if (ref?.ats) job = { ...ref, ...job, ats: ref.ats, jobId: job.jobId || ref.jobId };
  }
  if (!job.ats) return { status: 'manual-apply', submitted: false, reason: 'saved approval has no ATS type; reopen the posting and verify it manually' };
  const page = await browser.newPage();
  try {
    const outcome = await require('../ats').applyOnAts(page, job, { profile });
    if (outcome.status === 'closed') outcome.status = 'expired';
    if (outcome.status === 'manual-apply' || outcome.keepOpen) return { ...outcome, page };
    await page.close().catch(() => {});
    return outcome;
  } catch (err) {
    await page.close().catch(() => {});
    return { status: 'failed', submitted: false, reason: err.message };
  }
}

const INLINE_ONLY = ['foundit', 'instahyre', 'yourstory'];

module.exports = { ADAPTERS, INLINE_ONLY, jkFrom, applyOnAts };
