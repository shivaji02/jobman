/**
 * Autonomous application gate (JOBMAN_AUTO_APPLY=1).
 *
 * The gate answers one question per job: may Jobman submit this application WITHOUT
 * an individual approval? Every condition is a blocker when it fails; a job is only
 * eligible when there are no blockers. Failing jobs stay for review (approval queue
 * or manual-actions) and nothing is invented to make a check pass.
 *
 * Pure functions: no network, no browser. The live checks (posting still open) come
 * from the caller: a description fetched during this run (not from cache).
 */
const fs = require('fs');
const { stackBalance } = require('./filter');
const { classifyLocation } = require('./location');

const AUTO_APPLY_ENV = 'JOBMAN_AUTO_APPLY';

/** Portals whose saved approval can be submitted without re-running discovery. */
const DIRECT_SUBMIT_PORTALS = new Set(['careers', 'google', 'foundit', 'linkedin', 'naukri', 'talent', 'wellfound', 'indeed']);

const OVERSEAS_ONLY = /\b(us|usa|united states|uk|united kingdom|eu|europe|canada|australia|us-based|uk-based)\s+only\b|outside (of )?india|must (be )?(located|based|reside) in (the )?(us|uk|eu|canada|europe|united states)/i;

function autoApplyEnabled(env = process.env) {
  return String(env[AUTO_APPLY_ENV] || '') === '1';
}

/**
 * The posting's location must name one of the user's cities (core/location.js
 * policy, widened from Hyderabad-only on 2026-11-23 at the user's request):
 * Hyderabad, Bangalore, Chennai and the other South India cities; Pune only for
 * GOOD_COMPANIES; Mumbai region never. Remote passes only when explicitly open to
 * India. A missing location is not confirmed.
 */
function isEligibleLocation(location = '', text = '', company = '') {
  const loc = String(location);
  if (/hyderabad|secunderabad/i.test(loc)) return { ok: true, basis: 'hyderabad' };
  const blob = `${loc} ${text}`;
  if (OVERSEAS_ONLY.test(blob)) return { ok: false, basis: 'overseas-only' };
  const c = classifyLocation(loc, company);
  if (c.allowed && c.city) return { ok: true, basis: c.city.toLowerCase() };
  if (/remote/i.test(loc) && /\bindia\b/i.test(blob)) return { ok: true, basis: 'india-remote' };
  return { ok: false, basis: c.allowed ? 'not verified' : c.reason };
}

/**
 * @param {object} job
 *   url, title, company, portal, location
 *   verdict            evaluateJob() result on the full description
 *   enrichment         { ok, cached } — ok && !cached means the posting was read live this run
 *   fullText           the full description used for the decision
 *   resume             selected resume path
 *   flags              prepare() flags (strings)
 *   priorApplied       true when a prior application to this job/requisition exists
 *   supportedPortal    true when a submit route exists for this portal
 * @returns {{ eligible: boolean, blockers: string[], checks: object }}
 */
function autoApplyGate(job = {}) {
  const blockers = [];
  const checks = {};

  checks.postingVerifiedActive = !!(job.enrichment?.ok && !job.enrichment?.cached);
  if (!checks.postingVerifiedActive) blockers.push('posting not verified active in this run (description not read live)');

  const v = job.verdict || {};
  checks.evidenceFull = v.evidence === 'full';
  if (!checks.evidenceFull) blockers.push('decision rests on listing-card evidence only');

  checks.technicalEligible = v.decision === 'eligible';
  if (!checks.technicalEligible) blockers.push(`not eligible on the full description (${v.decision || 'no decision'}: ${v.reason || ''})`.trim());

  const loc = isEligibleLocation(job.location, job.fullText, job.company);
  checks.locationEligible = loc.ok;
  if (!loc.ok) blockers.push(`location eligibility not confirmed (${loc.basis})`);

  const bal = stackBalance(job.fullText || '');
  checks.stackFit = bal.dominant !== 'other';
  if (!checks.stackFit) blockers.push(`description is mainly ${(bal.top || []).join(' / ')}, not the candidate's stack`);

  checks.resumeSelected = !!job.resume;
  checks.resumeExists = !!job.resume && fs.existsSync(job.resume);
  if (!checks.resumeSelected) blockers.push('no resume selected');
  else if (!checks.resumeExists) blockers.push(`selected resume is missing on disk: ${job.resume}`);

  checks.notPreviouslyApplied = !job.priorApplied;
  if (job.priorApplied) blockers.push('a previous application to this job or requisition exists');

  checks.submitRouteSupported = !!job.supportedPortal;
  if (!checks.submitRouteSupported) blockers.push(`no supported submit route for ${job.portal || 'this portal'}`);

  // Screening questions the profile cannot answer are handed to the user by the
  // adapter at submit time (outcome "manual-apply"); they are not invented here.
  checks.unknownAnswersDeferred = true; // adapter must hand off, never guess

  return { eligible: blockers.length === 0, blockers, checks };
}

/**
 * Classify one prepared approval entry (data/approvals.json) against live evidence.
 * @param {object} entry   approval record
 * @param {object} ctx
 *   priorApplied   boolean (CSV log or a submitted approval exists)
 *   live           { ok, closed?, reason?, fullText?, verdict? } or null when not checked
 *   supportedPortal boolean
 * @returns {{ category, reasons: string[] }}
 */
function classifyPrepared(entry, ctx = {}) {
  const C = {
    READY: 'READY_FOR_AUTO_APPLY',
    REVERIFY: 'NEEDS_REVERIFICATION',
    USER: 'NEEDS_USER_INPUT',
    EXPIRED: 'EXPIRED_OR_INELIGIBLE',
    APPLIED: 'ALREADY_APPLIED',
  };
  if (ctx.priorApplied) return { category: C.APPLIED, reasons: ['previous application exists in the log'] };
  if (ctx.live?.closed) return { category: C.EXPIRED, reasons: [`posting closed: ${ctx.live.reason || 'not found'}`] };
  if (ctx.live?.verdict?.decision === 'rejected') return { category: C.EXPIRED, reasons: [`ineligible on the live description: ${ctx.live.verdict.reason || ''}`] };
  if (!ctx.supportedPortal) return { category: C.USER, reasons: [`no direct submit route for ${entry.portal || 'this portal'}; apply from the URL or the portal bot`] };
  if (!ctx.live) return { category: C.REVERIFY, reasons: ['live posting check has not run'] };
  const gate = autoApplyGate({
    url: entry.url,
    portal: entry.portal,
    title: entry.title,
    company: entry.company,
    location: entry.location,
    verdict: ctx.live.verdict || { decision: 'eligible', evidence: 'full', reason: 'live check' },
    enrichment: { ok: !!ctx.live.ok, cached: false },
    fullText: ctx.live.fullText || '',
    resume: entry.resume,
    flags: entry.flags,
    priorApplied: false,
    supportedPortal: true,
  });
  if (gate.eligible) return { category: C.READY, reasons: ['live checks passed'] };
  const locationOnly = gate.blockers.every((b) => /location|stack/.test(b));
  return { category: locationOnly ? C.EXPIRED : C.REVERIFY, reasons: gate.blockers };
}

module.exports = { autoApplyEnabled, autoApplyGate, isEligibleLocation, classifyPrepared, DIRECT_SUBMIT_PORTALS, AUTO_APPLY_ENV };
