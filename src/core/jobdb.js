/**
 * Central job store shared by every portal worker in a parallel run.
 *
 * Builds on the persistent CSV log (core/dedup — the permanent history, never
 * rewritten) and adds what concurrency needs:
 *
 *   - one in-memory record per job with an explicit status:
 *       DISCOVERED → ELIGIBLE → CLAIMED → APPLYING → CONFIRMED
 *       ALREADY_APPLIED · NEEDS_USER · FAILED_RETRYABLE · REJECTED
 *   - atomic claiming: a job (by canonical URL **and** by company+title
 *     fingerprint, since Naukri/Foundit/Talent syndicate the same posting) can be
 *     claimed by one worker at a time. The check-and-set is synchronous, so in
 *     Node's single event loop no two workers can interleave inside it.
 *   - a global application-slot semaphore (bounded "application workers"):
 *     discovery keeps running on every portal while at most N submissions are
 *     in flight across all portals.
 *   - a write-ahead journal (data/run-state/jobdb.jsonl). `applying` is written
 *     *before* a submit can happen; the outcome (with evidence) after. On the
 *     next start, any `applying` without an outcome is an interrupted attempt
 *     whose result is unknown → logged `unconfirmed` (blocking) in the CSV, so
 *     it is never resubmitted automatically.
 *
 * Bots don't need to know any of this: each gets a per-portal *view* that is a
 * drop-in replacement for the dedup module plus `claimForApply()`.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const baseDedup = require('./dedup');
const { Semaphore } = require('./concurrency');

const STATUS = Object.freeze({
  DISCOVERED: 'DISCOVERED',
  ELIGIBLE: 'ELIGIBLE',
  CLAIMED: 'CLAIMED',
  APPLYING: 'APPLYING',
  CONFIRMED: 'CONFIRMED',
  ALREADY_APPLIED: 'ALREADY_APPLIED',
  NEEDS_USER: 'NEEDS_USER',
  FAILED_RETRYABLE: 'FAILED_RETRYABLE',
  REJECTED: 'REJECTED',
});

const DEFAULT_STATE_DIR = path.join(__dirname, '..', '..', 'data', 'run-state');

/** CSV status (+ note) → store status. */
function statusFromCsv(csvStatus, notes = '') {
  switch (csvStatus) {
    case 'applied':
      return /already applied|page shows applied|card shows applied/i.test(notes) ? STATUS.ALREADY_APPLIED : STATUS.CONFIRMED;
    case 'unconfirmed':
    case 'manual-apply':
      return STATUS.NEEDS_USER;
    case 'failed':
      return STATUS.FAILED_RETRYABLE;
    case 'skipped':
      return /already/i.test(notes) ? STATUS.ALREADY_APPLIED : STATUS.REJECTED;
    default:
      return null;
  }
}

/** Short rejection category for the dashboard (same buckets as the end-of-run summary). */
function rejectionBucket(reason = '') {
  const r = String(reason).toLowerCase();
  if (/mumbai/.test(r)) return 'Mumbai excluded';
  if (/pune only/.test(r)) return 'Pune (not a listed company)';
  if (/outside south|remote-only|south india city|location/.test(r)) return 'Outside South India';
  if (/experience|yrs|years/.test(r)) return 'Experience out of range';
  if (/stale|closed|no longer/.test(r)) return 'Closed / stale';
  if (/\(full description\)/.test(r)) return 'Role / stack below threshold (full description checked)';
  if (/\(listing card\)/.test(r)) return 'Needs enrichment (listing card only)';
  const score = r.match(/score\s+(-?\d+)/);
  if (score && Number(score[1]) >= 45) return 'Near match — review JD';
  if (/score|threshold|role rejected/.test(r)) return 'Role / stack threshold (evidence level unspecified)';
  if (/cap reached/.test(r)) return 'Per-run cap';
  return 'Other';
}

class ShutdownError extends Error {
  constructor(msg = 'shutdown requested — no new applications started') {
    super(msg);
    this.name = 'ShutdownError';
  }
}

function createJobStore({
  dedup = baseDedup,
  stateDir = DEFAULT_STATE_DIR,
  applyLimit = 3,
  dryRun = false,
  normalize = baseDedup.normalizeJobUrl,
  fingerprint = baseDedup.jobFingerprint,
  makeSkipError = (msg) => new (require('./browser').SkipPortalError)(msg),
  now = () => Date.now(),
} = {}) {
  const events = new EventEmitter();
  events.setMaxListeners(50);
  const jobs = new Map(); // key → record
  const claims = new Map(); // key → { portal, fp, status }
  const fpClaims = new Map(); // fingerprint → { portal, key }
  const applySlots = new Semaphore(applyLimit, { name: 'apply', min: 1, max: 8 });
  const journalFile = path.join(stateDir, dryRun ? 'jobdb.dry-run.jsonl' : 'jobdb.jsonl');
  let shuttingDown = false;

  const stats = {
    seen: 0,
    duplicates: 0,
    screened: 0,
    eligible: 0,
    claimConflicts: 0,
    confirmed: 0,
    confirmedWithEvidence: 0,
    alreadyApplied: 0,
    needsUser: 0,
    unconfirmed: 0,
    failed: 0,
    rejected: 0,
    rejectedBy: {},
    confirmedAt: [],
    perPortal: {},
  };
  const portalStats = (p) =>
    (stats.perPortal[p] = stats.perPortal[p] || { seen: 0, screened: 0, eligible: 0, confirmed: 0, rejected: 0, needsUser: 0, failed: 0, already: 0 });

  function journal(ev) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.appendFileSync(journalFile, `${JSON.stringify({ t: new Date(now()).toISOString(), ...ev })}\n`);
    } catch {
      // journal is best-effort; the CSV remains the source of truth
    }
  }

  function setStatus(key, patch) {
    const prev = jobs.get(key) || { key, history: [] };
    const rec = { ...prev, ...patch, updatedAt: now() };
    if (patch.status && patch.status !== prev.status) rec.history = [...(prev.history || []), patch.status];
    jobs.set(key, rec);
    events.emit('job', rec);
    return rec;
  }

  /**
   * Crash recovery. Replays the journal from the previous (interrupted or
   * finished) run: every `applying` event with no outcome means a submit may
   * have happened → the CSV gets an `unconfirmed` row (blocking) unless the CSV
   * already holds a blocking row for that job. Then the journal is rotated.
   */
  function recover() {
    const recovered = [];
    if (!fs.existsSync(journalFile)) return recovered;
    const open = new Map();
    for (const line of fs.readFileSync(journalFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue; // torn last line after a hard kill
      }
      if (ev.ev === 'applying') open.set(ev.key, ev);
      else if (ev.ev === 'final' || ev.ev === 'release') open.delete(ev.key);
    }
    for (const ev of open.values()) {
      if (!dryRun && !dedup.has(ev.key)) {
        dedup.append({
          site: ev.site || ev.portal,
          job_title: ev.title || '',
          company: ev.company || '',
          job_url: ev.key,
          status: 'unconfirmed',
          notes: `run interrupted during an apply attempt (${ev.t}) — submission state unknown; verify manually (never auto-resubmitted)`,
        });
      }
      recovered.push(ev);
    }
    try {
      fs.renameSync(journalFile, `${journalFile}.prev`);
    } catch {
      // ignore
    }
    return recovered;
  }

  function shutdown() {
    shuttingDown = true;
    applySlots.rejectWaiters(new ShutdownError());
    events.emit('shutdown');
  }

  /** Per-portal, dedup-compatible view handed to a bot. */
  function view(portal, { site = portal } = {}) {
    let held = null; // { key, release, appended }
    const ps = portalStats(portal);

    function releaseHeld(reason) {
      if (!held) return;
      const h = held;
      held = null;
      if (h.release) h.release();
      if (!h.appended && !dryRun) {
        // The bot moved on without logging an outcome for this attempt.
        journal({ ev: 'release', key: h.key, portal, reason });
        const c = claims.get(h.key);
        if (c && c.portal === portal) dropClaim(h.key);
        setStatus(h.key, { status: STATUS.NEEDS_USER, reason: `attempt ended without a logged outcome (${reason})` });
      }
    }

    function dropClaim(key) {
      const c = claims.get(key);
      if (!c) return;
      claims.delete(key);
      if (c.fp && fpClaims.get(c.fp)?.key === key) fpClaims.delete(c.fp);
    }

    function onAdmit(gate, key, job = {}) {
      const k = normalize(key);
      stats.seen++;
      ps.seen++;
      if (gate === 'duplicate') {
        stats.duplicates++;
        return;
      }
      stats.screened++;
      ps.screened++;
      const base = { portal, title: job.title, company: job.company, url: job.url || key };
      if (gate === 'already') {
        stats.alreadyApplied++;
        ps.already++;
        setStatus(k, { ...base, status: STATUS.ALREADY_APPLIED, reason: job.reason || 'in log' });
      } else if (gate === 'exhausted') {
        stats.needsUser++;
        ps.needsUser++;
        setStatus(k, { ...base, status: STATUS.NEEDS_USER, reason: 'failed too often in earlier runs' });
      } else if (!jobs.has(k) || jobs.get(k).status === STATUS.REJECTED) {
        setStatus(k, { ...base, status: STATUS.DISCOVERED });
      }
      events.emit('stats');
    }

    /**
     * Atomically claim a job that passed every filter, then wait for an
     * application slot. Returns { ok: true } or { ok: false, reason } when
     * another worker holds the same job / role, or it was submitted meanwhile.
     * Throws the portal's SkipPortalError during shutdown (stops the bot cleanly
     * with partial results; nothing was submitted).
     */
    async function claimForApply(key, job = {}) {
      releaseHeld('next job claimed');
      if (shuttingDown) throw makeSkipError('shutdown requested — no new applications started');
      const k = normalize(key);
      const fp = fingerprint(job.company, job.title);

      // ---- synchronous check-and-set (atomic in the event loop) ----
      const owner = claims.get(k);
      if (owner && owner.portal !== portal) {
        stats.claimConflicts++;
        return { ok: false, reason: `same job in progress via ${owner.portal}` };
      }
      const fpOwner = fp ? fpClaims.get(fp) : null;
      if (fpOwner && fpOwner.key !== k) {
        stats.claimConflicts++;
        return { ok: false, reason: `same role already handled this run via ${fpOwner.portal} (${fpOwner.key})` };
      }
      const prior = dedup.priorDisposition ? dedup.priorDisposition(k, { company: job.company, title: job.title }) : null;
      if (prior?.kind === 'already') return { ok: false, reason: prior.reason };
      claims.set(k, { portal, fp, status: STATUS.CLAIMED });
      if (fp) fpClaims.set(fp, { portal, key: k });
      // ----------------------------------------------------------------

      stats.eligible++;
      ps.eligible++;
      setStatus(k, { portal, title: job.title, company: job.company, url: job.url || key, status: STATUS.ELIGIBLE });
      setStatus(k, { status: STATUS.CLAIMED });

      if (dryRun) {
        // Nothing is submitted: keep the claim (cross-portal dedup of would-apply)
        // but don't hold an application slot.
        events.emit('stats');
        return { ok: true, dryRun: true };
      }

      let release;
      try {
        release = await applySlots.acquire();
      } catch (err) {
        dropClaim(k);
        setStatus(k, { status: STATUS.DISCOVERED, reason: 'not started (shutdown)' });
        throw makeSkipError(err.message);
      }
      if (shuttingDown) {
        release();
        dropClaim(k);
        throw makeSkipError('shutdown requested — no new applications started');
      }
      held = { key: k, release, appended: false };
      claims.get(k).status = STATUS.APPLYING;
      // Written BEFORE any submit can happen — crash recovery depends on it.
      journal({ ev: 'applying', key: k, portal, site, title: job.title, company: job.company });
      setStatus(k, { status: STATUS.APPLYING });
      events.emit('stats');
      return { ok: true };
    }

    function append(entry) {
      const wrote = dedup.append(entry);
      const k = normalize(entry.job_url);
      const st = statusFromCsv(entry.status, entry.notes || '');
      if (!k || !st) return wrote;
      const evidence = /evidence:/.test(entry.notes || '') ? String(entry.notes).match(/evidence:[^|]*(\|\s*shot:[^|]*)?/)[0].trim() : null;
      setStatus(k, { portal, title: entry.job_title, company: entry.company, status: st, reason: entry.notes || '', evidence });
      switch (st) {
        case STATUS.CONFIRMED:
          stats.confirmed++;
          ps.confirmed++;
          if (evidence) stats.confirmedWithEvidence++;
          stats.confirmedAt.push(now());
          break;
        case STATUS.ALREADY_APPLIED:
          stats.alreadyApplied++;
          ps.already++;
          break;
        case STATUS.NEEDS_USER:
          stats.needsUser++;
          ps.needsUser++;
          if (entry.status === 'unconfirmed') stats.unconfirmed++;
          break;
        case STATUS.FAILED_RETRYABLE:
          stats.failed++;
          ps.failed++;
          break;
        case STATUS.REJECTED: {
          stats.rejected++;
          ps.rejected++;
          const b = rejectionBucket(entry.notes);
          stats.rejectedBy[b] = (stats.rejectedBy[b] || 0) + 1;
          break;
        }
        default:
      }
      if (held && held.key === k) {
        held.appended = true;
        journal({ ev: 'final', key: k, portal, status: entry.status, notes: String(entry.notes || '').slice(0, 400) });
        const submitted = st === STATUS.CONFIRMED || st === STATUS.NEEDS_USER || st === STATUS.ALREADY_APPLIED;
        if (!submitted) dropClaim(k); // failed / rejected → another portal's copy may try
        const h = held;
        held = null;
        h.release();
      } else if (st === STATUS.FAILED_RETRYABLE || st === STATUS.REJECTED) {
        const c = claims.get(k);
        if (c && c.portal === portal && !dryRun) dropClaim(k);
      }
      events.emit('stats');
      return wrote;
    }

    /** Record an outcome that is not written to the CSV (e.g. direct-channel rejections). */
    function record(key, status, reason = '', job = {}) {
      const k = normalize(key);
      setStatus(k, { portal, title: job.title, company: job.company, status, reason });
      if (status === STATUS.REJECTED) {
        stats.rejected++;
        ps.rejected++;
        const b = rejectionBucket(reason);
        stats.rejectedBy[b] = (stats.rejectedBy[b] || 0) + 1;
      }
      events.emit('stats');
    }

    /** Portal finished (or crashed): free its slot and any claims it never used. */
    function close() {
      releaseHeld('portal finished');
      if (dryRun) return;
      for (const [k, c] of claims) {
        if (c.portal === portal && c.status === STATUS.CLAIMED) dropClaim(k);
      }
    }

    return {
      // dedup-compatible surface
      load: dedup.load,
      has: dedup.has,
      isApplied: dedup.isApplied,
      lastStatus: dedup.lastStatus,
      failureCount: dedup.failureCount,
      submittedElsewhere: dedup.submittedElsewhere,
      priorDisposition: dedup.priorDisposition,
      append,
      // parallel-run additions
      assertRunning() {
        if (shuttingDown) throw makeSkipError('shutdown requested — stopped before the next listing');
      },
      onAdmit,
      claimForApply,
      record,
      close,
      portal,
    };
  }

  /** Throughput over the last `windowMs`. */
  function appsPerMinute(windowMs = 10 * 60_000) {
    const t = now();
    const recent = stats.confirmedAt.filter((x) => t - x <= windowMs).length;
    return recent / (windowMs / 60_000);
  }

  function countsByStatus() {
    const out = Object.fromEntries(Object.values(STATUS).map((s) => [s, 0]));
    for (const r of jobs.values()) if (r.status) out[r.status]++;
    return out;
  }

  return {
    STATUS,
    events,
    stats,
    jobs,
    claims,
    applySlots,
    view,
    recover,
    shutdown,
    get shuttingDown() {
      return shuttingDown;
    },
    appsPerMinute,
    countsByStatus,
    journalFile,
  };
}

module.exports = { createJobStore, STATUS, statusFromCsv, rejectionBucket, ShutdownError };
