/**
 * Simulated portal bot for tests and the benchmark. Follows the same contract
 * as the real bots in src/bots: admit() every card → filter → claimGate() →
 * (dry run: record) → "apply" → dedup.append() immediately → humanDelay.
 * Nothing touches a browser or a real site.
 */
const { emptyResults, admit, claimGate } = require('../../src/core/disposition');
const { SkipPortalError } = require('../../src/core/browser');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} spec
 *   site        CSV site name
 *   pages       array of arrays of jobs { url, title, company, eligible }
 *   pageMs      time per search page (discovery)
 *   applyMs     time per application attempt
 *   gapMs       rate-limit delay after each application
 *   crashTimes  crash (generic Error) on the first N runs, after the first page
 *   ledger      shared array: every real "submission" is pushed here
 *   onApply     optional hook(job) called while the attempt is in flight
 */
function createFakeBot(spec) {
  let runs = 0;
  const { site, pages, pageMs = 10, applyMs = 20, gapMs = 5, crashTimes = 0, ledger = [], onApply } = spec;
  return {
    runs: () => runs,
    async run({ dedup, dryRun, approvedJobs }) {
      // Synthetic bots represent explicit consent in tests/benchmarks only.
      const syntheticApprovals = approvedJobs?.size === 0 || approvedJobs == null
        ? pages.flat().map((card) => card.url)
        : approvedJobs;
      runs++;
      const results = emptyResults();
      const seen = new Set();
      try {
        for (let p = 0; p < pages.length; p++) {
          await sleep(pageMs);
          if (runs <= crashTimes && p === 1) throw new Error('net::ERR_CONNECTION_RESET (simulated crash)');
          for (const card of pages[p]) {
            results.discovered++;
            const job = { title: card.title, company: card.company, url: card.url };
            if (admit(results, { key: card.url, seen, dedup, job, site, dryRun }) !== 'new') continue;
            if (!card.eligible) {
              job.reason = 'score 10 below threshold';
              results.skipped.push(job);
              if (!dryRun) dedup.append({ site, job_title: card.title, company: card.company, job_url: card.url, status: 'skipped', notes: job.reason });
              continue;
            }
            if (!(await claimGate(results, dedup, card.url, job, { dryRun, approvedJobs: syntheticApprovals }))) continue;
            if (dryRun) {
              job.reason = 'would apply';
              results.applied.push(job);
              continue;
            }
            if (onApply) await onApply(job);
            await sleep(applyMs);
            ledger.push({ site, url: card.url, company: card.company, title: card.title, at: Date.now() });
            job.evidence = { signal: 'text "Application submitted"', url: card.url, screenshot: '', at: new Date().toISOString() };
            results.applied.push(job);
            dedup.append({ site, job_title: card.title, company: card.company, job_url: card.url, status: 'applied', notes: 'evidence: text "Application submitted"' });
            await sleep(gapMs);
          }
        }
      } catch (err) {
        err.partialResults = results;
        throw err;
      }
      return results;
    },
  };
}

/** A bot that stops on a CAPTCHA (SkipPortalError) after its first page. */
function createCaptchaBot(spec) {
  const inner = createFakeBot(spec);
  return {
    async run(ctx) {
      const r = await inner.run({ ...ctx, dedup: ctx.dedup });
      const err = new SkipPortalError('CAPTCHA detected — skipped (never auto-solved)');
      err.partialResults = r;
      throw err;
    },
  };
}

const fakeBrowser = () => ({
  browser: { pages: async () => [], close: async () => {}, __fake: true },
  newPage: async () => ({ close: async () => {} }),
});

const healthySampler = { sample: async () => ({ at: Date.now(), cores: 15, totalMemMb: 24576, cpuPct: 20, load1: 2, memAvailablePct: 60, nodeRssMb: 80, chrome: { procs: 0, rssMb: 0, cpuPct: 0 } }) };

module.exports = { createFakeBot, createCaptchaBot, fakeBrowser, healthySampler, sleep };
