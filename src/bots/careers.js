/**
 * Company career boards (known employers). Reads every board in the company
 * directory (data/companies.json: config/careers.json seeds + employers found
 * by Google discovery) through the public ATS APIs, and applies directly on
 * the employer's ATS through core/direct → src/ats adapters.
 *
 * Efficiency: boards list every opening worldwide, so postings are narrowed at
 * discovery — India location + software title (Workday and SmartRecruiters are
 * filtered server-side) — and the full description is fetched only for the
 * few that survive. Nothing outside India is ever "reviewed".
 */
const { FETCHERS, fetchPosting } = require('../core/ats');
const directory = require('../core/companies');
const { processPosting } = require('../core/direct');
const { scoreJob } = require('../core/filter');
const { byLocationPreference } = require('../core/location');
const logger = require('../core/logger');
const { emptyResults } = require('../core/disposition');
const { withRetry } = require('../core/retry');
const { AGGREGATOR_ATS_TOKENS } = require('../core/discovery');
const { growDirectory } = require('../core/directoryGrowth');

/**
 * Discovery pre-filter. On 2026-11-05, 3,334 of 3,624 board postings were
 * outside India (2,593) or remote-only abroad (741). They are counted as
 * `outOfScope` instead of being reviewed one by one.
 */
const INDIA_RE = /\b(india|hyderabad|secunderabad|bengaluru|bangalore|chennai|kochi|cochin|coimbatore|trivandrum|thiruvananthapuram|mysore|mysuru|visakhapatnam|vizag|pune|mumbai|delhi|gurgaon|gurugram|noida|kolkata|ahmedabad|jaipur|chandigarh|indore|telangana|karnataka|tamil nadu|kerala)\b/i;
const SOFTWARE_TITLE_RE = /\b(engineer|developer|programmer|sde|swe|frontend|front-end|full[- ]?stack|mobile|react|node|javascript|typescript)\b/i;

function inDiscoveryScope(job) {
  return INDIA_RE.test(job.location || '') && SOFTWARE_TITLE_RE.test(job.title || '');
}

const SITE = 'Careers';

async function run({ dedup, dryRun, profile, newPage }) {
  const results = emptyResults();
  // Grow the directory a little every run through the public ATS APIs (no Google needed).
  try {
    const grown = await growDirectory(directory);
    if (grown.added.length) logger.info(`[careers] directory +${grown.added.length} boards (${grown.added.map((a) => a.name).join(', ')})`);
    results.directory = { probedCompanies: grown.probedCompanies, requests: grown.requests, added: grown.added.length };
  } catch (err) {
    logger.warn(`[careers] directory growth skipped: ${err.message}`);
  }
  const companies = directory
    .list()
    .filter((c) => FETCHERS[c.ats] && c.token && !AGGREGATOR_ATS_TOKENS.has(String(c.token).toLowerCase()) && (c.ats !== 'workday' || (c.host && c.site)));

  const boards = await Promise.all(
    companies.map(async (c) => {
      try {
        // Board APIs time out under load (Paytm/Palantir on 2026-11-05) — retry transient errors once.
        return { c, jobs: await withRetry(() => FETCHERS[c.ats](c), { maxAttempts: 2, backoffMs: 1500 }) };
      } catch (err) {
        logger.debug(`[careers] ${c.name} (${c.ats}/${c.token}): ${err.message}`);
        directory.markChecked(c, { error: err.message.slice(0, 120) });
        return { c, jobs: [] };
      }
    })
  );

  const candidates = [];
  for (const { c, jobs } of boards) {
    let india = 0;
    for (const job of jobs) {
      if (!job.url) continue;
      results.discovered++;
      job.company = c.name || job.company;
      if (!inDiscoveryScope(job)) {
        results.outOfScope++;
        continue;
      }
      india++;
      candidates.push({ c, job });
    }
    if (jobs.length) directory.markChecked(c, { openings: jobs.length, indiaOpenings: india, relevant: 0 });
  }
  directory.save();
  candidates.sort((a, b) => byLocationPreference({ location: a.job.location, text: a.job.text }, { location: b.job.location, text: b.job.text }));
  logger.info(`[careers] ${companies.length} boards, ${results.discovered} openings, ${candidates.length} in India`);

  const seen = new Set();
  for (const { c, job } of candidates) {
    let posting = job;
    // Full description from the posting itself (Greenhouse lists omit it; Workday lists never have it).
    // Titles that are a hard reject (senior, .NET, Java-only…) don't need one.
    if ((!job.text || job.text.length < 200) && scoreJob({ title: job.title }) >= 0) {
      try {
        posting = { ...job, ...(await fetchPosting({ ...c, id: job.id, name: c.name })), company: c.name || job.company };
      } catch (err) {
        if (!err.closed) logger.debug(`[careers] could not read ${job.url}: ${err.message}`);
      }
    }
    await processPosting(posting, { results, seen, dedup, dryRun, profile, newPage, site: SITE, source: `careers board: ${c.name} (${c.ats})` });
  }
  return results;
}

module.exports = { run, inDiscoveryScope };
