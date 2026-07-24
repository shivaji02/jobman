/**
const logger = require('../core/logger');
 * YourStory Jobs bot — DISABLED.
 *
 * Verified live (2026-07-24): jobs.yourstory.com no longer exists (404,
 * redirects to yourstory.com/jobs/list?cid=YourStory, also 404). The only
 * live path, yourstory.com/jobs, is YourStory Media's own internal careers
 * page ("Work with Us" — roles like Associate Sales & Partnerships Manager),
 * not a startup job board for external candidates. There is no on-site job
 * search/apply flow left to automate here.
 *
 * Left as a no-op run() (rather than removed) so `jobman run yourstory`
 * still resolves and reports the reason clearly instead of erroring. It's
 * excluded from the default run-all/scheduler portal list in src/runner.js.
 */
async function run() {
  logger.info('[yourstory] disabled — jobs.yourstory.com no longer exists (see src/bots/yourstory.js)');
  return {
    reviewed: 0,
    applied: [],
    skipped: [],
    failed: [],
    note: 'Portal disabled: jobs.yourstory.com 404s; yourstory.com/jobs is YourStory Media\'s own internal careers page, not a candidate job board.',
  };
}

module.exports = { run };
