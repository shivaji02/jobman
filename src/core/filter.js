/**
 * Role-matching filter. Pure functions — unit tested in tests/filter.test.js.
 *
 * Scoring (see CLAUDE.md):
 *   +40 title contains: react native | mobile developer | mobile engineer
 *   +25 title contains: react | frontend (react) | full stack (node/react)
 *   +20 stack mentions: react native / react / node / typescript
 *   +10 experience range overlaps 1.5-3.5 yrs (or is unknown — neutral)
 *   hard reject: pure iOS/Android native (swift/kotlin-only), .NET, Java-only,
 *                min experience > 3.5, senior/staff/lead/architect titles
 */

const TARGET_EXP = { min: 1.5, max: 3.5 };
// 55 admits frontend/full-stack/react-titled roles (25+20+10) per CLAUDE.md
// while excluding stack-less "Mobile Developer" postings (40+10 = 50).
const DEFAULT_THRESHOLD = 55;

/**
 * Parse experience text like "3-5 Yrs", "2 - 6 years", "0-2 Yrs", "5+ years",
 * "3 years". Returns { min, max } or null when unparseable.
 */
function parseExperienceRange(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.toLowerCase().replace(/,/g, '');

  // "2-6 yrs", "2 - 6 years", "2 to 6 years"
  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*\+?\s*(?:yrs?|years?)?/);
  if (m) {
    const min = parseFloat(m[1]);
    const max = parseFloat(m[2]);
    return { min: Math.min(min, max), max: Math.max(min, max) };
  }

  // "5+ years"
  m = t.match(/(\d+(?:\.\d+)?)\s*\+\s*(?:yrs?|years?)?/);
  if (m) return { min: parseFloat(m[1]), max: Infinity };

  // bare "3 years"
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:yrs?|years?)/);
  if (m) {
    const v = parseFloat(m[1]);
    return { min: v, max: v };
  }

  return null;
}

function rangesOverlap(a, b) {
  return a.min <= b.max && b.min <= a.max;
}

/**
 * Generic engineering titles ("Software Engineer II", "SDE 1", "Product Engineer",
 * "Founding Engineer") carry no stack in the title. Audit 2026-11-07: they all
 * capped at 30 and were rejected even when the description was a React/Node job
 * (Swiggy SDE I: React + React Native + TypeScript, nothing else). They earn the
 * title points only when the description is *dominated* by our stack: at least
 * two distinct JS-stack signals, and more JS-stack mentions than competing stacks
 * (Java, Go, Python, C++, Ruby, PHP, Angular, Vue, Flutter…). Seniority, .NET,
 * Java-only, native-only and experience hard rejects still apply unchanged.
 */
const GENERIC_ENG_TITLE = /\b(software|product|application|founding|web)\s+(development\s+)?(engineer|developer)\b|\bsde\b|\bswe\b|\bsoftware\s+dev(eloper)?\s+engineer\b|\bsoftware\s+development\s+engineer\b/;
const JS_SIGNALS = [/react\s*native/g, /react(?!\s*native)(?:\.?js)?\b/g, /node(?:\.?js)?\b/g, /typescript/g, /next\.?js\b/g, /\bexpo\b/g, /\bmern\b/g];
const COMPETING = /\bjava\b(?!script)|\bgolang\b|\bgo\b(?=\s*(?:lang|,|\/|\)|and|or|developer|engineer|services|microservices))|\bpython\b|\bdjango\b|c\+\+|\bruby\b|\brails\b|\bphp\b|\blaravel\b|\bscala\b|\brust\b|\bangular\b|\bvue(?:\.?js)?\b|\bflutter\b|\bdart\b|\bswift\b|\bkotlin\b|\bc#/g;

/**
 * How much of a description is our stack vs competing stacks — used to *flag*
 * (never reject) jobs where React/Node is a side note to Python/Java/Angular…
 */
function stackBalance(text) {
  const blob = String(text || '').toLowerCase();
  let js = 0;
  for (const re of JS_SIGNALS) js += (blob.match(re) || []).length;
  const counts = {};
  for (const m of blob.match(COMPETING) || []) counts[m.trim()] = (counts[m.trim()] || 0) + 1;
  const competing = Object.values(counts).reduce((a, b) => a + b, 0);
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  return { js, competing, top, dominant: competing > js ? 'other' : 'ours' };
}

function jsStackDominant(titleLc, blob) {
  if (!GENERIC_ENG_TITLE.test(titleLc)) return false;
  let distinct = 0;
  let js = 0;
  for (const re of JS_SIGNALS) {
    const n = (blob.match(re) || []).length;
    if (n) distinct++;
    js += n;
  }
  const competing = (blob.match(COMPETING) || []).length;
  return distinct >= 2 && js > competing;
}

// MERN = Mongo/Express/React/Node; Next.js and Expo are React frameworks.
const OUR_STACK = /react\s*native|react(?:\.?js)?\b|node(?:\.?js)?\b|typescript|javascript|\bmern\b|next\.?js\b|\bexpo\b/;

/**
 * Why a job is rejected outright, or null. `basis` says what the verdict rests on:
 *   'title'      — stated in the title (seniority, internship, .NET in title …): definitive
 *   'presence'   — a disqualifying term is present in the text (.NET / C#): definitive
 *   'absence'    — none of our stack was found next to Java/Swift/Kotlin/iOS-only terms.
 *                  On a listing card that is *missing information*, not a confirmed
 *                  mismatch — core/evaluate asks for the full description first.
 *   'experience' — the stated minimum is above our range: definitive
 */
function hardReject({ title = '', description = '', experienceText = '', skills = [] } = {}) {
  const titleLc = String(title).toLowerCase();
  const blob = [title, description, Array.isArray(skills) ? skills.join(' ') : String(skills || '')]
    .join(' ')
    .toLowerCase();
  const r = (code, reason, basis) => ({ code, reason, basis });

  if (/\b(senior|sr\.?|staff|lead|principal|architect|manager|director|head)\b/.test(titleLc)) return r('seniority', 'senior / lead title', 'title');
  // Entry programmes don't fit a 2.7-year profile.
  if (/\b(intern|internship|apprentice|apprenticeship|trainee)\b/.test(titleLc)) return r('entry', 'internship / trainee title', 'title');
  // Level-numbered senior titles: "SDE 3", "SDE-III", "Engineer III". Digit form
  // only for sde/swe (so "Developer 3-5 yrs" style titles aren't hit); roman
  // numerals III+ for any engineer/developer title. Levels 1-2 stay eligible.
  if (/\b(?:sde|swe)\s*[-.]?\s*(?:iii|iv|v|[3-9])\b/.test(titleLc)) return r('level', 'level 3+ title', 'title');
  if (/\b(?:engineer|developer)\s+(?:iii|iv|v)\b/.test(titleLc)) return r('level', 'level 3+ title', 'title');
  // Spelled-out "Software Development Engineer 3" / "Software Dev Engineer III" (not "… 3-5 yrs").
  if (/\bsoftware\s+dev(?:elopment|eloper)?\s+engineer\s*[-,]?\s*(?:iii|iv|v|[3-9])\b(?!\s*(?:[-–+.]|to\b|yrs?|years?))/.test(titleLc)) return r('level', 'level 3+ title', 'title');
  if (/\.net\b|dotnet|c#|\basp\s?net\b/.test(titleLc)) return r('dotnet', '.NET role', 'title');
  // ".NET" often loses its dot in titles: "NET Full Stack Developer", "Net Core Developer"
  if (/(^|[^a-z])net\s+(full\s*stack|developer|engineer|core|mvc)\b/.test(titleLc)) return r('dotnet', '.NET role', 'title');
  if (/\.net\b|dotnet|c#|\basp\s?net\b/.test(blob)) return r('dotnet', '.NET in description', 'presence');

  const mentionsOurStack = OUR_STACK.test(blob);
  // pure native mobile (Swift/Kotlin/Objective-C) with none of our stack
  if (/\b(swift|kotlin|objective-?c)\b/.test(blob) && !mentionsOurStack) return r('native', 'native iOS/Android only (no React Native / JS stack)', 'absence');
  // Java-only roles
  if (/\bjava\b/.test(blob) && !mentionsOurStack) return r('java', 'Java only (no React / Node)', 'absence');
  // pure iOS/Android titles
  if (/\b(ios|android)\s+(developer|engineer)/.test(titleLc) && !/react\s*native|hybrid|cross[- ]platform/.test(blob)) {
    return r('native', 'native iOS/Android title', 'absence');
  }

  const range = parseExperienceRange(experienceText);
  if (range && range.min > TARGET_EXP.max) return r('experience', `minimum ${range.min} yrs`, 'experience'); // 5+ yr minimums etc.
  // "Freshers" in the title states a 0–1 yr level: outside the 1.5–3.5 yr overlap rule (audit 2026-11-10).
  if (/\bfreshers?\b/.test(titleLc) && !range) return r('experience', 'freshers-only role (0-1 yrs)', 'experience');
  return null;
}

/**
 * Score a job 0-100. Returns a negative number on hard reject so callers can
 * distinguish "rejected outright" from "didn't score enough".
 */
function scoreJob({ title = '', description = '', experienceText = '', skills = [] } = {}) {
  const titleLc = String(title).toLowerCase();
  const blob = [title, description, Array.isArray(skills) ? skills.join(' ') : String(skills || '')]
    .join(' ')
    .toLowerCase();

  if (hardReject({ title, description, experienceText, skills })) return -100;
  const mentionsOurStack = OUR_STACK.test(blob);
  const range = parseExperienceRange(experienceText);

  // ---- positive scoring ---------------------------------------------------
  let score = 0;

  if (
    // Audit 2026-11-10: "Mobile Application Developer" (Foundit/Talent/LinkedIn) missed the
    // mobile tier because only "mobile app developer" matched; Expo is React Native, and
    // hybrid / cross-platform mobile titles are the same job family. Stack evidence (+20)
    // is still required to reach the threshold, exactly as before.
    /react\s*native|mobile\s*(app(?:lication)?\s*)?(developer|engineer)|\bexpo\b|(hybrid|cross[- ]platform)\s+(mobile\s+)?(app(?:lication)?\s+)?(developer|engineer)/.test(titleLc) ||
    // "Product Engineer (Mobile)", "Mobile Product Engineer": mobile role whose JD is React Native
    (/\bmobile\b/.test(titleLc) && /\b(engineer|developer|sde)\b/.test(titleLc) && /react\s*native/.test(blob))
  ) {
    score += 40;
  } else if (
    /react/.test(titleLc) || // "React JS Developer", "ReactJS developer", ...
    (/front[- ]?end/.test(titleLc) && /react|next\.?js/.test(blob)) ||
    (/full[- ]?stack/.test(titleLc) && /(node|react|\bmern\b)/.test(blob)) ||
    jsStackDominant(titleLc, blob)
  ) {
    score += 25;
  }

  if (mentionsOurStack) score += 20;

  if (range && rangesOverlap(range, TARGET_EXP)) score += 10;
  // Unknown experience is neutral, not a penalty: LinkedIn cards never carry
  // experience text, so anything below +10 permanently handicaps that portal.
  else if (!range) score += 10;

  return Math.min(score, 100);
}

/**
 * Required experience stated in a job description, e.g. "5 to 8 years of
 * experience", "3+ years of professional experience", "minimum 4 years",
 * "Experience: 2-4 years". The first stated requirement wins. Returns
 * { min, max } (max Infinity for "N+") or null.
 */
function experienceFromText(text) {
  const t = String(text || '')
    .replace(/&#x?[0-9a-f]+;|&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  const num = '(\\d+(?:\\.\\d+)?)';
  const patterns = [
    // "5 to 8 years of experience", "3+ yrs relevant experience", "2-4 years' experience"
    new RegExp(`${num}\\s*(\\+|plus)?\\s*(?:(?:-|–|to)\\s*${num}\\s*\\+?)?\\s*(?:yrs?|years?)(?:['’]s?)?\\s*(?:of\\s+)?(?:[a-z/.+#&-]+\\s+){0,5}?(?:experience|exp\\b)`),
    // "minimum (of) 4 years", "at least 3 years"
    new RegExp(`(?:minimum(?: of)?|at least|min\\.?)\\s*${num}\\s*(\\+)?\\s*(?:yrs?|years?)`),
    // "Experience: 2-4 years", "experience required 3+ years"
    new RegExp(`experience\\s*(?:required|level)?\\s*[:\\-–]?\\s*${num}\\s*(\\+)?\\s*(?:(?:-|–|to)\\s*${num})?\\s*(?:yrs?|years?)`),
  ];
  let best = null;
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const min = parseFloat(m[1]);
    const max = m[3] ? parseFloat(m[3]) : m[2] ? Infinity : min;
    if (min > 25) continue; // "25 years in business", not a requirement
    if (!best || m.index < best.index) best = { min: Math.min(min, max), max: Math.max(min, max), index: m.index };
  }
  return best ? { min: best.min, max: best.max } : null;
}

function shouldApply(score, threshold = DEFAULT_THRESHOLD) {
  return score >= threshold;
}

module.exports = {
  scoreJob,
  hardReject,
  stackBalance,
  OUR_STACK,
  shouldApply,
  parseExperienceRange,
  experienceFromText,
  TARGET_EXP,
  DEFAULT_THRESHOLD,
};
