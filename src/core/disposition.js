/**
 * Final disposition of every listing a run touches — one per unique listing,
 * mutually exclusive, and reconciled so nothing is "reviewed but unexplained".
 *
 * Funnel per portal (all counts are listings, not tabs):
 *
 *   discovered        raw cards seen across all searches (same job counted per query)
 *   − duplicates      repeat sightings of a job already seen earlier this run
 *   − outOfScope      dropped at discovery by a cheap pre-filter (e.g. career-site
 *                     roles outside India) — never evaluated
 *   = reviewed        unique listings that received a final disposition below
 *
 *   reviewed = Σ DISPOSITIONS   (reconcile() checks this and reports any gap)
 *
 * Bots keep pushing into the familiar buckets (applied / manualApply / skipped /
 * failed / alreadyApplied / unconfirmed); classify() maps bucket + reason to one
 * canonical disposition so reports never depend on free-text reasons.
 */

const DISPOSITIONS = [
  { key: 'applied_confirmed', label: 'Applied — confirmed (evidence captured)' },
  { key: 'would_apply', label: 'Would apply (dry run)' },
  { key: 'applied_unconfirmed', label: 'Submitted, confirmation not seen (never resubmitted)' },
  { key: 'already_applied', label: 'Already applied / handled in an earlier run' },
  { key: 'manual_required', label: 'Needs you (CAPTCHA, OTP, external ATS, missing info)' },
  { key: 'failed_technical', label: 'Technical failure (retried; will retry next run)' },
  { key: 'rejected_location', label: 'Rejected — location' },
  { key: 'rejected_experience', label: 'Rejected — experience range' },
  { key: 'rejected_role', label: 'Rejected — role / tech / seniority' },
  { key: 'rejected_stale', label: 'Rejected — posting closed or too old' },
  { key: 'deferred_cap', label: 'Deferred — per-run cap reached' },
];
const KEYS = DISPOSITIONS.map((d) => d.key);

const BUCKETS = ['applied', 'unconfirmed', 'alreadyApplied', 'manualApply', 'failed', 'skipped'];

/** Map one bucket entry to its canonical disposition. */
function classify(bucket, entry = {}, { dryRun = false } = {}) {
  const r = String(entry.reason || '').toLowerCase();
  if (bucket === 'applied') return dryRun ? 'would_apply' : entry.evidence ? 'applied_confirmed' : 'applied_unconfirmed';
  if (bucket === 'unconfirmed') return 'applied_unconfirmed';
  if (bucket === 'alreadyApplied') return 'already_applied';
  if (bucket === 'manualApply') return 'manual_required';
  if (bucket === 'failed') {
    if (/not confirmed|no .*confirmation|confirmation not/.test(r)) return 'applied_unconfirmed';
    return 'failed_technical';
  }
  // skipped
  if (/already (applied|logged|submitted|manual|unconfirmed)|applied on|same role already/.test(r)) return 'already_applied';
  if (/not confirmed|no .*confirmation/.test(r)) return 'applied_unconfirmed';
  if (/unanswered|cannot be answered|missing profile|needs you|captcha|otp|login required|manual/.test(r)) return 'manual_required';
  if (/cap reached/.test(r)) return 'deferred_cap';
  if (/\bstale\b|posting (is )?closed|no longer (open|listed|accepting)|expired|posted \d+ days ago/.test(r)) return 'rejected_stale';
  if (/experience|yrs|years/.test(r)) return 'rejected_experience';
  if (/mumbai|pune|location|south india|remote|city/.test(r)) return 'rejected_location';
  return 'rejected_role';
}

/**
 * Count dispositions for one portal result and check the funnel adds up.
 * Returns { counts, reviewed, discovered, duplicates, outOfScope, accounted, unaccounted }.
 */
function reconcile(result = {}, opts = {}) {
  const counts = Object.fromEntries(KEYS.map((k) => [k, 0]));
  for (const bucket of BUCKETS) {
    for (const entry of result[bucket] || []) counts[classify(bucket, entry, opts)]++;
  }
  const accounted = Object.values(counts).reduce((a, b) => a + b, 0);
  const reviewed = result.reviewed || 0;
  const duplicates = result.duplicates || 0;
  const outOfScope = result.outOfScope || 0;
  const discovered = result.discovered != null ? result.discovered : reviewed + duplicates + outOfScope;
  return {
    counts,
    reviewed,
    discovered,
    duplicates,
    outOfScope,
    accounted,
    unaccounted: reviewed - accounted,
    discoveryGap: discovered - duplicates - outOfScope - reviewed,
  };
}

/** Sum reconcile() across portals. */
function reconcileAll(results = {}, opts = {}) {
  const total = { counts: Object.fromEntries(KEYS.map((k) => [k, 0])), reviewed: 0, discovered: 0, duplicates: 0, outOfScope: 0, accounted: 0, unaccounted: 0, discoveryGap: 0 };
  const perPortal = {};
  for (const [portal, r] of Object.entries(results)) {
    const rec = reconcile(r, opts);
    perPortal[portal] = rec;
    for (const k of KEYS) total.counts[k] += rec.counts[k];
    for (const k of ['reviewed', 'discovered', 'duplicates', 'outOfScope', 'accounted', 'unaccounted', 'discoveryGap']) total[k] += rec[k];
  }
  return { total, perPortal };
}

/** Fresh results object every bot should start from. */
function emptyResults(note) {
  const r = { discovered: 0, duplicates: 0, outOfScope: 0, reviewed: 0, applied: [], unconfirmed: [], alreadyApplied: [], manualApply: [], skipped: [], failed: [] };
  if (note) r.note = note;
  return r;
}

/**
 * Gatekeeper every bot calls once per card, before any filtering:
 *   - repeat sighting this run → duplicates++, returns 'duplicate'
 *   - otherwise reviewed++ and, if the log (or another portal) already has it
 *     submitted/handed-off, records alreadyApplied and returns 'already'
 *   - failed too many times before → records manualApply and returns 'exhausted'
 *   - else returns 'new' — the caller MUST then put the job in exactly one bucket.
 * Callers add raw card counts to results.discovered themselves.
 */
function admit(results, opts) {
  // Graceful shutdown: stop the bot *before* this card is counted, so the funnel still reconciles.
  if (typeof opts.dedup?.assertRunning === 'function') opts.dedup.assertRunning();
  const gate = admitInner(results, opts);
  // Parallel runs hand bots a job-store view (core/jobdb) that tracks every listing.
  if (typeof opts.dedup?.onAdmit === 'function') opts.dedup.onAdmit(gate, opts.key, opts.job || {});
  return gate;
}

function admitInner(results, { key, seen, dedup, job, site, dryRun = false }) {
  if (seen.has(key)) {
    results.duplicates++;
    return 'duplicate';
  }
  seen.add(key);
  results.reviewed++;
  const prior = typeof dedup.priorDisposition === 'function'
    ? dedup.priorDisposition(key, { company: job.company, title: job.title })
    : dedup.has(key) ? { kind: 'already', reason: 'already in log' } : null;
  if (prior?.kind === 'already') {
    results.alreadyApplied.push({ ...job, reason: prior.reason });
    return 'already';
  }
  if (prior?.kind === 'exhausted') {
    results.manualApply.push({ ...job, companyUrl: job.companyUrl || job.url, reason: prior.reason });
    // Persist the hand-off so later runs stop retrying it.
    if (!dryRun && site) {
      dedup.append({ site, job_title: job.title, company: job.company, job_url: key, status: 'manual-apply', notes: prior.reason });
    }
    return 'exhausted';
  }
  return 'new';
}

/**
 * Why a direct application was handed off, as short categories for the
 * per-ATS report ("current_location", "consent box", "Workday: no session"…).
 */
function blockersFrom(reason = '') {
  const r = String(reason);
  if (/workday.*no signed-in/i.test(r)) return ['Workday: no signed-in session'];
  if (/workday.*session reused/i.test(r)) return ['Workday: multi-page form needs you'];
  if (/captcha|turnstile/i.test(r)) return ['CAPTCHA'];
  if (/login required/i.test(r)) return ['login required'];
  if (/without a supported ATS/i.test(r)) return ['custom career page (no ATS form)'];
  if (/could not fill required/i.test(r)) return ['form field could not be filled'];
  if (/rejected the submission|would not advance/i.test(r)) return ['employer form rejected input'];
  const m = r.match(/needs your answer:\s*(.*)$/i);
  if (!m) return r ? ['other'] : [];
  const out = new Set();
  for (const item of m[1].split(/;\s*/)) {
    const why = (item.match(/\(([^()]*)\)\s*$/) || [])[1] || '';
    const label = item.toLowerCase();
    let cat;
    if (/^(\w+) not in profile$/.test(why) && !/^not in profile$/.test(why)) cat = why.replace(' not in profile', '');
    else if (/consent/.test(why)) cat = 'consent box';
    else if (/demographic/.test(why)) cat = 'demographic question';
    else if (/free-text/.test(why)) cat = 'essay / free text';
    else if (/ctc|compensation|salary|pay\b/.test(label)) cat = 'current CTC';
    else if (/years?|experience/.test(label)) cat = 'skill years';
    else if (/hear about|referr|know anyone|source/.test(label)) cat = 'referral / source question';
    else if (/locat|city|relocat|hybrid|office|onsite|on-site/.test(label)) cat = 'location question';
    else cat = 'other question';
    out.add(cat);
  }
  return [...out];
}

module.exports = { blockersFrom, DISPOSITIONS, KEYS, BUCKETS, classify, reconcile, reconcileAll, emptyResults, admit };

/**
 * Parallel-run claim gate, called by a bot right before it would apply (or, in a
 * dry run, record "would apply"). With the plain dedup module it is a no-op.
 * With a job-store view it atomically claims the job across all portal workers
 * and waits for an application slot. Returns false (job recorded as already
 * handled) when another worker holds the same job or role.
 */
async function claimGate(results, dedup, key, job) {
  if (typeof dedup?.claimForApply !== 'function') return true;
  const c = await dedup.claimForApply(key, job);
  if (c.ok) return true;
  results.alreadyApplied.push({ ...job, reason: c.reason });
  return false;
}

module.exports.claimGate = claimGate;
