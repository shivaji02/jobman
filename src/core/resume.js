/**
 * Resume files — one source of truth for every bot.
 *
 * Audit 2026-11-05: all bots hard-coded /Users/neosoft/Downloads/Resumes/…, a
 * path from another machine, and "ShivajiPresidio.pdf", which no longer exists.
 * Uploads silently attached nothing. Paths now come from JOBMAN_RESUME_DIR
 * (default ~/Downloads/Resumes) or config/candidate.json → resumes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROFILE_FILE = path.join(__dirname, '..', '..', 'config', 'candidate.json');
const DEFAULT_FILES = { rn: 'shivajirn02.pdf', fs: 'shivajifs02.pdf', fe: 'shivajife02.pdf' };

function configured() {
  try {
    return JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')).resumes || {};
  } catch {
    return {};
  }
}

function resolve(kind) {
  const cfg = configured();
  const dir = process.env.JOBMAN_RESUME_DIR || cfg.dir || path.join(os.homedir(), 'Downloads', 'Resumes');
  const file = cfg[kind] || DEFAULT_FILES[kind];
  return path.isAbsolute(file) ? file : path.join(dir, file);
}

const RESUME_RN = resolve('rn');
const RESUME_FS = resolve('fs');
const RESUME_FE = resolve('fe');

/** Pick the resume variant that best matches the posting. */
function selectResume(jobTitle = '', jobText = '') {
  const title = String(jobTitle).toLowerCase();
  const blob = `${jobTitle} ${jobText}`.toLowerCase();
  // The title decides first; the description only breaks ties. (A "Frontend
  // Engineer" posting that mentions "mobile-responsive" still gets the FE resume.)
  if (/react[\s-]?native|\bnative\b|\bmobile\b|\bexpo\b/.test(title)) return RESUME_RN;
  if (/full[\s-]?stack|\bnode|backend|back[\s-]end|\bmern\b/.test(title)) return RESUME_FS;
  if (/front[\s-]?end|\breact(\.?js)?\b|\bui\b|web developer/.test(title)) return RESUME_FE;
  if (/react[\s-]?native|\bnative\b|\bmobile\b|\bexpo\b/.test(blob)) return RESUME_RN;
  return RESUME_FS;
}

/** Missing resume files are reported once at startup instead of failing silently per upload. */
function missingResumes() {
  return [RESUME_RN, RESUME_FS, RESUME_FE].filter((f) => !fs.existsSync(f));
}

module.exports = { selectResume, missingResumes, RESUME_RN, RESUME_FS, RESUME_FE };
