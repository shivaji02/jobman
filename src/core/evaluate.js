/**
 * Evidence-aware eligibility. Pure functions — tests/evaluate.test.js.
 *
 * filter.scoreJob answers "how well does this text match?". It cannot tell a
 * confirmed mismatch from missing information: on 2026-11-09, 1,777 listings were
 * rejected for "score N below threshold", yet 7 of 9 boards had only scored the
 * listing card (title + a ~200-char snippet). A "Mobile Application Developer" card
 * that never names a framework scores 10 — not because the job is React Native-free,
 * but because the card does not say.
 *
 * evaluateJob() returns one of three decisions and records what it rests on:
 *
 *   eligible          passes every rule on the evidence given
 *   rejected          a definitive rule fired (title seniority, .NET, stated experience,
 *                     closed/stale), OR the full description was read and does not match
 *   needs_enrichment  evidence is card-only, the title belongs to our role family, and the
 *                     job only failed for lack of stack/experience detail → fetch the full
 *                     description, then evaluate again
 *
 * Hard rules are unchanged; only *uncertain* rejections are re-routed. A card-level
 * "eligible" is still provisional: the pipeline enriches it before preparing an
 * application, so a "Full Stack" card that is really Ruby on Rails is caught.
 */
const { scoreJob, hardReject, shouldApply, parseExperienceRange, experienceFromText, TARGET_EXP, DEFAULT_THRESHOLD } = require('./filter');

/** Bump when rules change: cached decisions from older rule versions are re-evaluated. */
const RULES_VERSION = 3;

/**
 * Titles in our role family. Only these are worth a description fetch when the card is
 * inconclusive; "Recruitment Specialist" with no stack words is a confirmed mismatch.
 */
const ROLE_FAMILY = /react|front[- ]?end|mobile|full[- ]?stack|\bnode\b|node\.?js|javascript|typescript|\bjs\b|\bexpo\b|\bmern\b|\bmean\b|web\s+(developer|engineer|application)|\bui\s+(developer|engineer)|\bapp(lication)?\s+(developer|engineer)|hybrid|cross[- ]platform|software\s+(development\s+)?(engineer|developer)|\bsde\b|\bswe\b|product\s+engineer|founding\s+engineer|programmer/i;

/** Descriptions shorter than this are treated as card snippets, whatever the caller says. */
const MIN_FULL_DESCRIPTION = 400;

function isRoleFamily(title) {
  return ROLE_FAMILY.test(String(title || ''));
}

/**
 * @param {object} job
 *   title, description, experienceText, skills
 *   source            'card' | 'full'  — what `description` is
 *   postedDaysAgo     optional freshness
 * @param {object} [opts]  { threshold, maxAgeDays }
 * @returns {{ decision, score, reason, evidence: 'card'|'full', category, rule? }}
 */
function evaluateJob(job = {}, { threshold = DEFAULT_THRESHOLD, maxAgeDays = 30 } = {}) {
  const { title = '', description = '', experienceText = '', skills = [] } = job;
  const evidence = job.source === 'full' && String(description).length >= MIN_FULL_DESCRIPTION ? 'full' : 'card';
  const tag = evidence === 'full' ? ' (full description)' : ' (listing card)';
  const out = (decision, category, reason, extra = {}) => ({ decision, category, reason, evidence, score: extra.score ?? null, ...extra });

  if (Number.isFinite(job.postedDaysAgo) && job.postedDaysAgo > maxAgeDays) {
    return out('rejected', 'stale', `stale: posted ${job.postedDaysAgo} days ago (max ${maxAgeDays})`);
  }

  const hard = hardReject({ title, description, experienceText, skills });
  if (hard) {
    // Absence-based rules on a card are missing information, not a mismatch.
    if (hard.basis === 'absence' && evidence === 'card' && isRoleFamily(title)) {
      return out('needs_enrichment', 'role', `card inconclusive: ${hard.reason} — need the full description`, { score: -100, rule: hard.code });
    }
    const category = hard.code === 'experience' ? 'experience' : 'role';
    const reason = hard.code === 'experience' ? `experience out of range — ${hard.reason}${experienceText ? ` (${experienceText})` : ''}` : `score -100 below threshold — ${hard.reason}${tag}`;
    return out('rejected', category, reason, { score: -100, rule: hard.code });
  }

  // Experience: the card's structured range first, then what the description states.
  const range = parseExperienceRange(experienceText) || (evidence === 'full' ? experienceFromText(description) : null);
  if (range && (range.min > TARGET_EXP.max || range.max < TARGET_EXP.min)) {
    const shown = range.max === Infinity ? `${range.min}+` : `${range.min}-${range.max}`;
    return out('rejected', 'experience', `experience ${shown} yrs out of range${tag}`, { score: null, rule: 'experience' });
  }

  const score = scoreJob({ title, description, experienceText: experienceText || (range ? `${range.min}-${range.max === Infinity ? 99 : range.max} yrs` : ''), skills });
  if (shouldApply(score, threshold)) return out('eligible', 'eligible', `score ${score}${tag}`, { score });
  if (evidence === 'card' && isRoleFamily(title)) {
    return out('needs_enrichment', 'role', `card inconclusive: score ${score} on listing card — need the full description`, { score });
  }
  return out('rejected', 'role', `score ${score} below threshold${tag}`, { score });
}

/**
 * Final decision when enrichment was attempted but the description could not be read.
 * A card-eligible job stays eligible (the user sees "card evidence only" when approving);
 * an inconclusive card becomes `needs_enrichment` — never a silent rejection.
 */
function unresolved(cardVerdict, whyNot) {
  if (cardVerdict.decision === 'eligible') return { ...cardVerdict, reason: `${cardVerdict.reason}; full description unavailable (${whyNot})` };
  return {
    ...cardVerdict,
    decision: 'needs_enrichment',
    reason: `insufficient evidence — full description unavailable (${whyNot}); ${cardVerdict.reason.replace(/^card inconclusive: /, '')}`,
  };
}

/** Short evidence snippets for the approval queue: lines that mention our stack or experience. */
function evidenceSnippets(text, max = 3) {
  const lines = String(text || '')
    .split(/\n|(?<=[.;•])\s+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 15 && l.length < 260);
  const hits = lines.filter((l) => /react\s*native|react|node|typescript|javascript|expo|mobile|years?|yrs/i.test(l));
  return hits.slice(0, max);
}

module.exports = { evaluateJob, unresolved, isRoleFamily, evidenceSnippets, RULES_VERSION, ROLE_FAMILY, MIN_FULL_DESCRIPTION };
