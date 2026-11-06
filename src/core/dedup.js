/**
 * Dedup log — data/applied_jobs_log.csv
 * Columns: date,site,job_title,company,job_url,status,notes
 *
 * Appends IMMEDIATELY after every attempt (applied/unconfirmed/skipped/failed/manual-apply)
 * — never batched, so partial runs persist progress. Dedup checks consider rows
 * with status applied / unconfirmed / manual-apply (BLOCKING_STATUSES); failed
 * rows are retried in later runs up to MAX_FAILED_ATTEMPTS, skipped rows are
 * re-screened (filters may change).
 * `isApplied(url)` is true only for status === 'applied' (any day in the log).
 * job_url is matched after normalizeJobUrl (query-string stripped; hash kept).
 */
const fs = require('fs');
const { canonicalAtsUrl } = require('./ats');
const path = require('path');

const COLUMNS = ['date', 'site', 'job_title', 'company', 'job_url', 'status', 'notes'];
const DEFAULT_LOG = path.join(__dirname, '..', '..', 'data', 'applied_jobs_log.csv');

/** RFC4180-ish single-record CSV field parser (no multi-line quoted fields needed here). */
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function csvEscape(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    header.forEach((col, i) => { row[col] = values[i] ?? ''; });
    return row;
  });
}

function toCsvRow(values) {
  return values.map(csvEscape).join(',') + '\n';
}

/**
 * Query params that *are* the job identity on some hosts. Everything else in
 * the query string is tracking noise (Naukri `?src=&sid=` changes every search).
 *
 * Audit 2026-11-05: Indeed keys jobs only by `?jk=`. Stripping it collapsed every
 * Indeed job onto `https://in.indeed.com/viewjob`, so a single manual-apply row
 * made dedup.has() true for *all* Indeed jobs (347 reviewed, 0 processed).
 */
const IDENTITY_PARAMS = [
  { host: /(^|\.)indeed\.com$/, params: ['jk', 'vjk'], as: 'jk' },
  { host: /(^|\.)talent\.com$/, params: ['id'], as: 'id' },
  { host: /(^|\.)greenhouse\.io$/, params: ['gh_jid'], as: 'gh_jid' },
];

/**
 * Canonicalize a job_url for dedup.
 * Strips tracking query params and a trailing slash, keeps identity params
 * (IDENTITY_PARAMS) and the hash (Instahyre keys live in the fragment).
 * LinkedIn search-result links (`?currentJobId=N`) become /jobs/view/N.
 */
function normalizeJobUrl(jobUrl) {
  const raw = String(jobUrl || '').trim();
  if (!raw) return '';
  // Employer ATS postings (Greenhouse/Lever/Ashby/SmartRecruiters/Workday) get one
  // canonical key however they were reached (Google, a portal redirect, /apply, embeds).
  const ats = canonicalAtsUrl(raw);
  if (ats) return ats;
  try {
    const u = new URL(raw);
    u.hostname = u.hostname.toLowerCase();
    if (/(^|\.)linkedin\.com$/.test(u.hostname)) {
      const id = u.searchParams.get('currentJobId') || (u.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/) || [])[1];
      if (id) return `https://www.linkedin.com/jobs/view/${id}`;
    }
    const rule = IDENTITY_PARAMS.find((r) => r.host.test(u.hostname));
    const idValue = rule ? rule.params.map((k) => u.searchParams.get(k)).find(Boolean) : null;
    u.search = idValue ? `?${rule.as}=${idValue}` : '';
    if (!u.hash && u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    return u.href;
  } catch {
    return raw.split('#')[0].split('?')[0].replace(/\/+$/, '');
  }
}

/** True when a normalized URL is a bare host/path with no job identity (corrupted key). */
function isIdentitylessUrl(url) {
  return /^https:\/\/in\.indeed\.com\/viewjob$/.test(url);
}

/**
 * Cross-portal fingerprint: the same posting is often syndicated (Naukri ⇄
 * Foundit ⇄ Talent.com ⇄ company ATS). Company + title, normalized.
 */
function jobFingerprint(company, title) {
  const n = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/\(.*?\)/g, ' ')
      .replace(/\b(pvt|private|ltd|limited|inc|llp|technologies|technology|solutions|services|india|software)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const c = n(company);
  const t = n(title);
  return c && t ? `${c}|${t}` : '';
}

/**
 * Statuses that mean "never submit again":
 *   applied      — confirmed submission
 *   unconfirmed  — submit was clicked but success could not be verified; resubmitting
 *                  could create a duplicate application, so it is never retried
 *   manual-apply — handed to the user
 */
const BLOCKING_STATUSES = new Set(['applied', 'unconfirmed', 'manual-apply']);
const SUBMITTED_STATUSES = new Set(['applied', 'unconfirmed']);
/** A job that failed this many times across runs is handed to the user instead of retried. */
const MAX_FAILED_ATTEMPTS = 2;
const FINGERPRINT_WINDOW_DAYS = 45;

/** Factory so tests can point at a temp file. */
function createLog(filePath = DEFAULT_LOG) {
  let state = null;
  let tailChecked = false;

  function emptyState() {
    return {
      blocking: new Set(), // applied + unconfirmed + manual-apply (has)
      strictlyApplied: new Set(), // applied only (isApplied)
      lastStatus: new Map(), // url → { status, notes }
      failures: new Map(), // url → failed-row count
      fingerprints: new Map(), // fingerprint → { date, status, url }
    };
  }

  function index(row) {
    const url = normalizeJobUrl(row.job_url);
    if (!url || isIdentitylessUrl(url)) return;
    const s = state;
    s.lastStatus.set(url, { status: row.status, notes: row.notes || '' });
    if (BLOCKING_STATUSES.has(row.status)) s.blocking.add(url);
    if (row.status === 'applied') s.strictlyApplied.add(url);
    if (row.status === 'failed') s.failures.set(url, (s.failures.get(url) || 0) + 1);
    // An `unconfirmed` row is lifted only by a later check that PROVED nothing was submitted.
    if (row.status === 'failed' && /^verified not applied/i.test(row.notes || '') && s.lastStatus.get(url)?.status === 'failed') {
      if (!s.strictlyApplied.has(url) && !s.handedOff?.has(url)) {
        s.blocking.delete(url);
        const fp = jobFingerprint(row.company, row.job_title);
        if (fp && s.fingerprints.get(fp)?.url === url) s.fingerprints.delete(fp);
      }
    }
    if (row.status === 'manual-apply') (s.handedOff = s.handedOff || new Set()).add(url);
    if (SUBMITTED_STATUSES.has(row.status)) {
      const fp = jobFingerprint(row.company, row.job_title);
      if (fp) s.fingerprints.set(fp, { date: row.date || istDate(), status: row.status, url });
    }
  }

  function load() {
    state = emptyState();
    if (fs.existsSync(filePath)) {
      for (const row of parseCsv(fs.readFileSync(filePath, 'utf8'))) index(row);
    }
    return state.blocking;
  }

  const ensure = () => state || load();

  function has(jobUrl) {
    ensure();
    return state.blocking.has(normalizeJobUrl(jobUrl));
  }

  /** True only when a persisted row for this URL is status === 'applied' (any day). */
  function isApplied(jobUrl) {
    ensure();
    return state.strictlyApplied.has(normalizeJobUrl(jobUrl));
  }

  /** Most recent logged status for a URL, or null. */
  function lastStatus(jobUrl) {
    ensure();
    return state.lastStatus.get(normalizeJobUrl(jobUrl)) || null;
  }

  /** Number of failed attempts logged for this URL across all runs. */
  function failureCount(jobUrl) {
    ensure();
    return state.failures.get(normalizeJobUrl(jobUrl)) || 0;
  }

  /**
   * Same company + title already submitted (on any portal) within the window,
   * under a different URL. Returns { url, status, date } or null.
   */
  function submittedElsewhere(company, title, jobUrl, { now = new Date() } = {}) {
    ensure();
    const fp = jobFingerprint(company, title);
    const hit = fp && state.fingerprints.get(fp);
    if (!hit || hit.url === normalizeJobUrl(jobUrl)) return null;
    const ageDays = (now - new Date(`${hit.date}T00:00:00+05:30`)) / 86_400_000;
    return ageDays <= FINGERPRINT_WINDOW_DAYS ? hit : null;
  }

  /**
   * Prior-run disposition for a URL, used by bots before doing any work:
   *   { kind: 'already', reason }   — submitted / handed off before: never touch again
   *   { kind: 'exhausted', reason } — failed MAX_FAILED_ATTEMPTS times: hand to user
   *   null                          — free to evaluate
   */
  function priorDisposition(jobUrl, { company, title } = {}) {
    ensure();
    const url = normalizeJobUrl(jobUrl);
    const last = state.lastStatus.get(url);
    if (state.blocking.has(url)) {
      const st = state.strictlyApplied.has(url) ? 'applied' : last?.status || 'logged';
      return { kind: 'already', reason: `already ${st} (log)` };
    }
    const elsewhere = company || title ? submittedElsewhere(company, title, url) : null;
    if (elsewhere) return { kind: 'already', reason: `same role already ${elsewhere.status} via ${elsewhere.url}` };
    if ((state.failures.get(url) || 0) >= MAX_FAILED_ATTEMPTS) {
      return { kind: 'exhausted', reason: `failed ${state.failures.get(url)}× in earlier runs — needs a manual look` };
    }
    return null;
  }

  function append(entry) {
    const row = {};
    for (const col of COLUMNS) row[col] = entry[col] != null ? String(entry[col]) : '';
    if (!row.date) row.date = istDate();
    if (row.job_url) row.job_url = normalizeJobUrl(row.job_url);
    ensure();

    // Re-screening the same listing with the same verdict every day bloated the
    // log (one Wellfound job had 91 identical "skipped" rows). Skip exact repeats.
    const last = row.job_url ? state.lastStatus.get(row.job_url) : null;
    if (row.status === 'skipped' && last && last.status === 'skipped' && last.notes === row.notes) return false;

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, COLUMNS.join(',') + '\n');
    } else if (!tailChecked) {
      // guard against a file missing its trailing newline (once per process, not per row)
      const buf = fs.readFileSync(filePath);
      if (buf.length && buf[buf.length - 1] !== 0x0a) fs.appendFileSync(filePath, '\n');
    }
    tailChecked = true;
    fs.appendFileSync(filePath, toCsvRow(COLUMNS.map((c) => row[c])));
    index(row);
    return true;
  }

  return { load, has, isApplied, lastStatus, failureCount, submittedElsewhere, priorDisposition, append, filePath };
}

/** Today's date in IST as YYYY-MM-DD. */
function istDate(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

const defaultLog = createLog();

module.exports = {
  load: defaultLog.load,
  has: defaultLog.has,
  isApplied: defaultLog.isApplied,
  lastStatus: defaultLog.lastStatus,
  failureCount: defaultLog.failureCount,
  submittedElsewhere: defaultLog.submittedElsewhere,
  priorDisposition: defaultLog.priorDisposition,
  append: defaultLog.append,
  createLog,
  istDate,
  COLUMNS,
  normalizeJobUrl,
  jobFingerprint,
  isIdentitylessUrl,
  BLOCKING_STATUSES,
  MAX_FAILED_ATTEMPTS,
};
