/**
 * Answers for employer application forms — derived ONLY from
 * config/candidate.json. Pure functions (unit tested in tests/ats.test.js).
 *
 * answerQuestion(q, profile, job) → { value, source } | { value: null, why }
 *   q = { label, kind, required, options[] }
 *   kind: text | email | tel | url | number | textarea | select | radio |
 *         checkbox | checkboxes | combobox | yesno | file
 *
 * Rules (the brief: "Do not invent experience, compensation, qualifications or
 * consent answers"):
 *   - identity/contact fields come from the profile verbatim
 *   - screening questions go through core/screening (skill-years, CTC, notice…)
 *   - free-text essays ("why us", "describe a project") are answered only from
 *     profile.custom_answers, which the user writes; never generated
 *   - consent / privacy / terms boxes are ticked only if profile.consents says so
 *   - demographic questions (gender, race, veteran, disability): left blank when
 *     optional; when required, the explicit "decline to answer" option is used
 *     if the form offers one, else the question goes to the user
 */
const { answerFor } = require('../core/screening');

const norm = (s) => String(s || '').toLowerCase().replace(/[✱*]/g, ' ').replace(/\s+/g, ' ').trim();

function nameParts(profile) {
  const parts = String(profile.name || '').trim().split(/\s+/);
  return { first: parts.slice(0, -1).join(' ') || parts[0] || '', last: parts.length > 1 ? parts[parts.length - 1] : '' };
}

function phoneFor(kind, profile) {
  const digits = String(profile.phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const local = digits.length > 10 && digits.startsWith('91') ? digits.slice(-10) : digits;
  return `+91 ${local}`;
}

const pick = (options, re) => (options || []).find((o) => re.test(String(o))) || null;
const DECLINE_RE = /decline|prefer not|don.?t wish|do not wish|not to (say|disclose|answer)|rather not/i;

/** Ordered rules: [labelRegex, (q, profile, job) => value|null, sourceName] */
const RULES = [
  [/^(legal )?first name|given name/, (q, p) => nameParts(p).first, 'profile.name'],
  [/^(legal )?last name|surname|family name/, (q, p) => nameParts(p).last, 'profile.name'],
  [/^(full |legal |your )?name$|^full name|^name\b(?!.*(company|employer|school|reference|manager))/, (q, p) => p.name || null, 'profile.name'],
  [/^(confirm( your)? |re-?enter( your)? )?e-?mail( address)?$|^e-?mail\b/, (q, p) => p.email || null, 'profile.email'],
  // Whole words only: "PhonePe" or "mobile app experience" are not phone fields.
  [/^(phone|mobile|contact|whatsapp)( (number|no\.?))?$|\b(phone|mobile|contact|whatsapp) (number|no\.?)\b|^(your )?phone\b/, (q, p) => phoneFor(q.kind, p), 'profile.phone'],
  [/^country( of residence)?$|^which country|country you (live|reside)/, (q, p) => (q.options?.length ? pick(q.options, new RegExp(`^${p.country || 'India'}\\b`, 'i')) || (q.kind === 'combobox' ? p.country || 'India' : null) : p.country || 'India'), 'profile.country'],
  [/linked-?in/, (q, p) => p.linkedin_url || null, 'profile.linkedin_url'],
  [/github/, (q, p) => p.github_url || null, 'profile.github_url'],
  [/portfolio|personal (web)?site|^website/, (q, p) => p.portfolio_url || null, 'profile.portfolio_url'],
  [/^current (location|city)|^location( \(city\))?$|where are you (currently )?(based|located)|^city$|current address/, (q, p) => p.current_location || null, 'profile.current_location'],
  [/current (company|employer|organi[sz]ation)|^company$|^org$|(current|last|latest) (or last )?payroll company|most recent (company|employer)/, (q, p) => p.current_company || null, 'profile.current_company'],
  [/current (job )?(title|role|designation)|^title$|most recent (job )?title/, (q, p) => p.current_role || null, 'profile.current_role'],
];

const CONSENT_RE = /\b(consent|privacy|terms|agree|acknowledge|gdpr|data protection|processing of (my )?(personal )?data|i (certify|confirm|understand))\b/;
const DEMOGRAPHIC_RE = /\b(gender|sex|pronoun|race|ethnic|veteran|disabilit|sexual orientation|transgender|lgbt|caste|religion|marital)\b/;
const ESSAY_RE = /\bwhy\b|describe|tell us|explain|what (made|makes|excites|interests)|cover letter|motivation|reason for (job )?change|anything else|additional information|about yourself/;

function customAnswer(label, profile) {
  for (const entry of profile.custom_answers || []) {
    if (!entry || !entry.match || entry.answer == null || entry.answer === '') continue;
    let re;
    try {
      re = new RegExp(entry.match, 'i');
    } catch {
      continue;
    }
    if (re.test(label)) return String(entry.answer);
  }
  return null;
}

/** Pick the option that matches a free answer ("Yes" → "Yes, I am"). */
function fitToOptions(value, options) {
  if (value == null || !options || !options.length) return value;
  const v = norm(value);
  return (
    options.find((o) => norm(o) === v) ||
    options.find((o) => norm(o).startsWith(v)) ||
    options.find((o) => v.startsWith(norm(o)) && norm(o).length > 1) ||
    null
  );
}

function answerQuestion(q, profile = {}, job = {}) {
  const label = norm(q.label);
  const options = q.options || [];
  if (q.kind === 'file') {
    if (/resume|cv\b|curriculum/.test(label) || !label) return job.resume ? { value: job.resume, source: 'resume' } : { value: null, why: 'no resume file' };
    if (/cover/.test(label)) return profile.cover_letter_file ? { value: profile.cover_letter_file, source: 'profile.cover_letter_file' } : { value: null, why: 'cover letter file' };
    return { value: null, why: 'file upload' };
  }

  // User-written answers win over everything below.
  const custom = customAnswer(q.label || '', profile);
  if (custom != null) {
    const v = options.length ? fitToOptions(custom, options) : custom;
    if (v != null) return { value: v, source: 'profile.custom_answers' };
  }

  if (CONSENT_RE.test(label) && (q.kind === 'checkbox' || q.kind === 'yesno' || /^(i |by )/.test(label))) {
    const ok = profile.consents && profile.consents.privacy_and_terms === true;
    if (!ok) return { value: null, why: 'consent box — set consents.privacy_and_terms in candidate.json to allow' };
    return { value: q.kind === 'checkbox' ? true : fitToOptions('Yes', options) || 'Yes', source: 'profile.consents' };
  }

  if (DEMOGRAPHIC_RE.test(label)) {
    const own = (profile.demographics || {})[label.match(DEMOGRAPHIC_RE)[1]];
    if (own) {
      const v = options.length ? fitToOptions(own, options) : own;
      if (v != null) return { value: v, source: 'profile.demographics' };
    }
    const decline = pick(options, DECLINE_RE);
    if (decline) return { value: decline, source: 'decline option' };
    return { value: null, why: 'demographic question' };
  }

  const choice = ['radio', 'checkbox', 'checkboxes', 'yesno', 'combobox'].includes(q.kind);
  const CHOICE_OK = new Set(['profile.country', 'profile.current_location']); // dropdowns that ARE these facts
  for (const [re, fn, source] of RULES) {
    if (choice && !CHOICE_OK.has(source)) continue; // "phone screen OK?" / "employed at PhonePe?" are not identity fields
    if (re.test(label)) {
      const v = fn(q, profile, job);
      if (v == null || v === '') return { value: null, why: source.replace('profile.', '') + ' not in profile' };
      let fitted = options.length ? fitToOptions(v, options) : v;
      // Long comboboxes (country lists) only show the first options; typing filters them.
      if (fitted == null && q.kind === 'combobox') fitted = v;
      return fitted == null ? { value: null, why: `no option matches ${source}` } : { value: fitted, source };
    }
  }

  // Screening questions: experience, CTC, notice, relocation, joining…
  const type = q.kind === 'combobox' || q.kind === 'yesno' ? (options.length ? 'select' : 'text') : q.kind;
  const s = answerFor(q.label || '', { type, options }, profile);
  if (s != null && s !== '') return { value: s, source: 'screening' };

  if (ESSAY_RE.test(label)) return { value: null, why: 'free-text answer only you can write (add it to custom_answers)' };
  return { value: null, why: 'not in profile' };
}

/**
 * Plan a whole form. Returns { fills: [{ q, value, source }], missing: [label], skipped: [label] }.
 * Optional questions without an answer are skipped (left blank), never guessed.
 */
function planForm(questions, profile, job) {
  const fills = [];
  const missing = [];
  const skipped = [];
  for (const q of questions) {
    const a = answerQuestion(q, profile, job);
    if (a.value != null && a.value !== '') fills.push({ q, value: a.value, source: a.source });
    else if (q.required) missing.push(`${String(q.label || q.kind).trim().slice(0, 120)} (${a.why})`);
    else skipped.push(q.label);
  }
  return { fills, missing, skipped };
}

module.exports = { answerQuestion, planForm, fitToOptions, nameParts, phoneFor };
