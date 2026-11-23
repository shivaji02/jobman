/**
 * Direct-employer pipeline shared by the `google` and `careers` channels.
 *
 * For one employer posting (already re-read from its ATS = verified open):
 *   dedup (canonical ATS URL + cross-portal company/title fingerprint)
 *   → freshness → location → experience (from the real JD) → role score
 *   → per-run cap → resume choice → ATS adapter (fill, submit once, proof)
 *   → CSV row appended immediately + a full record in data/direct_applications.jsonl
 *
 * Every posting ends in exactly one results bucket (see core/disposition).
 */
const fs = require('fs');
const path = require('path');
const { scoreJob, shouldApply, experienceFromText, TARGET_EXP } = require('./filter');
const { classifyLocation } = require('./location');
const { selectResume } = require('./resume');
const { admit, claimGate, offerIfUncertain } = require('./disposition');
const { normalizeJobUrl } = require('./dedup');
const { evidenceNote } = require('./evidence');
const { humanDelay, closePageQuietly } = require('./browser');
const { applyOnAts } = require('../ats');
const logger = require('./logger');

const RECORDS_FILE = path.join(__dirname, '..', '..', 'data', 'direct_applications.jsonl');
const MAX_AGE_DAYS = Number(process.env.JOBMAN_MAX_POSTING_AGE_DAYS) || 30;
const MAX_APPS_PER_RUN = Number(process.env.JOBMAN_MAX_APPS) || 30;

function isTransientApplicationUrl(value = '') {
  try {
    const u = new URL(value);
    return /(^|\.)indeed\.com$/.test(u.hostname) && /demographic-questions|indeedapply|api/i.test(u.pathname)
      || /(^|\.)naukri\.com$/.test(u.hostname) && /myapply|showAcp|applyworkflow/i.test(u.pathname)
      || /(^|\.)smartrecruiters\.com$/.test(u.hostname) && /oneclick-ui/i.test(u.pathname)
      || /(^|\.)talent\.com$/.test(u.hostname) && /\/redirect\b/i.test(u.pathname);
  } catch { return true; }
}

function primaryApplicationUrl(postingUrl, applicationUrl) {
  return applicationUrl && !isTransientApplicationUrl(applicationUrl) ? applicationUrl : postingUrl;
}

/** Keys handled by any direct channel in this process — google and careers never redo each other's jobs. */
const handledThisRun = new Set();

function postingAgeDays(postedAt, now = new Date()) {
  if (!postedAt) return null;
  const t = new Date(postedAt).getTime();
  return Number.isNaN(t) ? null : Math.floor((now - t) / 86_400_000);
}

/**
 * Pure screening of a posting. Returns '' when it qualifies, else the rejection reason.
 * Exported for tests.
 */
function screenPosting(p, { now = new Date(), maxAgeDays = MAX_AGE_DAYS } = {}) {
  // Order: role → location → experience → age, so each rejection names the most
  // basic mismatch (a stale React Native role in Hyderabad reads "stale", while a
  // stale sales role reads "score").
  const score = scoreJob({ title: p.title, description: p.text });
  if (!shouldApply(score)) return `score ${score} below threshold`;

  let loc = classifyLocation(p.location || '', p.company);
  if (loc.allowed && !loc.city) {
    // "India" / "Remote - India": accept only if the description names a southern city.
    const fromText = classifyLocation(`${p.location || ''} ${(p.text || '').slice(0, 2500)}`, p.company);
    if (fromText.city && fromText.allowed) loc = fromText;
  }
  if (!loc.allowed) return loc.reason;
  if (!loc.city) return `not in a south India city (${p.location || 'no location'})`;

  const exp = experienceFromText(p.text);
  if (exp && exp.min > TARGET_EXP.max) return `experience ${exp.min}+ yrs required in description`;
  if (exp && exp.max < TARGET_EXP.min) return `experience ${exp.min}-${exp.max} yrs below range`;

  const age = postingAgeDays(p.postedAt, now);
  if (age != null && age > maxAgeDays) return `stale: posted ${age} days ago (max ${maxAgeDays})`;
  return '';
}

function writeRecord(rec) {
  try {
    fs.mkdirSync(path.dirname(RECORDS_FILE), { recursive: true });
    fs.appendFileSync(RECORDS_FILE, `${JSON.stringify(rec)}\n`);
  } catch (err) {
    logger.warn(`[direct] could not write record: ${err.message}`);
  }
}

const CSV_STATUS = { applied: 'applied', unconfirmed: 'unconfirmed', 'manual-apply': 'manual-apply', failed: 'failed' };

/**
 * Process one verified-open posting.
 * ctx: { results, seen, dedup, dryRun, profile, newPage, site, source }
 *   source: where the posting was discovered, e.g. 'google: site:jobs.lever.co "React Native" India'
 */
async function processPosting(p, ctx) {
  const { results, seen, dedup, dryRun, profile, newPage, site, approvedJobs = [] } = ctx;
  const key = normalizeJobUrl(p.url);
  const entry = { title: p.title, company: p.company, url: p.url, applyUrl: p.applyUrl, ats: p.ats, source: ctx.source || site, location: p.location };

  if (handledThisRun.has(key) && !seen.has(key)) {
    results.duplicates++;
    seen.add(key);
    return 'duplicate';
  }
  const gate = admit(results, { key, seen, dedup, job: entry, site, dryRun });
  if (gate !== 'new') return gate;
  handledThisRun.add(key);

  const reject = screenPosting(p);
  // The posting's description could not be read (ATS fetch failed): a low score is missing
  // information, not a mismatch — let the pipeline retry the description.
  if (reject && /below threshold/.test(reject) && ctx.pipeline && String(p.text || '').length < 400 && offerIfUncertain(ctx.pipeline, ctx.portal || site, entry, { title: p.title, text: p.text }, site)) return 'offered';
  if (reject) {
    entry.reason = reject;
    results.skipped.push(entry);
    if (typeof dedup.record === 'function') dedup.record(key, 'REJECTED', reject, entry);
    return 'rejected';
  }

  // The cap limits submissions (rate-limit protection); hand-offs submit nothing.
  const attempts = results.applied.length + results.unconfirmed.length + results.failed.length;
  if (attempts >= MAX_APPS_PER_RUN) {
    entry.reason = 'per-run cap reached';
    results.skipped.push(entry);
    return 'deferred';
  }
  // Parallel runs: atomically claim across workers + wait for an application slot.
  if (!(await claimGate(results, dedup, key, entry, { dryRun, approvedJobs, pipeline: ctx.pipeline, portal: ctx.portal || site, offer: { description: p.text, location: p.location, site } }))) return 'approval-or-dedup';

  entry.resume = selectResume(p.title, p.text);
  // Keep the employer posting as the manual hand-off. Transient API/form state
  // URLs are useful diagnostics but are not stable links for a person.
  entry.companyUrl = primaryApplicationUrl(p.url, p.applyUrl);
  const job = { ...p, resume: entry.resume };

  let outcome;
  let page;
  const visitedFormUrls = new Set();
  for (let attempt = 1; attempt <= 2; attempt++) {
    page = await newPage();
    if (typeof page.on === 'function') {
      page.on('framenavigated', (frame) => {
        try {
          if (frame === page.mainFrame()) visitedFormUrls.add(frame.url());
        } catch { /* a page may close while navigation is being recorded */ }
      });
    }
    try {
      outcome = await applyOnAts(page, job, { profile, dryRun });
      if (typeof page.url === 'function' && page.url() && page.url() !== p.url) visitedFormUrls.add(page.url());
    } catch (err) {
      outcome = { status: 'failed', submitted: false, reason: err.message };
    }
    // Retry once — only when nothing could have been submitted.
    if (outcome.status === 'failed' && !outcome.submitted && attempt === 1) {
      await closePageQuietly(page);
      await humanDelay(2000, 3000);
      continue;
    }
    break;
  }
  if (!(outcome.keepOpen && !dryRun)) await closePageQuietly(page);

  const at = new Date().toISOString();
  entry.reason = outcome.reason || '';
  if (outcome.evidence) entry.evidence = outcome.evidence;

  switch (outcome.status) {
    case 'applied':
    case 'would-apply':
      results.applied.push(entry);
      break;
    case 'unconfirmed':
      results.unconfirmed.push(entry);
      break;
    case 'manual-apply':
      results.manualApply.push(entry);
      break;
    case 'closed':
      entry.reason = `posting closed on the employer site (${outcome.reason})`;
      results.skipped.push(entry);
      break;
    default:
      results.failed.push(entry);
  }

  const csvStatus = CSV_STATUS[outcome.status];
  if (!dryRun && csvStatus) {
    dedup.append({
      site,
      job_title: p.title,
      company: p.company,
      job_url: key,
      status: csvStatus,
      notes: [
        outcome.evidence ? evidenceNote(outcome.evidence) : entry.reason,
        `ats: ${p.ats}`,
        `source: ${entry.source}`,
        `resume: ${path.basename(entry.resume || '')}`,
        p.location,
      ].filter(Boolean).join(' | '),
    });
  }
  if (!dryRun) {
    writeRecord({
      at,
      channel: site,
      company: p.company,
      title: p.title,
      location: p.location,
      discovered_via: entry.source,
      application_url: primaryApplicationUrl(p.url, p.applyUrl),
      original_posting_url: p.url,
      final_application_url: primaryApplicationUrl(p.url, p.applyUrl),
      intermediate_form_urls: [...visitedFormUrls].filter((url) => url !== p.url),
      job_url: key,
      ats: p.ats,
      resume: entry.resume,
      posted_at: p.postedAt || '',
      disposition: outcome.status,
      reason: entry.reason,
      evidence: outcome.evidence || null,
      plan: outcome.plan || null,
    });
  }
  logger.info(`[${site.toLowerCase()}] ${dryRun ? 'DRY RUN ' : ''}${outcome.status}: ${p.title} @ ${p.company} (${p.ats}) ${entry.reason ? `— ${entry.reason.slice(0, 160)}` : ''}`);
  if (['applied', 'unconfirmed', 'manual-apply', 'would-apply'].includes(outcome.status)) await humanDelay(2000, 3000);
  return outcome.status;
}

/**
 * True when a job is already placed (applied, unconfirmed, or handed off in an
 * earlier run). Bots call this BEFORE fetching a posting's full description, so
 * placed jobs cost nothing on later runs. Rejected jobs are not affected.
 */
function alreadyPlaced(dedup, url, job = {}) {
  if (typeof dedup?.priorDisposition !== 'function') return false;
  const prior = dedup.priorDisposition(normalizeJobUrl(url), { company: job.company, title: job.title });
  return prior?.kind === 'already';
}

module.exports = { processPosting, screenPosting, alreadyPlaced, postingAgeDays, handledThisRun, RECORDS_FILE, MAX_AGE_DAYS, isTransientApplicationUrl, primaryApplicationUrl };
