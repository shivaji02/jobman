/**
 * Company career boards (known employers). Reads every board in the company
 * directory (data/companies.json: config/careers.json seeds + employers found
 * by Google discovery) through the public ATS APIs, and applies directly on
 * the employer's ATS through core/direct → src/ats adapters.
 *
 * Progressive pipeline (2026-11-17 fix). The old code read ALL boards, then
 * screened ALL postings, then applied: one slow Workday tenant held the whole
 * channel for 30+ minutes with 0 jobs processed. Now three stages run at once,
 * connected by queues:
 *
 *   board readers  (BOARD_CONCURRENCY)   each board: timeout + retry, then its
 *        │                               India candidates are queued at once
 *   enrichers      (POSTING_PREFETCH)    full description per candidate, timeout
 *        │
 *   handlers       (ATS_WORKERS)         screen → dedup → claim → apply (browser)
 *
 * A board that times out is recorded and skipped; the others keep flowing.
 * A posting whose description times out is handled with "detail unavailable"
 * (re-checked next run), never rejected. Stop requests are honoured between
 * items: no new board reads, no new postings, in-flight applications finish.
 *
 * Efficiency: boards list every opening worldwide, so postings are narrowed at
 * discovery — India location + software title (Workday and SmartRecruiters are
 * filtered server-side) — and the full description is fetched only for the
 * few that survive. Nothing outside India is ever "reviewed".
 */
const { FETCHERS, fetchPosting } = require('../core/ats');
const { createVerificationQueue, classifyVerificationError } = require('../core/verification-queue');
const directory = require('../core/companies');
const { processPosting, alreadyPlaced } = require('../core/direct');
const { scoreJob } = require('../core/filter');
const { byLocationPreference } = require('../core/location');
const logger = require('../core/logger');
const { emptyResults } = require('../core/disposition');
const { withRetry } = require('../core/retry');
const { AGGREGATOR_ATS_TOKENS } = require('../core/discovery');
const { growDirectory } = require('../core/directoryGrowth');
const { Semaphore } = require('../core/concurrency');

/** Board API reads in flight at once. */
const BOARD_CONCURRENCY = Number(process.env.JOBMAN_HTTP_CONCURRENCY) || 24;
/** Posting-detail reads in flight at once (HTTP only, never the browser). */
const POSTING_PREFETCH = Number(process.env.JOBMAN_ATS_PREFETCH) || 8;
/** Employer postings applied concurrently (JOBMAN_ATS_WORKERS, default 1 = old behaviour). */
const ATS_WORKERS = Number(process.env.JOBMAN_ATS_WORKERS) || 1;
/** A board read longer than this is abandoned for this run (retried next run). */
const BOARD_TIMEOUT_MS = Number(process.env.JOBMAN_CAREERS_BOARD_TIMEOUT_MS) || 180_000;
/** A posting-detail read longer than this is handled as "description unavailable". */
const POSTING_TIMEOUT_MS = Number(process.env.JOBMAN_CAREERS_POSTING_TIMEOUT_MS) || 90_000;
const PROGRESS_EVERY_MS = Number(process.env.JOBMAN_CAREERS_PROGRESS_MS) || 60_000;

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

/** Promise that rejects with `timedOut` after ms. The underlying promise is not cancelled. */
function withTimeout(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${Math.round(ms / 1000)}s`);
      err.timedOut = true;
      reject(err);
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Unbounded FIFO between async stages. pull() resolves {done:true} once closed and drained. */
class WorkQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }

  push(value) {
    if (this.closed) return;
    if (this.waiters.length) this.waiters.shift()({ value, done: false });
    else this.items.push(value);
  }

  pull() {
    if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.closed) return Promise.resolve({ done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close() {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()({ done: true });
  }

  get size() {
    return this.items.length;
  }
}

/**
 * Run the three-stage careers pipeline. Dependencies are injected so the stages
 * can be tested without network or browser.
 *
 *   companies        [{ name, ats, token, ... }]
 *   readBoard(c)     → job[] (throws on failure)
 *   screenBoard(c, jobs) → candidate[] to enrich (also records board stats)
 *   onBoardError(c, err) records a failed board
 *   enrich({c, job}) → posting (must not throw; falls back itself)
 *   handle(posting, {c, job}) → applies / records one posting (errors are isolated)
 *   isStopping()     → true once a stop was requested
 */
async function streamCareers({
  companies,
  readBoard,
  screenBoard,
  onBoardError = () => {},
  enrich,
  handle,
  boardConcurrency = BOARD_CONCURRENCY,
  enrichConcurrency = POSTING_PREFETCH,
  handleConcurrency = ATS_WORKERS,
  boardTimeoutMs = BOARD_TIMEOUT_MS,
  postingTimeoutMs = POSTING_TIMEOUT_MS,
  progressEveryMs = PROGRESS_EVERY_MS,
  isStopping = () => false,
  onProgress = () => {},
  onBoardDone = () => {},
}) {
  const stats = {
    boards: companies.length,
    boardsDone: 0,
    boardsTimedOut: 0,
    boardsFailed: 0,
    candidates: 0,
    enriched: 0,
    descriptionTimeouts: 0,
    handled: 0,
    handleErrors: 0,
    skippedOnStop: 0,
    stopped: false,
  };
  const candidateQueue = new WorkQueue();
  const postingQueue = new WorkQueue();
  const enrichSem = new Semaphore(Math.max(1, enrichConcurrency), { name: 'careers-enrich', min: 1 });

  // ---- stage 1: board readers (each board independent; slow ones time out) ----
  let nextBoard = 0;
  const boardReader = async () => {
    while (!isStopping()) {
      const i = nextBoard++;
      if (i >= companies.length) return;
      const c = companies[i];
      let jobs = null;
      try {
        jobs = await withTimeout(readBoard(c), boardTimeoutMs, `${c.name || c.token} board`);
      } catch (err) {
        if (err.timedOut) stats.boardsTimedOut++;
        else stats.boardsFailed++;
        onBoardError(c, err);
      }
      stats.boardsDone++;
      if (jobs) {
        // A malformed board must not stop the other boards: isolate screening errors per board.
        try {
          const cands = screenBoard(c, jobs);
          stats.candidates += cands.length;
          for (const cand of cands) candidateQueue.push(cand);
        } catch (err) {
          stats.boardsFailed++;
          onBoardError(c, err);
        }
      }
      onBoardDone(c, { jobs, boardsDone: stats.boardsDone });
      onProgress(stats);
    }
  };
  const boardStage = Promise.all(Array.from({ length: Math.max(1, Math.min(boardConcurrency, companies.length || 1)) }, boardReader))
    .finally(() => candidateQueue.close());

  // ---- stage 2: enrichers (bounded HTTP reads, run ahead of the handlers) ----
  const enrichWorker = async () => {
    for (;;) {
      if (isStopping()) return;
      const next = await candidateQueue.pull();
      if (next.done) return;
      const item = next.value; // { c, job } — pull() wraps values as { value, done }
      let posting;
      try {
        posting = await enrichSem.run(() => withTimeout(enrich(item), postingTimeoutMs, `${item.c.name || item.c.token} posting`));
      } catch (err) {
        stats.descriptionTimeouts++;
        posting = { ...item.job, text: '', description: '', detailFetchFailed: true, enrichError: err.message };
      }
      stats.enriched++;
      postingQueue.push({ posting, item });
    }
  };
  const enrichStage = Promise.all(Array.from({ length: Math.max(1, Math.min(enrichConcurrency, 64)) }, enrichWorker))
    .finally(() => postingQueue.close());

  // ---- stage 3: handlers (screen → dedup → claim → apply; errors isolated) ----
  const handleWorker = async () => {
    for (;;) {
      const next = await postingQueue.pull();
      if (next.done) return;
      if (isStopping()) {
        stats.skippedOnStop++;
        continue;
      }
      try {
        await handle(next.value.posting, next.value.item);
        stats.handled++;
      } catch (err) {
        stats.handleErrors++;
        logger.warn(`[careers] ${next.value.posting?.title || 'posting'}: ${err.message}`);
      }
    }
  };
  const handleStage = Promise.all(Array.from({ length: Math.max(1, handleConcurrency) }, handleWorker));

  // ---- progress heartbeat: a stalled run must be visible in the log ----
  const heartbeat = setInterval(() => {
    logger.info(`[careers] progress: boards ${stats.boardsDone}/${stats.boards} (timeouts ${stats.boardsTimedOut}, failed ${stats.boardsFailed}) · candidates ${stats.candidates} · enriched ${stats.enriched} · handled ${stats.handled} · queued ${candidateQueue.size + postingQueue.size}`);
    onProgress(stats);
  }, progressEveryMs);
  heartbeat.unref?.();

  try {
    await Promise.all([boardStage, enrichStage, handleStage]);
  } finally {
    clearInterval(heartbeat);
  }
  stats.stopped = isStopping();
  // Postings still queued at the end were never handled (stop requested): counted, not lost silently.
  stats.notReached = candidateQueue.size + postingQueue.size;
  return stats;
}

const SITE = 'Careers';

async function run({ dedup, dryRun, profile, newPage, approvedJobs = [], pipeline = null, portal = 'careers', isStopping = () => false }) {
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

  const seen = new Set();
  let boardsSaved = 0;

  // Board stage: count discovery, keep India + software candidates, sorted by location preference.
  const screenBoard = (c, jobs) => {
    let india = 0;
    const out = [];
    for (const job of jobs) {
      if (!job.url) continue;
      results.discovered++;
      job.company = c.name || job.company;
      if (!inDiscoveryScope(job)) {
        results.outOfScope++;
        continue;
      }
      india++;
      out.push({ c, job });
    }
    if (jobs.length) directory.markChecked(c, { openings: jobs.length, indiaOpenings: india, relevant: 0 });
    out.sort((a, b) => byLocationPreference({ location: a.job.location, text: a.job.text }, { location: b.job.location, text: b.job.text }));
    return out;
  };
  const onBoardError = (c, err) => {
    logger.debug(`[careers] ${c.name} (${c.ats}/${c.token}): ${err.message}`);
    directory.markChecked(c, { error: err.message.slice(0, 120) });
  };
  const onBoardDone = () => {
    // Persist the directory every 25 boards, not per board and not only at the end.
    if (++boardsSaved % 25 === 0) directory.save();
  };

  // Enrich stage: full description for candidates that survive the title pre-filter.
  // Already-placed jobs and clearly-out-of-role titles need no request.
  const enrich = async ({ c, job }) => {
    if (alreadyPlaced(dedup, job.url, { company: c.name || job.company, title: job.title })) return job;
    if ((!job.text || job.text.length < 200) && scoreJob({ title: job.title }) >= 0) {
      try {
        return { ...job, ...(await fetchPosting({ ...c, id: job.id, name: c.name })), company: c.name || job.company };
      } catch (err) {
        if (!err.closed) {
          logger.debug(`[careers] could not read ${job.url}: ${err.message}`);
          if (!dryRun && !process.env.NODE_TEST_CONTEXT) {
            try {
              createVerificationQueue().enqueue({
                company: c.name || job.company, title: job.title, url: job.url,
                requisitionId: job.id || '', source: 'careers',
              }, classifyVerificationError(err));
            } catch (queueError) {
              logger.warn(`[careers] verification queue unavailable: ${queueError.message}`);
            }
          }
        }
        // A failed detail fetch is not proof of a technical mismatch. The pipeline
        // will attempt enrichment or classify the job as insufficient evidence.
        return { ...job, text: '', description: '', detailFetchFailed: !err.closed };
      }
    }
    return job;
  };

  // Handle stage: the same screen → claim → apply path as before, one posting at a time per worker.
  const handle = (posting, { c }) => processPosting(posting, {
    results, seen, dedup, dryRun, profile, newPage, site: SITE,
    source: `careers board: ${c.name} (${c.ats})`, approvedJobs, pipeline, portal,
  });

  const stats = await streamCareers({
    companies,
    readBoard: (c) => withRetry(() => FETCHERS[c.ats](c), { maxAttempts: 2, backoffMs: 1500 }),
    screenBoard,
    onBoardError,
    onBoardDone,
    enrich,
    handle,
    isStopping,
    onProgress: () => {},
  });
  directory.save();
  logger.info(`[careers] ${stats.boardsDone}/${stats.boards} boards read (${stats.boardsTimedOut} timed out, ${stats.boardsFailed} failed) · ${stats.candidates} India candidates · ${stats.handled} handled${stats.skippedOnStop ? ` · ${stats.skippedOnStop} skipped on stop` : ''}`);
  return results;
}

module.exports = { run, inDiscoveryScope, streamCareers, withTimeout, WorkQueue };
