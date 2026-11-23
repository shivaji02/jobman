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
  'fullstack development': ['full stack development', 'full-stack development', 'fullstack', 'full stack', 'full-stack'],
  'frontend development': ['front end development', 'front-end development', 'frontend', 'front end', 'front-end'],
  html5: ['html'],
  css: ['css3'],
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

  // ---- the user's own written answers (profile.custom_answers) -------------
  for (const ca of Array.isArray(profile.custom_answers) ? profile.custom_answers : []) {
    if (!ca || !ca.match || ca.answer == null || ca.answer === '') continue;
    let re;
    try {
      re = new RegExp(ca.match, 'i');
    } catch {
      continue;
    }
    if (!re.test(q)) continue;
    if (!options.length) return String(ca.answer);
    const exact = options.find((o) => norm(o) === norm(ca.answer));
    if (exact) return exact;
  }

  // ---- contact -------------------------------------------------------------
  if (/\b(mobile|phone|contact) (number|no)\b|^phone\b|^mobile\b/.test(q)) {
    if (!profile.phone) return null;
    return /country code|with code|\+91/.test(q) ? String(profile.phone).replace(/[^\d+]/g, '') : localPhone(profile.phone);
  }
  if (/\be-?mail\b/.test(q)) return profile.email || null;
  // candidate.json stores these as linkedin_url / github_url; `links.*` is the older shape.
  if (/linkedin\b.*\b(profile|url|link)\b|^linkedin\b/.test(q)) return profile.linkedin_url || profile.links?.linkedin || null;
  if (/\bgithub\b/.test(q)) return profile.github_url || profile.links?.github || null;
  if (/portfolio|personal (site|website|url)|^website\b/.test(q)) {
    return profile.portfolio_url || profile.links?.portfolio || profile.github_url || profile.links?.github || null;
  }
  if (/current (city|location)|where are you (currently )?(based|located)|^(current )?(city|location)\s*\*?$/.test(q)) {
    if (!profile.current_location) return null;
    if (!options.length) return String(profile.current_location);
    const city = norm(String(profile.current_location).split(',')[0]);
    return options.find((o) => norm(o).includes(city)) || null;
  }
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

  // ---- last working day (Naukri "Mention Last Working Day", 2026-11-23 stall) ----
  if (/last working (day|date)|\blwd\b|relieving date|date of relieving/.test(q)) {
    const lwd = profile.last_working_day;
    if (!lwd) return null;
    if (type === 'date') return lwd;
    const d = new Date(`${lwd}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? String(lwd)
      : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
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
  // "Earliest start date?" / "When are you available to start?" (LinkedIn 2026-11-22 stall)
  if (/earliest (start|joining|possible)|start date|date of joining|available (to start|from)|availability to (start|join)/.test(q)) {
    if (!profile.available_immediate && profile.notice_period_days !== 0) return null;
    if (type === 'date') return new Date().toISOString().slice(0, 10);
    if (options.length) return pickOption(options, /immediate|asap|now|within (a|1|one) week|0\s*days|less than 15|15 days or less/i);
    return 'Immediately';
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
