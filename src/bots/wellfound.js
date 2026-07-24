/**
 * Wellfound bot (formerly AngelList Talent) — startup roles, often remote.
 * Part of the ORIGINAL 3-portal spec (Naukri, Instahyre, Wellfound).
 *
 * Not yet explored live. TODO (Claude Code):
 *  1. Recon first: https://wellfound.com/jobs — search "react native developer",
 *     location India / remote. Requires login (persistent .chrome-profile).
 *  2. Wellfound is a React SPA — use waitForSelector on job cards, NOT networkidle.
 *  3. Wellfound is aggressive about bot detection (DataDome). If a challenge/
 *     CAPTCHA appears, throw SkipPortalError immediately — never retry into it.
 *  4. Application flow is usually on-site: a "quick apply" with an optional
 *     note to the founder. Fill the note from candidate.json summary (2-3
 *     sentences, no fabrication). Skip roles requiring a custom pitch beyond that.
 *  5. Dedup key: the /jobs/<id>-<slug> job URL.
 *  6. Same contract as other bots: run({ profile, dedup, reporter, dryRun, newPage }).
 */
const { SkipPortalError } = require('../core/browser');

async function run() {
  // Not implemented — runner should report this portal as skipped, not crash.
  throw new SkipPortalError('wellfound bot not implemented yet');
}

module.exports = { run };
