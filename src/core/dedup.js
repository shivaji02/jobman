/**
 * Dedup log — data/applied_jobs_log.csv
 * Columns: date,site,job_title,company,job_url,status,notes
 *
 * Appends IMMEDIATELY after every attempt (applied/skipped/failed/manual-apply) — never
 * batched, so partial runs persist progress. Dedup checks consider rows with
 * status === 'applied' or 'manual-apply' (failed/skipped may be retried later).
 * `isApplied(url)` is true only for status === 'applied' (any day in the log).
 * job_url is matched after normalizeJobUrl (query-string stripped; hash kept).
 */
const fs = require('fs');
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
 * Canonicalize a job_url for dedup.
 * Strips query-string tracking params (Naukri `?src=&sid=` changes every search)
 * and a trailing slash. Keeps the hash — Instahyre keys live in the fragment.
 */
function normalizeJobUrl(jobUrl) {
  const raw = String(jobUrl || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    u.search = '';
    if (!u.hash && u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    return u.href;
  } catch {
    return raw.split('#')[0].split('?')[0].replace(/\/+$/, '');
  }
}

/** Factory so tests can point at a temp file. */
function createLog(filePath = DEFAULT_LOG) {
  let appliedUrls = null; // applied + manual-apply (has)
  let strictlyAppliedUrls = null; // applied only (isApplied)

  function load() {
    appliedUrls = new Set();
    strictlyAppliedUrls = new Set();
    if (!fs.existsSync(filePath)) return appliedUrls;
    const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
    for (const row of rows) {
      const url = normalizeJobUrl(row.job_url);
      if (!url) continue;
      if (row.status === 'applied') {
        strictlyAppliedUrls.add(url);
        appliedUrls.add(url);
      } else if (row.status === 'manual-apply') {
        appliedUrls.add(url);
      }
    }
    return appliedUrls;
  }

  function has(jobUrl) {
    if (!appliedUrls) load();
    return appliedUrls.has(normalizeJobUrl(jobUrl));
  }

  /** True only when a persisted row for this URL is status === 'applied' (any day). */
  function isApplied(jobUrl) {
    if (!strictlyAppliedUrls) load();
    return strictlyAppliedUrls.has(normalizeJobUrl(jobUrl));
  }

  function append(entry) {
    const row = {};
    for (const col of COLUMNS) row[col] = entry[col] != null ? String(entry[col]) : '';
    if (!row.date) row.date = istDate();
    if (row.job_url) row.job_url = normalizeJobUrl(row.job_url);

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, COLUMNS.join(',') + '\n');
    } else {
      // guard against a file missing its trailing newline
      const buf = fs.readFileSync(filePath);
      if (buf.length && buf[buf.length - 1] !== 0x0a) fs.appendFileSync(filePath, '\n');
    }
    fs.appendFileSync(filePath, toCsvRow(COLUMNS.map((c) => row[c])));

    if (!appliedUrls) load();
    if (row.job_url && row.status === 'applied') {
      strictlyAppliedUrls.add(row.job_url);
      appliedUrls.add(row.job_url);
    } else if (row.job_url && row.status === 'manual-apply') {
      appliedUrls.add(row.job_url);
    }
  }

  return { load, has, isApplied, append, filePath };
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
  append: defaultLog.append,
  createLog,
  istDate,
  COLUMNS,
  normalizeJobUrl,
};
