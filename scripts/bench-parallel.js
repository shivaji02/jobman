#!/usr/bin/env node
/**
 * Scheduler benchmark on a simulated workload — no browser, no network, no
 * submissions. Portal durations, eligible-job counts and syndication overlap are
 * taken from the measured 2026-11-07 run (logs/2026-11-06.log, reports/2026-11-07.md),
 * time-scaled by --scale (default 1/20) so a run takes seconds.
 *
 * Compares, on identical simulated bots:
 *   sequential   one portal at a time (JOBMAN_CONCURRENCY=1 behaviour)
 *   pool-4       the previous runner.runAll scheduler (4 portal slots, google+careers
 *                as one item, shared CSV log, no in-flight claims)
 *   parallel     src/parallel.js (8 discovery / 3 application workers, job store claims)
 *
 * Reports wall-clock (scaled back to real seconds), time to first application,
 * submissions, and duplicate submissions of the same role.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLog } = require('../src/core/dedup');
const { runParallel } = require('../src/parallel');
const { createSampler } = require('../src/core/resources');
const { createFakeBot, fakeBrowser, healthySampler } = require('../tests/helpers/fakeBot');

const scale = Number((process.argv.find((a) => a.startsWith('--scale=')) || '').split('=')[1]) || 1 / 20;
const reps = Number((process.argv.find((a) => a.startsWith('--reps=')) || '').split('=')[1]) || 3;

// Measured on 2026-11-07 (seconds of wall-clock inside each portal; eligible = confirmed + needs-you).
const PORTALS = [
  { name: 'google', sec: 72, pages: 7, eligible: 0 },
  { name: 'careers', sec: 31, pages: 4, eligible: 0 },
  { name: 'instahyre', sec: 13, pages: 1, eligible: 3 },
  { name: 'naukri', sec: 69, pages: 12, eligible: 3, syndicated: 3 },
  { name: 'linkedin', sec: 279, pages: 16, eligible: 2 },
  { name: 'indeed', sec: 221, pages: 12, eligible: 9 },
  { name: 'foundit', sec: 299, pages: 24, eligible: 3, syndicated: 3 },
  { name: 'wellfound', sec: 49, pages: 4, eligible: 0 },
  { name: 'talent', sec: 41, pages: 8, eligible: 1, syndicated: 3 },
  { name: 'yourstory', sec: 1, pages: 1, eligible: 0 },
];
const APPLY_SEC = 6; // typical confirmed apply (instahyre ~5 s, naukri ~8 s in the logs)
const GAP_SEC = 2.5; // humanDelay between applications

function makeBots(ledger) {
  const bots = {};
  for (const p of PORTALS) {
    const applySec = p.eligible * (APPLY_SEC + GAP_SEC);
    const pageMs = Math.max(1, ((p.sec - applySec) * 1000 * scale) / p.pages);
    const pages = Array.from({ length: p.pages }, (_, i) =>
      Array.from({ length: 6 }, (_, k) => ({ url: `https://${p.name}.example/${i}-${k}`, title: `Role ${p.name} ${i}-${k}`, company: `${p.name}-co`, eligible: false }))
    );
    // eligible jobs spread over the pages; the first `syndicated` are the same role on naukri/foundit/talent
    for (let e = 0; e < p.eligible; e++) {
      const page = pages[Math.floor(((e + 0.5) * p.pages) / Math.max(1, p.eligible))];
      const shared = e < (p.syndicated || 0);
      page.push({ url: `https://${p.name}.example/job-${e}`, title: shared ? `React Native Developer ${e}` : `RN ${p.name} ${e}`, company: shared ? `Syndicated Co ${e}` : `${p.name} employer ${e}`, eligible: true });
    }
    bots[p.name] = createFakeBot({ site: p.name, pages, pageMs, applyMs: APPLY_SEC * 1000 * scale, gapMs: GAP_SEC * 1000 * scale, ledger });
  }
  return bots;
}

/** The previous scheduler, verbatim in behaviour: runner.runAll's worker pool. */
async function runPool(bots, log, concurrency) {
  const order = Object.keys(bots);
  const direct = ['google', 'careers'].filter((p) => order.includes(p));
  const queue = [...(direct.length ? [direct] : []), ...order.filter((p) => !direct.includes(p))];
  log.load();
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      for (const name of [].concat(item)) {
        try {
          await bots[name].run({ profile: {}, dedup: log, dryRun: false });
        } catch {
          // runPortal swallows crashes
        }
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function once(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobman-bench-'));
  const log = createLog(path.join(dir, 'log.csv'));
  const ledger = [];
  const bots = makeBots(ledger);
  const t0 = Date.now();
  const sampler = createSampler({ profileDir: '' });
  const samples = [];
  const sample = async () => { try { samples.push(await sampler.sample()); } catch { /* resource sample is optional */ } };
  await sample();
  const sampleTimer = setInterval(sample, 1000);
  if (mode === 'sequential') await runPool(bots, log, 1);
  else if (mode === 'pool-4') await runPool(bots, log, 4);
  else {
    await runParallel({
      bots,
      portals: PORTALS.map((p) => p.name),
      log,
      stateDir: path.join(dir, 'state'),
      launchBrowser: async () => fakeBrowser(),
      profile: {},
      sampler: healthySampler,
      dashboard: false,
      writeReport: false,
      installSignals: false,
      closeBrowser: false,
      limits: { discovery: 8, apply: 3 },
    });
  }
  const wall = Date.now() - t0;
  clearInterval(sampleTimer);
  await sample();
  const roles = ledger.map((l) => `${l.company}|${l.title}`);
  const firstAt = ledger.length ? Math.min(...ledger.map((l) => l.at)) - t0 : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    wall: wall / scale / 1000,
    measuredWallMs: wall,
    first: firstAt != null ? firstAt / scale / 1000 : null,
    submitted: ledger.length,
    duplicates: roles.length - new Set(roles).size,
    peakCpuPct: Math.max(...samples.map((s) => s.cpuPct || 0)),
    minMemAvailablePct: Math.min(...samples.map((s) => s.memAvailablePct ?? 100)),
  };
}

(async () => {
  const silence = require('../src/core/logger');
  silence.setSink(() => {});
  console.log(`Simulated workload: ${PORTALS.length} portals, ${PORTALS.reduce((n, p) => n + p.eligible, 0)} eligible listings (3 roles syndicated on naukri/foundit/talent), scale 1/${Math.round(1 / scale)}, ${reps} reps\n`);
  const rows = [];
  for (const mode of ['sequential', 'pool-4', 'parallel']) {
    const runs = [];
    for (let i = 0; i < reps; i++) runs.push(await once(mode));
    const med = (k) => runs.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
    rows.push({ mode, wall: med('wall'), first: med('first'), submitted: med('submitted'), duplicates: Math.max(...runs.map((r) => r.duplicates)), peakCpuPct: Math.max(...runs.map((r) => r.peakCpuPct)), minMemAvailablePct: Math.min(...runs.map((r) => r.minMemAvailablePct)) });
  }
  const base = rows[0].wall;
  console.log('| Scheduler | Wall-clock (s, real-time equiv.) | vs sequential | First application (s) | Submissions | Duplicate submissions | Peak host CPU | Min available memory |');
  console.log('|---|---|---|---|---|---|---:|---:|');
  for (const r of rows) console.log(`| ${r.mode} | ${r.wall.toFixed(0)} | ${(base / r.wall).toFixed(2)}× | ${r.first != null ? r.first.toFixed(0) : '-'} | ${r.submitted} | ${r.duplicates} | ${r.peakCpuPct}% | ${r.minMemAvailablePct}% |`);

  // Syndication race: the same 10 roles listed on three portals that reach them at the same moment.
  console.log('\nSyndication race (10 roles × 3 portals reached simultaneously):\n');
  console.log('| Scheduler | Submissions | Duplicate submissions of a role |');
  console.log('|---|---|---|');
  for (const mode of ['pool-4', 'parallel']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobman-race-'));
    const log = createLog(path.join(dir, 'log.csv'));
    const ledger = [];
    const roles = Array.from({ length: 10 }, (_, i) => ({ title: `React Native Developer ${i}`, company: `Acme ${i}` }));
    const bots = {};
    for (const p of ['naukri', 'foundit', 'talent']) {
      bots[p] = createFakeBot({ site: p, pages: [roles.map((r, i) => ({ ...r, url: `https://${p}.example/${i}`, eligible: true }))], pageMs: 5, applyMs: 30, gapMs: 5, ledger });
    }
    if (mode === 'pool-4') await runPool(bots, log, 4).catch(() => {});
    else await runParallel({ bots, portals: Object.keys(bots), log, stateDir: path.join(dir, 'state'), launchBrowser: async () => fakeBrowser(), profile: {}, sampler: healthySampler, dashboard: false, writeReport: false, installSignals: false, closeBrowser: false, limits: { discovery: 8, apply: 3 } });
    const keys = ledger.map((l) => `${l.company}|${l.title}`);
    console.log(`| ${mode} | ${ledger.length} | ${keys.length - new Set(keys).size} |`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
