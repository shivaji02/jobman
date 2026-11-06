/**
 * Screening-question answers, derived ONLY from config/candidate.json.
 * Pure functions — unit tested in tests/screening.test.js.
 *
 * answerFor() returns a string answer, or null when the profile does not hold
 * the information. null means "leave it for the user" — we never guess salary,
 * skill-years, certifications, or anything else not stated in the profile.
 *
 * Audit 2026-11-05 (132 blocked applications in the log):
 *   93 × "How many years of work experience do you have with <skill>?"
 *        → answered from profile.skill_years only (previously the LinkedIn filler
 *          could put total years into ANY skill question, e.g. Kubernetes — removed)
 *   34 × "Mobile phone number" → profile.phone was never used; now filled
 *   ~60 × current/expected CTC, notice period variants → expected/notice now
 *        handled; current CTC needs profile.current_ctc (empty → user must fill)
 */

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** "15-20 LPA" → 15 ; "12 LPA" → 12 ; "" → null */
function lakhsFrom(value) {
  const m = String(value || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

/** Indian mobile without country code: "+91-8978577031" → "8978577031" */
function localPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length > 10 && digits.startsWith('91') ? digits.slice(-10) : digits;
}

/**
 * Find the profile's years for a named skill. Matching is on whole words,
 * case-insensitive, against profile.skill_years keys (and simple aliases).
 */
const SKILL_ALIASES = {
  'react native': ['react-native', 'reactnative', 'rn'],
  react: ['react.js', 'reactjs', 'react js'],
  'node.js': ['node', 'nodejs', 'node js'],
  javascript: ['js', 'es6'],
  typescript: ['ts'],
  postgresql: ['postgres', 'postgre sql'],
  'next.js': ['next', 'nextjs'],
  'express.js': ['express', 'expressjs'],
};

function skillYears(question, profile = {}) {
  const map = profile.skill_years || {};
  const q = ` ${norm(question).replace(/[^a-z0-9.+#\s-]/g, ' ')} `;
  // longest keys first so "react native" wins over "react"
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const names = [norm(key), ...(SKILL_ALIASES[norm(key)] || [])];
    if (names.some((n) => q.includes(` ${n} `) || q.includes(` ${n}?`))) {
      const v = map[key];
      return v == null || v === '' ? null : Number(v);
    }
  }
  return null;
}

/** Does the question ask about a specific technology rather than total experience? */
function namesASkill(q) {
  return /experience (do you have )?(with|in|using|on)\b|years of .* experience (with|in)|\bworked (with|on)\b/.test(q) &&
    !/(total|overall|professional|work) experience\??$/.test(q);
}

/**
 * @param {string} question  label / question text
 * @param {{ type?: string, options?: string[] }} field  input type ('text','number','select','radio','textarea')
 * @param {object} profile   config/candidate.json
 * @returns {string|null}
 */
function answerFor(question, field = {}, profile = {}) {
  const q = norm(question);
  const type = field.type || 'text';
  const options = (field.options || []).map((o) => String(o));
  const yesNo = (yes) => pickOption(options, yes ? /^(yes|y)\b/i : /^(no|n)\b/i) || (options.length ? null : yes ? 'Yes' : 'No');
  const years = Number(profile.experience_years);

  if (!q) return null;

  // ---- contact -------------------------------------------------------------
  if (/\b(mobile|phone|contact) (number|no)\b|^phone\b|^mobile\b/.test(q)) {
    if (!profile.phone) return null;
    return /country code|with code|\+91/.test(q) ? String(profile.phone).replace(/[^\d+]/g, '') : localPhone(profile.phone);
  }
  if (/\be-?mail\b/.test(q)) return profile.email || null;
  if (/linkedin (profile|url)/.test(q)) return profile.links?.linkedin || null;
  if (/portfolio|github|personal (site|website|url)/.test(q)) return profile.portfolio_url || profile.links?.github || profile.links?.portfolio || null;
  if (/^(full )?name\b|your name/.test(q)) return profile.name || null;

  // ---- compensation (never invented) ---------------------------------------
  if (/\b(current|present|existing)\b.*\b(ctc|salary|compensation|package)\b|^ctc\b|what is your ctc/.test(q)) {
    if (!profile.current_ctc) return null;
    return type === 'number' || /lpa|lakh|lac/.test(q) ? String(lakhsFrom(profile.current_ctc) ?? '') || null : String(profile.current_ctc);
  }
  if ((/\b(expected|desired)\b/.test(q) && /ctc|salary|compensation|package/.test(q)) || /\b(ectc|etc|extp ctc)\b/.test(q)) {
    if (!profile.expected_ctc) return null;
    const lakhs = lakhsFrom(profile.expected_ctc);
    if (type === 'number' || /lpa|lakh|lac/.test(q)) return lakhs != null ? String(lakhs) : null;
    if (/\b(inr|rupees|per annum in rs|in rs)\b/.test(q)) return lakhs != null ? String(Math.round(lakhs * 100000)) : null;
    return String(profile.expected_ctc);
  }

  // ---- notice / joining ----------------------------------------------------
  if (/notice period|\bnp\b|how soon can you join|joining (time|date)|when can you (join|start)|serving notice/.test(q)) {
    const days = profile.notice_period_days;
    if (days == null) return null;
    if (/serving notice|are you (currently )?serving/.test(q)) return yesNo(!!profile.serving_notice);
    if (options.length) {
      return (
        pickOption(options, days === 0 ? /immediate|available now|^now$|^0\b|0\s*(days|-)|less than 15|15 days or less|within 15/i : new RegExp(`\\b${days}\\b`)) || null
      );
    }
    return type === 'number' || /days|in days/.test(q) ? String(days) : days === 0 ? 'Immediate' : `${days} days`;
  }
  if (/immediate(ly)? (joiner|join|start)|join immediately|available to start immediately/.test(q)) {
    return profile.available_immediate == null ? null : yesNo(!!profile.available_immediate);
  }

  // ---- relocation ----------------------------------------------------------
  if (/relocat/.test(q)) return profile.willing_to_relocate == null ? null : yesNo(!!profile.willing_to_relocate);

  // ---- experience ----------------------------------------------------------
  if (/additional months of experience/.test(q)) {
    if (!Number.isFinite(years)) return null;
    return String(Math.round((years - Math.floor(years)) * 12));
  }
  if (/experience|years/.test(q)) {
    if (namesASkill(q)) {
      const y = skillYears(q, profile);
      if (y == null) return null; // unknown skill-years → user must supply profile.skill_years
      return formatYears(y, type, options);
    }
    if (/(total|overall|professional|work|relevant|software|engineering|industry)\b.*experience|years of experience|experience in years|how many years/.test(q)) {
      if (!Number.isFinite(years)) return null;
      return formatYears(years, type, options);
    }
  }
  return null;
}

function formatYears(y, type, options) {
  if (options && options.length) {
    // ranges like "1-3 years", "2+ years", "3"
    for (const o of options) {
      const m = o.match(/(\d+(?:\.\d+)?)\s*(?:-|to|–)\s*(\d+(?:\.\d+)?)/);
      if (m && y >= parseFloat(m[1]) && y <= parseFloat(m[2])) return o;
    }
    const exact = options.find((o) => String(parseInt(o, 10)) === String(Math.floor(y)));
    return exact || null;
  }
  return type === 'number' || type === 'text' ? String(Math.floor(y)) : String(Math.floor(y));
}

function pickOption(options, re) {
  return options.find((o) => re.test(String(o).trim())) || null;
}

/**
 * Bulk helper: [{ id, question, type, options }] → { answers: {id: value}, missing: [question] }
 * Only fields the caller marks `required` end up in `missing`.
 */
function planAnswers(fields, profile) {
  const answers = {};
  const missing = [];
  for (const f of fields) {
    const a = answerFor(f.question, f, profile);
    if (a != null && a !== '') answers[f.id] = a;
    else if (f.required) missing.push(String(f.question || f.type).slice(0, 90));
  }
  return { answers, missing };
}

module.exports = { answerFor, planAnswers, skillYears, lakhsFrom, localPhone };
