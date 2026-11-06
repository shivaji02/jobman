#!/usr/bin/env node
/**
 * Re-check every `unconfirmed` row in data/applied_jobs_log.csv against the
 * portal itself (no clicking): if the job page shows an Applied state the row is
 * confirmed with evidence; if it still offers Apply, it is marked
 * "verified not applied" (eligible for a bounded retry); otherwise it stays
 * unconfirmed. Supported: Naukri. Other portals are listed for manual review.
 *
 *   node scripts/verify-unconfirmed.js [--dry-run]
 */
require('dotenv').config();
const dedup = require('../src/core/dedup');
const browserCore = require('../src/core/browser');
const { capture, evidenceNote } = require('../src/core/evidence');
const { verifyNaukriJobState } = require('../src/bots/naukri');
const fs = require('fs');

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  dedup.load();
  const rows = fs.readFileSync(dedup.createLog().filePath, 'utf8').split('\n');
  const header = rows.shift().split(',');
  const latest = new Map();
  for (const line of rows.filter(Boolean)) {
    const url = (line.match(/https?:\/\/[^,"]+/) || [])[0];
    if (url) latest.set(dedup.normalizeJobUrl(url), line);
  }
  const pending = [...latest.entries()].filter(([url]) => dedup.lastStatus(url)?.status === 'unconfirmed');
  console.log(`${pending.length} unconfirmed job(s) in the log`);
  if (!pending.length) return;

  const { browser } = await browserCore.launch();
  const page = await browser.newPage();
  try {
    for (const [url, line] of pending) {
      const site = line.split(',')[1];
      if (!/naukri\.com/.test(url)) {
        console.log(`  [${site}] ${url} — check manually on the portal`);
        continue;
      }
      const v = await verifyNaukriJobState(page, url);
      const fields = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((f) => f.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
      const base = { site, job_title: fields[header.indexOf('job_title')], company: fields[header.indexOf('company')], job_url: url };
      if (v.state === 'applied') {
        const ev = await capture(page, { portal: 'naukri', jobKey: url, signal: `post-run verification: ${v.signal}` });
        console.log(`  ✅ applied  ${base.job_title} @ ${base.company}`);
        if (!dryRun) dedup.append({ ...base, status: 'applied', notes: `verified after run | ${evidenceNote(ev)}` });
      } else if (v.state === 'not-applied') {
        console.log(`  ↺ not applied (Apply still offered) ${base.job_title} @ ${base.company}`);
        if (!dryRun) dedup.append({ ...base, status: 'failed', notes: 'verified not applied — Apply still offered on job page' });
      } else {
        console.log(`  ? still unknown ${base.job_title} @ ${base.company}`);
      }
    }
  } finally {
    await page.close().catch(() => {});
    if (browser.__jobmanAttached) browser.disconnect();
    else await browser.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
