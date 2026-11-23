/**
 * Google discovery → direct employer applications.
 *
 * 1. Run targeted searches (ATS site: queries + open-web careers queries) with a
 *    date filter (last month by default; JOBMAN_GOOGLE_RECENCY=d|w|m).
 * 2. Resolve each result to the employer's own ATS: direct ATS links, legitimate
 *    redirects, or an ATS embedded in a custom careers page. Aggregators and
 *    reposting boards are dropped (the portal bots cover them).
 * 3. Re-read every posting from the ATS API — the "still open?" check — and
 *    take the real job description from there, never from the search snippet.
 * 4. Hand each posting to core/direct (filters, dedup, resume, ATS adapter).
 * 5. New employer boards go into the company directory (data/companies.json)
 *    so the careers channel reads them every run.
 *
 * Google is used through the jobman Chrome profile at a human pace (or an API
 * when SERPER_API_KEY / GOOGLE_CSE_KEY+GOOGLE_CSE_ID are set). A CAPTCHA stops
 * searching for the run — it is never solved.
 */
const { createSearch, SearchBlockedError } = require('../core/websearch');
const { DEFAULT_QUERIES, classifyResult, resolvePage } = require('../core/discovery');
const { fetchPosting } = require('../core/ats');
const { createVerificationQueue, classifyVerificationError } = require('../core/verification-queue');
const directory = require('../core/companies');
const { processPosting, screenPosting, alreadyPlaced } = require('../core/direct');
const { emptyResults, admit } = require('../core/disposition');
const { normalizeJobUrl } = require('../core/dedup');
const logger = require('../core/logger');

const fs = require('fs');
const path = require('path');

const SITE = 'Google';
// 13 back-to-back queries tripped Google's unusual-traffic page on 2026-11-05.
// Each run now takes the next 7 queries in rotation (all 14 every two days).
const MAX_QUERIES = Number(process.env.JOBMAN_GOOGLE_MAX_QUERIES) || 7;
const LEADS_FILE = path.join(__dirname, '..', '..', 'data', 'google_leads.json');
const LEAD_TTL_DAYS = 14;

/**
 * Search results are kept as leads for LEAD_TTL_DAYS: a run where Google is
 * blocked (or finds nothing new) still works through recent leads. Every lead is
 * re-verified against the employer ATS before use, so stale leads cost nothing.
 */
function loadLeads(file = LEADS_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { cursor: 0, leads: [] };
  }
}

function saveLeads(state, file = LEADS_FILE) {
  const cutoff = Date.now() - LEAD_TTL_DAYS * 86_400_000;
  state.leads = state.leads.filter((l) => new Date(l.lastSeen).getTime() >= cutoff);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 1));
}

function mergeLeads(state, results, now = new Date().toISOString()) {
  const byUrl = new Map(state.leads.map((l) => [l.url, l]));
  for (const r of results) {
    const prev = byUrl.get(r.url);
    if (prev) prev.lastSeen = now;
    else byUrl.set(r.url, { url: r.url, title: r.title, snippet: r.snippet || '', query: r.query, firstSeen: now, lastSeen: now });
  }
  state.leads = [...byUrl.values()];
  return state;
}

/** The next `n` queries in rotation. */
function nextQueries(state, n = MAX_QUERIES, all = DEFAULT_QUERIES) {
  const start = (state.cursor || 0) % all.length;
  const out = [];
  for (let i = 0; i < Math.min(n, all.length); i++) out.push(all[(start + i) % all.length]);
  return out;
}
const RECENCY = process.env.JOBMAN_GOOGLE_RECENCY || 'm';
const MAX_PAGES_RESOLVED = 15;

/** Company name: directory > ATS API > search title; Workday legal entities are cleaned. */
function companyName(ref, posting, hintName) {
  const known = directory.get(ref);
  if (known && known.name && known.name !== known.token && !looksLikeRole(known.name)) return known.name;
  if (ref.ats === 'workday') return ref.token.charAt(0).toUpperCase() + ref.token.slice(1);
  const api = String(posting.company || '').replace(/^careers at\s+/i, '').replace(/\s+(india )?job board$/i, '').trim();
  if (api && api.toLowerCase() !== String(ref.token).toLowerCase()) return api;
  const hint = String(hintName || '').trim();
  if (hint && !looksLikeRole(hint)) return hint;
  return api || ref.token;
}

/** "Software Engineer I (Remote Eligible)" is a role, not a company. */
const looksLikeRole = (s) => /\b(engineer|developer|sde|intern|manager|analyst|designer|architect|lead|specialist)\b/i.test(String(s || ''));

/** Company from a search title once we know the role title: "Merge Money Ltd." from "Role @ Merge Money Ltd.". */
function companyFromTitle(resultTitle, roleTitle) {
  let t = String(resultTitle || '').replace(/^job application for\s+/i, '');
  if (roleTitle) t = t.replace(roleTitle, ' ');
  t = t.replace(/\bcareers?\b/gi, ' ').replace(/^\s*(at|@|-|–|\|)\s*|\s*(at|@|-|–|\|)\s*$/gi, ' ').replace(/\s+/g, ' ').trim();
  return t.split(/\s+[-–|@]\s+|\s+at\s+/)[0].trim();
}

async function run({ dedup, dryRun, profile, newPage, approvedJobs = [], pipeline = null, portal = 'google' }) {
  const results = emptyResults();
  results.discovery = { provider: '', queries: 0, results: 0, postings: 0, closed: 0, boardsAdded: 0, pages: 0, aggregators: 0, irrelevant: 0, blocked: '' };
  const seen = new Set();
  const seenResultUrls = new Set();
  const search = createSearch({ newPage });
  results.discovery.provider = search.name;

  // ---- 1. search -----------------------------------------------------------
  const leadState = loadLeads();
  const fresh = [];
  for (const q of nextQueries(leadState)) {
    try {
      const rs = await search.search(q, { recency: RECENCY });
      results.discovery.queries++;
      leadState.cursor = (leadState.cursor || 0) + 1;
      for (const r of rs) fresh.push(r);
      logger.debug(`[google] ${q} → ${rs.length}`);
    } catch (err) {
      if (err instanceof SearchBlockedError) {
        results.discovery.blocked = err.message;
        logger.warn(`[google] ${err.message}`);
        break;
      }
      logger.warn(`[google] search failed (${q}): ${err.message}`);
    }
  }
  await search.close();
  mergeLeads(leadState, fresh);
  saveLeads(leadState);
  // This run's results first, then earlier leads not re-found today.
  const freshUrls = new Set(fresh.map((r) => r.url));
  const hits = [...fresh, ...leadState.leads.filter((l) => !freshUrls.has(l.url))];
  results.discovery.results = fresh.length;
  results.discovery.leadsReused = hits.length - fresh.length;
  logger.info(`[google] ${results.discovery.queries} searches → ${fresh.length} results (${search.name}); ${results.discovery.leadsReused} saved leads re-checked`);

  // ---- 2. resolve results to employer postings -------------------------------
  const refs = []; // { ref, hint, source }
  let pagesResolved = 0;
  for (const r of hits) {
    results.discovered++;
    const resultKey = normalizeJobUrl(r.url);
    if (seenResultUrls.has(resultKey)) {
      results.duplicates++;
      continue;
    }
    seenResultUrls.add(resultKey);
    const c = classifyResult(r);
    const source = `google: ${r.query}`;
    if (c.kind === 'posting') {
      refs.push({ ref: c.ref, hint: r.title, source, leadUrl: r.url });
      directory.upsert(c.ref, { source: 'google', persist: false });
    } else if (c.kind === 'board') {
      const { isNew } = directory.upsert(c.ref, { source: 'google', name: c.name, persist: false });
      if (isNew) results.discovery.boardsAdded++;
      results.outOfScope++;
    } else if (c.kind === 'page' && pagesResolved < MAX_PAGES_RESOLVED) {
      pagesResolved++;
      results.discovery.pages++;
      try {
        const res = await resolvePage(r.url);
        const withJob = res.refs.filter((x) => x.jobId);
        for (const x of res.refs) {
          const { isNew } = directory.upsert(x, { source: 'google (careers page)', careersUrl: r.url, persist: false });
          if (isNew && !x.jobId) results.discovery.boardsAdded++;
        }
        if (withJob.length === 1) {
          refs.push({ ref: { ...withJob[0], id: withJob[0].jobId }, hint: r.title, source: `${source} → ${r.url}` });
        } else if (res.postings.length === 1) {
          // Employer page with a schema.org JobPosting but no supported ATS form.
          const jp = res.postings[0];
          const posting = { ...jp, company: jp.company || companyFromTitle(r.title, jp.title), url: res.finalUrl, applyUrl: res.finalUrl, ats: 'custom' };
          const entry = { title: posting.title, company: posting.company, url: posting.url, ats: 'custom', source };
          if (admit(results, { key: normalizeJobUrl(posting.url), seen, dedup, job: entry, site: SITE, dryRun }) === 'new') {
            const reject = jp.validThrough && new Date(jp.validThrough) < new Date() ? 'posting closed: validThrough passed' : screenPosting(posting);
            if (reject) {
              entry.reason = reject;
              results.skipped.push(entry);
            } else {
              entry.companyUrl = posting.url;
              entry.reason = 'employer career page without a supported ATS form — apply on the page';
              results.manualApply.push(entry);
              if (!dryRun) dedup.append({ site: SITE, job_title: entry.title, company: entry.company, job_url: posting.url, status: 'manual-apply', notes: `${entry.reason} | source: ${source}` });
            }
          }
        } else {
          results.outOfScope++;
        }
      } catch (err) {
        logger.debug(`[google] could not resolve ${r.url}: ${err.message}`);
        results.outOfScope++;
      }
    } else {
      if (c.kind === 'aggregator') results.discovery.aggregators++;
      else results.discovery.irrelevant++;
      results.outOfScope++;
    }
  }
  directory.save();

  // ---- 3. verify open + 4. apply ---------------------------------------------
  // Every lead — fresh or saved — is re-read from the employer's live ATS here.
  // Nothing from the search snippet or the cache is ever treated as "open".
  const closedLeads = new Set();
  for (const { ref, hint, source, leadUrl } of refs) {
    // Already applied / handed off in an earlier run: skip the live fetch entirely.
    if (alreadyPlaced(dedup, urlOf(ref), { title: hint, company: ref.token })) {
      admit(results, { key: normalizeJobUrl(urlOf(ref)), seen, dedup, job: { title: hint || '', company: ref.token, url: urlOf(ref), ats: ref.ats, source }, site: SITE, dryRun });
      continue;
    }
    // Title gate BEFORE the live ATS read: 52 of one run's "failed" rows were UX designer /
    // data scientist / intern / manager leads that only failed on Workday rate limits
    // (2026-11-23). An off-target title is out of scope — no fetch, no failure row.
    if (offTargetTitle(hint)) {
      results.discovery.irrelevant++;
      results.outOfScope++;
      continue;
    }
    let posting;
    try {
      posting = await fetchPosting({ ...ref, name: directory.get(ref)?.name });
      const lead = leadState.leads.find((l) => l.url === leadUrl);
      if (lead) lead.lastVerifiedOpen = new Date().toISOString();
    } catch (err) {
      if (err.closed && leadUrl) closedLeads.add(leadUrl);
      if (!err.closed && !dryRun && !process.env.NODE_TEST_CONTEXT) {
        try {
          const failure = classifyVerificationError(err);
          createVerificationQueue().enqueue({
            company: directory.get(ref)?.name || ref.token, title: hint || '',
            url: urlOf(ref), requisitionId: ref.jobId || ref.id || '',
            source: 'google',
          }, failure);
        } catch (queueError) {
          logger.warn(`[google] verification queue unavailable: ${queueError.message}`);
        }
      }
      const entry = { title: hint || '(closed posting)', company: ref.token, url: urlOf(ref), ats: ref.ats, source };
      if (admit(results, { key: normalizeJobUrl(urlOf(ref)), seen, dedup, job: entry, site: SITE, dryRun }) === 'new') {
        results.discovery.closed++;
        entry.reason = err.closed ? 'posting closed: no longer listed by the employer ATS' : `could not verify posting (${err.message.slice(0, 80)})`;
        (err.closed ? results.skipped : results.failed).push(entry);
      }
      continue;
    }
    results.discovery.postings++;
    posting.company = companyName(ref, posting, companyFromTitle(hint, posting.title));
    directory.upsert(ref, { source: 'google', name: posting.company, persist: false });
    await processPosting(posting, { results, seen, dedup, dryRun, profile, newPage, site: SITE, source, approvedJobs, pipeline, portal });
  }
  directory.save();
  // A posting the ATS no longer lists does not come back: drop those leads.
  if (closedLeads.size) {
    leadState.leads = leadState.leads.filter((l) => !closedLeads.has(l.url));
    results.discovery.leadsDropped = closedLeads.size;
  }
  saveLeads(leadState);
  return results;
}

/** A search-result title that can never fit: outside the role family, or a title-level hard reject. */
function offTargetTitle(hint) {
  const title = String(hint || '').replace(/\s+[-–|]\s+(my)?workday.*$/i, '').trim();
  if (!title || title.startsWith('(')) return false; // no title yet — let the live read decide
  if (!require('../core/evaluate').isRoleFamily(title)) return true;
  const hr = require('../core/filter').hardReject({ title });
  return !!(hr && hr.basis === 'title');
}

function urlOf(ref) {
  switch (ref.ats) {
    case 'greenhouse':
      return `https://job-boards.greenhouse.io/${ref.token}/jobs/${ref.id}`;
    case 'lever':
      return `https://jobs.lever.co/${ref.token}/${ref.id}`;
    case 'ashby':
      return `https://jobs.ashbyhq.com/${ref.token}/${ref.id}`;
    case 'smartrecruiters':
      return `https://jobs.smartrecruiters.com/${ref.token}/${ref.id}`;
    case 'workday':
      return `https://${ref.host}/${ref.site}${ref.id}`;
    default:
      return '';
  }
}

module.exports = {
  offTargetTitle, run, companyFromTitle, companyName, looksLikeRole, urlOf, mergeLeads, nextQueries, loadLeads, saveLeads };
