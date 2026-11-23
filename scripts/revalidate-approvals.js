#!/usr/bin/env node
/**
 * Revalidate the prepared applications in data/approvals.json. READ-ONLY with respect
 * to approvals: it never approves, declines, or submits anything. It writes an audit
 * report to reports/revalidation-YYYY-MM-DD.json and prints a summary.
 *
 *   node scripts/revalidate-approvals.js            offline: classify from the stored record
 *   node scripts/revalidate-approvals.js --live     also re-read ATS postings (network)
 *
 * Categories (core/auto-apply.classifyPrepared):
 *   READY_FOR_AUTO_APPLY | NEEDS_REVERIFICATION | NEEDS_USER_INPUT |
 *   EXPIRED_OR_INELIGIBLE | ALREADY_APPLIED
 *
 * Offline runs cannot prove a posting is still open, so nothing is READY without --live.
 */
const fs = require('fs');
const path = require('path');
const { readJsonState, writeJsonState } = require('../src/core/state-io');
const dedup = require('../src/core/dedup');
const { classifyPrepared, DIRECT_SUBMIT_PORTALS } = require('../src/core/auto-apply');
const { evaluateJob } = require('../src/core/evaluate');
const { parseAtsUrl, fetchPosting } = require('../src/core/ats');

const ROOT = path.join(__dirname, '..');
const APPROVALS = path.join(ROOT, 'data', 'approvals.json');
const LIVE = process.argv.includes('--live');
const today = dedup.istDate();
const OUT = path.join(ROOT, 'reports', `revalidation-${today}.json`);

async function liveCheck(entry) {
  const ref = parseAtsUrl(entry.url);
  if (!ref || !ref.ats) return { skipped: true, reason: 'no ATS reader for this URL; live check not performed' };
  const id = ref.jobId || ref.id;
  if (!id) return { skipped: true, reason: 'ATS URL has no posting id' };
  try {
    const rec = await fetchPosting({ ...ref, id: ref.ats === 'workday' ? ref.jobId : id, name: entry.company });
    const text = rec.text || '';
    const verdict = text.length >= 400
      ? evaluateJob({ title: rec.title || entry.title, description: text, source: 'full' })
      : { decision: 'needs_enrichment', evidence: 'card', reason: 'description too short to decide' };
    return { ok: true, closed: false, fullText: text, verdict, location: rec.location || entry.location, title: rec.title };
  } catch (err) {
    return { ok: false, closed: !!err.closed, reason: err.message };
  }
}

async function main() {
  const data = readJsonState(APPROVALS, { version: 1, jobs: {}, events: [] });
  const jobs = Object.values(data.jobs || {});
  const log = dedup.createLog();
  log.load();

  const results = [];
  for (const entry of jobs) {
    const prior = log.priorDisposition(entry.url, { company: entry.company, title: entry.title });
    const priorApplied = !!prior && prior.kind === 'already';
    const supportedPortal = DIRECT_SUBMIT_PORTALS.has(entry.portal);
    let live = null;
    if (LIVE && entry.status === 'pending' && !priorApplied && supportedPortal) {
      const r = await liveCheck(entry);
      if (!r.skipped) live = r;
    }
    const { category, reasons } = classifyPrepared(
      { ...entry, location: live?.location || entry.location },
      { priorApplied, live, supportedPortal: supportedPortal || !!entry.ats },
    );
    results.push({
      id: entry.id,
      status: entry.status,
      title: entry.title,
      company: entry.company,
      portal: entry.portal,
      url: entry.url,
      category,
      reasons,
      priorReason: priorApplied ? prior.reason : null,
      liveChecked: !!live,
    });
  }

  const counts = {};
  for (const r of results) counts[r.category] = (counts[r.category] || 0) + 1;
  const report = {
    generatedAt: new Date().toISOString(),
    mode: LIVE ? 'live (ATS postings re-read)' : 'offline (stored records only)',
    total: results.length,
    counts,
    note: 'Approval state was NOT changed. READY_FOR_AUTO_APPLY still requires a real run with JOBMAN_AUTO_APPLY=1.',
    results,
  };
  writeJsonState(OUT, report);

  console.log(`Revalidated ${results.length} prepared applications (${report.mode})`);
  for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k}: ${v}`);
  console.log(`Audit report: ${OUT}`);
}

main().catch((err) => {
  console.error(`revalidation failed: ${err.message}`);
  process.exit(1);
});
