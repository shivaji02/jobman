/**
 * Per-job approval before any external submission.
 *
 * 2026-11-09: the approval gate existed but had no queue. Every eligible job was
 * pushed to "Needs you" with "rerun with --approve-url", nothing was persisted,
 * and the only way to submit was to re-run the whole search and hope the job was
 * listed again. 17 prepared candidates → 0 applications.
 *
 * Now a prepared application is written to data/approvals.json with a short id:
 *
 *   pending    prepared (full description read, resume chosen) — waiting for you
 *   approved   you approved this exact job (`jobman approve <id>` or `jobman review`)
 *   declined   you said no — never prepared or submitted again
 *   submitting an atomic job claim was taken; after a crash it is never retried
 *   submitted  an attempt finished; `workflowStatus` distinguishes confirmed,
 *              already applied, failed, manual, and uncertain outcomes
 *
 * The file is shared by the running bot and the approve/review commands (another
 * terminal), so every write is lock → re-read → modify → atomic rename.
 * There is deliberately no "approve everything" command.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeJobUrl } = require('./dedup');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'data', 'approvals.json');

function normalizeApprovals(values = []) {
  const list = Array.isArray(values) ? values : values instanceof Set ? [...values] : [values];
  return new Set(list.map((value) => normalizeJobUrl(value)).filter(Boolean));
}

function isJobApproved(key, approvedJobs = []) {
  const approved = approvedJobs instanceof Set ? approvedJobs : normalizeApprovals(approvedJobs);
  const normalized = normalizeJobUrl(key);
  return !!normalized && approved.has(normalized);
}

function approvalId(key) {
  return crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 7);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function createApprovalStore({ file = DEFAULT_FILE, now = () => Date.now(), lockStaleMs = 10_000 } = {}) {
  const lockFile = `${file}.lock`;

  function withLock(fn) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        fs.closeSync(fs.openSync(lockFile, 'wx'));
        break;
      } catch {
        try {
          if (Date.now() - fs.statSync(lockFile).mtimeMs > lockStaleMs) fs.unlinkSync(lockFile);
        } catch {
          // raced with the holder releasing it
        }
        if (Date.now() > deadline) throw new Error(`approvals file is locked (${lockFile})`);
        sleepSync(25);
      }
    }
    try {
      return fn();
    } finally {
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // ignore
      }
    }
  }

  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data && data.jobs ? { events: [], ...data } : { version: 1, jobs: {}, events: [] };
    } catch {
      return { version: 1, jobs: {}, events: [] };
    }
  }

  function write(data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
  }

  const mutate = (fn) => withLock(() => {
    const data = read();
    const out = fn(data);
    write(data);
    return out;
  });

  /** Add a prepared application. An existing entry keeps its status (a decision is never overwritten). */
  function upsertPrepared(entry) {
    const key = normalizeJobUrl(entry.url) || entry.url;
    return mutate((data) => {
      const prev = data.jobs[key];
      const id = prev?.id || approvalId(key);
      data.jobs[key] = {
        ...prev,
        ...entry,
        id,
        key,
        status: prev?.status || 'pending',
        preparedAt: prev?.preparedAt || new Date(now()).toISOString(),
        lastSeenAt: new Date(now()).toISOString(),
        ...(prev?.decidedAt ? { decidedAt: prev.decidedAt } : {}),
        ...(prev?.outcome ? { outcome: prev.outcome } : {}),
      };
      return data.jobs[key];
    });
  }

  function find(data, ref) {
    const r = String(ref).trim();
    const norm = normalizeJobUrl(r);
    return Object.values(data.jobs).find((j) => j.id === r || j.key === norm || j.url === r);
  }

  /** Approve / decline specific jobs by id or URL. Returns { changed: [], missing: [] }. */
  function decide(refs, status, { note = '' } = {}) {
    if (!['approved', 'declined'].includes(status)) throw new Error(`bad status ${status}`);
    return mutate((data) => {
      const changed = [];
      const missing = [];
      for (const ref of refs) {
        const job = find(data, ref);
        if (!job) {
          missing.push(ref);
          continue;
        }
        if (job.status === 'submitting' || job.status === 'submitted' || job.status === 'unconfirmed') {
          missing.push(`${ref} (already submitted or started; verify before any retry)`);
          continue;
        }
        if (job.status !== 'pending') {
          if (job.status === status) continue;
          missing.push(`${ref} (current status: ${job.status})`);
          continue;
        }
        job.status = status;
        job.decidedAt = new Date(now()).toISOString();
        if (note) job.note = note;
        changed.push(job);
        data.events.push({ type: status, at: job.decidedAt, id: job.id, key: job.key, url: job.url, title: job.title || '', company: job.company || '', note });
      }
      return { changed, missing };
    });
  }

  /**
   * Autonomous approval (JOBMAN_AUTO_APPLY=1). Only a `pending` entry can be auto-approved,
   * and only by the gate in core/auto-apply; the decision is recorded as decidedBy: 'auto'
   * with the blockers-free checks as the note. Anything already decided is left alone.
   */
  function autoApprove(ref, { note = 'auto-apply gate passed' } = {}) {
    return mutate((data) => {
      const job = find(data, ref);
      if (!job) return { changed: false, reason: 'not prepared' };
      if (job.status !== 'pending') return { changed: false, reason: `current status: ${job.status}` };
      const at = new Date(now()).toISOString();
      job.status = 'approved';
      job.decidedAt = at;
      job.decidedBy = 'auto';
      job.note = note;
      data.events.push({ type: 'approved', at, id: job.id, key: job.key, url: job.url, title: job.title || '', company: job.company || '', note, decidedBy: 'auto' });
      return { changed: true, job };
    });
  }

  /** Approve a URL that was never prepared (legacy --approve-url). */
  function approveUrl(url, extra = {}) {
    const key = normalizeJobUrl(url) || url;
    return mutate((data) => {
      const prev = data.jobs[key];
      if (['submitting', 'submitted', 'unconfirmed'].includes(prev?.status)) return prev;
      const at = new Date(now()).toISOString();
      data.jobs[key] = { ...extra, ...prev, id: prev?.id || approvalId(key), key, url: prev?.url || url, status: 'approved', decidedAt: at };
      data.events.push({ type: 'approved', at, id: data.jobs[key].id, key, url, title: data.jobs[key].title || '', company: data.jobs[key].company || '', note: 'approved by URL' });
      return data.jobs[key];
    });
  }

  /** Write-ahead approval state; crash recovery makes this non-retryable. */
  function markSubmitting(key) {
    const k = normalizeJobUrl(key) || key;
    return mutate((data) => {
      const job = data.jobs[k];
      if (!job || job.status !== 'approved') return false;
      const at = new Date(now()).toISOString();
      job.status = 'submitting';
      job.submittingAt = at;
      data.events.push({ type: 'submitting', at, id: job.id, key: job.key, url: job.url, title: job.title || '', company: job.company || '' });
      return true;
    });
  }

  /** A crash after the external side effect may have happened is always uncertain. */
  function recoverSubmitting() {
    return mutate((data) => {
      const recovered = [];
      for (const job of Object.values(data.jobs)) {
        if (job.status !== 'submitting') continue;
        const at = new Date(now()).toISOString();
        job.status = 'unconfirmed';
        job.outcome = { status: 'unconfirmed', reason: 'process stopped during submission; verify on the portal before any retry', at };
        job.recoveredAt = at;
        recovered.push(job);
        data.events.push({ type: 'recovered_unconfirmed', at, id: job.id, key: job.key, url: job.url, title: job.title || '', company: job.company || '' });
      }
      return recovered;
    });
  }

  function recordOutcome(key, outcome) {
    const k = normalizeJobUrl(key) || key;
    return mutate((data) => {
      const job = data.jobs[k];
      if (!job) return null;
      job.status = 'submitted';
      const at = new Date(now()).toISOString();
      job.attemptedAt = at;
      if (outcome.submitted || ['applied', 'unconfirmed'].includes(outcome.status)) job.submittedAt = at;
      job.outcome = outcome;
      const states = { applied: 'confirmed', already: 'already_applied', manual: 'needs_user', failed: 'failed', unconfirmed: 'unconfirmed', skipped: 'rejected' };
      job.workflowStatus = states[outcome.status] || outcome.status || 'failed';
      data.events.push({ type: 'outcome', at, id: job.id, key: job.key, url: job.url, status: job.workflowStatus, reason: outcome.reason || '' });
      return job;
    });
  }

  function list({ status } = {}) {
    return Object.values(read().jobs)
      .filter((j) => !status || (Array.isArray(status) ? status.includes(j.status) : j.status === status))
      .sort((a, b) => String(a.preparedAt || '').localeCompare(String(b.preparedAt || '')));
  }

  function get(key) {
    return read().jobs[normalizeJobUrl(key) || key] || null;
  }

  function approvedKeys() {
    return new Set(list({ status: 'approved' }).map((j) => j.key));
  }

  return { file, upsertPrepared, decide, autoApprove, approveUrl, markSubmitting, recoverSubmitting, recordOutcome, list, get, approvedKeys, read };
}

module.exports = { normalizeApprovals, isJobApproved, createApprovalStore, approvalId, DEFAULT_FILE };
