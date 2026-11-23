#!/usr/bin/env node
/**
 * Compare a real run against the 2026-11-09 baseline using the runs' own reports
 * (no simulation): wall-clock, per-portal time, funnel, eligible yield, and — for
 * runs made with the pipeline — stage overlap/throughput.
 *
 *   node scripts/bench-workflow.js [reports/2026-11-10-dry-run.md] [--baseline=data/run-state/baseline-2026-11-09.report.md]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const baselineFile = arg('baseline', path.join(ROOT, 'data', 'run-state', 'baseline-2026-11-09.report.md'));
const runFile = process.argv.slice(2).find((a) => !a.startsWith('--')) || latestReport();

function latestReport() {
  const dir = path.join(ROOT, 'reports');
  return path.join(dir, fs.readdirSync(dir).filter((f) => /^\d{4}-\d\d-\d\d(-dry-run)?\.md$/.test(f)).sort().pop());
}

const secs = (s) => {
  const m = String(s || '').match(/(\d+)m(\d+)s/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

function parse(file) {
  const md = fs.readFileSync(file, 'utf8');
  const out = { file: path.relative(ROOT, file), portals: {}, dispositions: {} };
  out.wall = secs((md.match(/Wall-clock (\d+m\d+s)/) || [])[1]);
  out.discoveryDone = secs((md.match(/discovery finished at (\d+m\d+s)/) || [])[1]);
  const funnel = md.match(/Discovered (\d+) → −(\d+) duplicate sightings → −(\d+) out of discovery scope → \*\*(\d+) unique listings reviewed\*\*/);
  if (funnel) Object.assign(out, { sightings: +funnel[1], duplicates: +funnel[2], outOfScope: +funnel[3], unique: +funnel[4] });
  for (const m of md.matchAll(/^\| ([A-Z][^|]+?) \| (\d+) \|$/gm)) out.dispositions[m[1].trim()] = +m[2];
  const sect = md.split('## Parallel run')[1] || '';
  for (const m of sect.matchAll(/^\| (\w+) \| (\w[\w ]*?) \| (\d+) \| (\d+m\d+s) \|/gm)) out.portals[m[1]] = { state: m[2], attempts: +m[3], sec: secs(m[4]) };
  for (const m of sect.matchAll(/^\| (enrich|evaluate|prepare|submit) \| (\d+) \| (\d+) \| (\d+) \| ([\d.]+)s \/ ([\d.]+)s \| ([\d.]+)s \/ ([\d.]+)s \| (\d+)% \|/gm)) {
    (out.stages = out.stages || {})[m[1]] = { jobs: +m[2], workers: +m[3], peak: +m[4], waitP50: +m[5], waitP95: +m[6], runP50: +m[7], runP95: +m[8], util: +m[9] };
  }
  const elig = sect.match(/\| Eligible \| (\d+) \|/);
  const sat = md.match(/skipped (\d+) saturated/);
  out.eligible = elig ? +elig[1] : (out.dispositions['Needs you (CAPTCHA, OTP, external ATS, missing info)'] || 0);
  const awaiting = sect.match(/\| Awaiting approval \| (\d+) \|/);
  out.awaiting = awaiting ? +awaiting[1] : 0;
  const insuff = sect.match(/\| Insufficient evidence \| (\d+) \|/);
  out.insufficient = insuff ? +insuff[1] : 0;
  const prof = md.match(/### foundit search profile\n\n(.*)/);
  out.founditProfile = prof ? prof[1] : '';
  return out;
}

const a = parse(baselineFile);
const b = parse(runFile);
const pad = (s, n) => String(s).padEnd(n);
const row = (k, x, y, note = '') => console.log(`${pad(k, 34)}${pad(x ?? '-', 14)}${pad(y ?? '-', 14)}${note}`);
const fmt = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : '-');

console.log(`baseline: ${a.file}\nrun:      ${b.file}\n`);
row('', 'baseline', 'this run');
row('wall-clock', fmt(a.wall), fmt(b.wall), Number.isFinite(a.wall) && Number.isFinite(b.wall) ? `${Math.round((1 - b.wall / a.wall) * 100)}% faster` : '');
row('discovery finished at', fmt(a.wall), fmt(b.discoveryDone));
row('raw sightings', a.sightings, b.sightings);
row('unique listings', a.unique, b.unique);
row('eligible (full check)', `${a.eligible}*`, b.eligible, '*baseline: gated "needs you" entries, card evidence only');
row('awaiting approval (queue)', 0, b.awaiting);
row('insufficient evidence', 0, b.insufficient, 'baseline counted these as rejections');
console.log('\nper portal (time · attempts):');
for (const p of new Set([...Object.keys(a.portals), ...Object.keys(b.portals)])) {
  const x = a.portals[p];
  const y = b.portals[p];
  row(`  ${p}`, x ? `${fmt(x.sec)} ×${x.attempts}` : '-', y ? `${fmt(y.sec)} ×${y.attempts}` : '-', y?.state && y.state !== 'done' ? y.state : '');
}
if (b.stages) {
  console.log('\npipeline stages (this run):');
  for (const [k, s] of Object.entries(b.stages)) {
    const rate = Number.isFinite(b.wall) && b.wall > 0 ? (s.jobs / (b.wall / 60)).toFixed(1) : '-';
    console.log(`  ${pad(k, 10)} jobs ${pad(s.jobs, 5)} workers ${s.workers} peak ${s.peak} · wait p50/p95 ${s.waitP50}/${s.waitP95}s · service p50/p95 ${s.runP50}/${s.runP95}s · ${rate} jobs/min · utilization ${s.util}%`);
  }
}
if (b.founditProfile) console.log(`\nfoundit: ${b.founditProfile}`);
