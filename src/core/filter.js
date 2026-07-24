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
 * Score a job 0-100. Returns a negative number on hard reject so callers can
 * distinguish "rejected outright" from "didn't score enough".
 */
function scoreJob({ title = '', description = '', experienceText = '', skills = [] } = {}) {
  const titleLc = String(title).toLowerCase();
  const blob = [title, description, Array.isArray(skills) ? skills.join(' ') : String(skills || '')]
    .join(' ')
    .toLowerCase();

  // ---- hard rejects -------------------------------------------------------
  if (/\b(senior|sr\.?|staff|lead|principal|architect)\b/.test(titleLc)) return -100;
  // Level-numbered senior titles: "SDE 3", "SDE-III", "Engineer III". Digit form
  // only for sde/swe (so "Developer 3-5 yrs" style titles aren't hit); roman
  // numerals III+ for any engineer/developer title. Levels 1-2 stay eligible.
  if (/\b(?:sde|swe)\s*[-.]?\s*(?:iii|iv|v|[3-9])\b/.test(titleLc)) return -100;
  if (/\b(?:engineer|developer)\s+(?:iii|iv|v)\b/.test(titleLc)) return -100;
  if (/\.net\b|dotnet|c#/.test(blob)) return -100;

  const mentionsOurStack = /react\s*native|react(?:\.?js)?\b|node(?:\.?js)?\b|typescript|javascript/.test(blob);
  // pure native mobile (Swift/Kotlin/Objective-C) with none of our stack
  if (/\b(swift|kotlin|objective-?c)\b/.test(blob) && !mentionsOurStack) return -100;
  // Java-only roles
  if (/\bjava\b/.test(blob) && !mentionsOurStack) return -100;
  // pure iOS/Android titles
  if (/\b(ios|android)\s+(developer|engineer)/.test(titleLc) && !/react\s*native|hybrid|cross[- ]platform/.test(blob)) {
    return -100;
  }

  const range = parseExperienceRange(experienceText);
  if (range && range.min > TARGET_EXP.max) return -100; // 5+ yr minimums etc.

  // ---- positive scoring ---------------------------------------------------
  let score = 0;

  if (/react\s*native|mobile\s*(app\s*)?(developer|engineer)/.test(titleLc)) {
    score += 40;
  } else if (
    /react/.test(titleLc) || // "React JS Developer", "ReactJS developer", ...
    (/front[- ]?end/.test(titleLc) && /react/.test(blob)) ||
    (/full[- ]?stack/.test(titleLc) && /(node|react)/.test(blob))
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

function shouldApply(score, threshold = DEFAULT_THRESHOLD) {
  return score >= threshold;
}

module.exports = {
  scoreJob,
  shouldApply,
  parseExperienceRange,
  TARGET_EXP,
  DEFAULT_THRESHOLD,
};
