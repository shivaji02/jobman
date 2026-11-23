const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Semaphore, backoffMs, mapLimitLazy } = require('../src/core/concurrency');
const { createJobStore, statusFromCsv, STATUS } = require('../src/core/jobdb');
const { createLog } = require('../src/core/dedup');
const { reconcileAll, emptyResults } = require('../src/core/disposition');
const { runParallel, buildUnits, mergeAttempts, acquireLock } = require('../src/parallel');
const { createFakeBot, createCaptchaBot, fakeBrowser, healthySampler, sleep } = require('./helpers/fakeBot');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jobman-par-'));
const job = (i, extra = {}) => ({ url: `https://example.com/jobs/${i}`, title: `React Native Developer ${i}`, company: `Co${i}`, eligible: true, ...extra });

function setup() {
  const dir = tmp();
  const log = createLog(path.join(dir, 'log.csv'));
  log.load();
  return { dir, log, stateDir: path.join(dir, 'state') };
}

// ---------------------------------------------------------------- primitives

test('Semaphore never exceeds its limit and honours runtime limit changes', async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let peak = 0;
  const task = () =>
    sem.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(10);
      active--;
    });
  await Promise.all(Array.from({ length: 8 }, task));
  assert.equal(peak, 2);
  sem.setLimit(4);
  peak = 0;
  await Promise.all(Array.from({ length: 8 }, task));
  assert.equal(peak, 4);
});

test('backoffMs grows exponentially and is bounded', () => {
  const r = () => 0.5; // no jitter
  assert.equal(backoffMs(1, { baseMs: 1000, maxMs: 5000, random: r }), 1000);
  assert.equal(backoffMs(2, { baseMs: 1000, maxMs: 5000, random: r }), 2000);
  assert.equal(backoffMs(3, { baseMs: 1000, maxMs: 5000, random: r }), 4000);
  assert.equal(backoffMs(9, { baseMs: 1000, maxMs: 5000, random: r }), 5000);
});

test('mapLimitLazy keeps order and bounds concurrency', async () => {
  let active = 0;
  let peak = 0;
  const ps = mapLimitLazy([5, 1, 3, 2, 4], 2, async (x) => {
    active++;
    peak = Math.max(peak, active);
    await sleep(x * 3);
    active--;
    return x * 10;
  });
  assert.deepEqual(await Promise.all(ps), [50, 10, 30, 20, 40]);
  assert.equal(peak, 2);
});

// ---------------------------------------------------------------- job store

test('statusFromCsv maps CSV statuses onto store statuses', () => {
  assert.equal(statusFromCsv('applied', 'evidence: text "x"'), STATUS.CONFIRMED);
  assert.equal(statusFromCsv('applied', 'already applied on Naukri (page shows Applied)'), STATUS.ALREADY_APPLIED);
  assert.equal(statusFromCsv('unconfirmed', ''), STATUS.NEEDS_USER);
  assert.equal(statusFromCsv('manual-apply', ''), STATUS.NEEDS_USER);
  assert.equal(statusFromCsv('failed', ''), STATUS.FAILED_RETRYABLE);
  assert.equal(statusFromCsv('skipped', 'score 10 below threshold'), STATUS.REJECTED);
});

test('claims are atomic: two workers racing for the same URL → exactly one wins', async () => {
  const { log, stateDir } = setup();
  const store = createJobStore({ dedup: log, stateDir, applyLimit: 3 });
  const a = store.view('naukri');
  const b = store.view('foundit');
  const j = job(1);
  const [ra, rb] = await Promise.all([a.claimForApply(j.url, j), b.claimForApply(j.url, j)]);
  assert.equal([ra.ok, rb.ok].filter(Boolean).length, 1);
  assert.match((ra.ok ? rb : ra).reason, /in progress via|already handled/);
});

test('claims are atomic per role: a syndicated copy (same company+title, other URL) is refused', async () => {
  const { log, stateDir } = setup();
  const store = createJobStore({ dedup: log, stateDir });
  const r1 = await store.view('naukri').claimForApply('https://naukri.com/job-1', { company: 'Acme Pvt Ltd', title: 'React Native Developer' });
  const r2 = await store.view('talent').claimForApply('https://talent.com/view?id=9', { company: 'ACME', title: 'React Native Developer' });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /same role already handled this run via naukri/);
  assert.equal(store.stats.claimConflicts, 1);
});

test('a job submitted elsewhere after discovery is refused at claim time', async () => {
  const { log, stateDir } = setup();
  const store = createJobStore({ dedup: log, stateDir });
  const v = store.view('linkedin');
  log.append({ site: 'Naukri', job_title: 'Frontend Developer', company: 'Zeta', job_url: 'https://naukri.com/x', status: 'applied', notes: 'evidence: x' });
  const r = await v.claimForApply('https://linkedin.com/jobs/view/5', { company: 'Zeta', title: 'Frontend Developer' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /same role already applied/);
});

test('application slots bound submissions in flight across portals', async () => {
  const { log, stateDir } = setup();
  const store = createJobStore({ dedup: log, stateDir, applyLimit: 2 });
  let active = 0;
  let peak = 0;
  await Promise.all(
    ['a', 'b', 'c', 'd', 'e'].map(async (p, i) => {
      const v = store.view(p);
      const j = job(i);
      const c = await v.claimForApply(j.url, j);
      assert.equal(c.ok, true);
      active++;
      peak = Math.max(peak, active);
      await sleep(15);
      active--;
      v.append({ site: p, job_title: j.title, company: j.company, job_url: j.url, status: 'applied', notes: 'evidence: ok' });
    })
  );
  assert.equal(peak, 2);
  assert.equal(store.stats.confirmed, 5);
  assert.equal(store.applySlots.active, 0);
});

test('a failed attempt releases the claim so another portal may try its copy', async () => {
  const { log, stateDir } = setup();
  const store = createJobStore({ dedup: log, stateDir });
  const a = store.view('naukri');
  const j = { company: 'Acme', title: 'Mobile Developer' };
  assert.equal((await a.claimForApply('https://naukri.com/1', j)).ok, true);
  a.append({ site: 'Naukri', job_title: j.title, company: j.company, job_url: 'https://naukri.com/1', status: 'failed', notes: 'timeout' });
  assert.equal((await store.view('foundit').claimForApply('https://foundit.in/2', j)).ok, true);
});

test('dry-run claims never hold an application slot but still dedupe across portals', async () => {
  const { log, stateDir } = setup();
  const store = createJobStore({ dedup: log, stateDir, applyLimit: 1, dryRun: true });
  const results = await Promise.all([1, 2, 3].map((i) => store.view(`p${i}`).claimForApply(job(i).url, job(i))));
  assert.ok(results.every((r) => r.ok));
  assert.equal(store.applySlots.active, 0);
  assert.equal((await store.view('p9').claimForApply(job(1).url, job(1))).ok, false);
});

test('crash recovery: an attempt journaled as applying with no outcome becomes unconfirmed (blocking)', async () => {
  const { log, stateDir } = setup();
  const s1 = createJobStore({ dedup: log, stateDir });
  const j = job(7);
  assert.equal((await s1.view('naukri', { site: 'Naukri' }).claimForApply(j.url, j)).ok, true);
  // process "dies" here: no append, no close
  const log2 = createLog(log.filePath);
  log2.load();
  const s2 = createJobStore({ dedup: log2, stateDir });
  const rec = s2.recover();
  assert.equal(rec.length, 1);
  assert.equal(log2.has(j.url), true, 'interrupted attempt must block resubmission');
  assert.equal(log2.lastStatus(j.url).status, 'unconfirmed');
  assert.match(log2.lastStatus(j.url).notes, /run interrupted during an apply attempt/);
  assert.equal(s2.recover().length, 0, 'journal rotated after recovery');
});

test('crash recovery ignores attempts that logged an outcome', async () => {
  const { log, stateDir } = setup();
  const s1 = createJobStore({ dedup: log, stateDir });
  const v = s1.view('naukri');
  const j = job(8);
  await v.claimForApply(j.url, j);
  v.append({ site: 'Naukri', job_title: j.title, company: j.company, job_url: j.url, status: 'applied', notes: 'evidence: ok' });
  assert.equal(createJobStore({ dedup: log, stateDir }).recover().length, 0);
});

test('shutdown: queued claims stop the bot cleanly and assertRunning blocks new listings', async () => {
  const { log, stateDir } = setup();
  const store = createJobStore({ dedup: log, stateDir, applyLimit: 1 });
  const a = store.view('a');
  await a.claimForApply(job(1).url, job(1));
  const waiting = store.view('b').claimForApply(job(2).url, job(2));
  store.shutdown();
  await assert.rejects(waiting, { name: 'SkipPortalError' });
  assert.throws(() => store.view('c').assertRunning(), { name: 'SkipPortalError' });
  await assert.rejects(store.view('d').claimForApply(job(3).url, job(3)), { name: 'SkipPortalError' });
});

// ---------------------------------------------------------------- scheduler

test('buildUnits keeps google+careers together and everything else independent', () => {
  assert.deepEqual(buildUnits(['google', 'careers', 'naukri', 'linkedin']), [['google', 'careers'], ['naukri'], ['linkedin']]);
  assert.deepEqual(buildUnits(['careers', 'naukri']), [['careers'], ['naukri']]);
});

test('mergeAttempts keeps the first attempt\'s submissions instead of "already applied" duplicates', () => {
  const first = { reviewed: 2, discovered: 2, duplicates: 0, outOfScope: 0, applied: [{ url: 'https://x/1', title: 'a' }], unconfirmed: [], alreadyApplied: [], manualApply: [], skipped: [{ url: 'https://x/2' }], failed: [] };
  const second = { reviewed: 3, discovered: 3, duplicates: 0, outOfScope: 0, applied: [{ url: 'https://x/3' }], unconfirmed: [], alreadyApplied: [{ url: 'https://x/1', reason: 'already applied (log)' }], manualApply: [], skipped: [{ url: 'https://x/2' }], failed: [] };
  const m = mergeAttempts(first, second);
  assert.equal(m.applied.length, 2);
  assert.equal(m.alreadyApplied.length, 0);
  assert.equal(reconcileAll({ p: m }).total.unaccounted, 0);
});

test('lock file prevents a second concurrent run on the same profile', () => {
  const dir = tmp();
  const release = acquireLock(dir);
  // simulate another live process holding it
  fs.writeFileSync(path.join(dir, 'run.lock'), String(process.ppid));
  assert.throws(() => acquireLock(dir), /another jobman run is active/);
  fs.writeFileSync(path.join(dir, 'run.lock'), String(process.pid));
  release();
  assert.equal(fs.existsSync(path.join(dir, 'run.lock')), false);
});

function parallelOpts(extra) {
  return { launchBrowser: async () => fakeBrowser(), profile: {}, sampler: healthySampler, dashboard: false, writeReport: false, installSignals: false, closeBrowser: false, retryBaseMs: 20, controlIntervalMs: 50, ...extra };
}

test('runParallel: portals overlap, syndicated jobs are applied once, funnel reconciles', async () => {
  const { log, stateDir } = setup();
  const ledger = [];
  // 30 jobs; portals b and c both list syndicated copies of a's jobs 0-9 under other URLs
  const base = Array.from({ length: 30 }, (_, i) => job(i));
  const copy = (prefix) => base.slice(0, 10).map((j) => ({ ...j, url: j.url.replace('example.com', `${prefix}.example`) }));
  const pages = (list) => [list.slice(0, 10), list.slice(10, 20), list.slice(20)];
  const bots = {
    a: createFakeBot({ site: 'A', pages: pages(base), ledger, applyMs: 15 }),
    b: createFakeBot({ site: 'B', pages: pages([...copy('b'), ...Array.from({ length: 10 }, (_, i) => job(100 + i))]), ledger, applyMs: 15 }),
    c: createFakeBot({ site: 'C', pages: pages([...copy('c'), ...Array.from({ length: 10 }, (_, i) => job(200 + i, { eligible: i % 2 === 0 }))]), ledger, applyMs: 15 }),
  };
  const t0 = Date.now();
  const { results, metrics } = await runParallel(parallelOpts({ bots, portals: ['a', 'b', 'c'], log, stateDir, limits: { discovery: 3, apply: 3 } }));
  const wall = Date.now() - t0;

  const roles = ledger.map((l) => `${l.company}|${l.title}`);
  assert.equal(new Set(roles).size, roles.length, 'no role submitted twice');
  assert.equal(ledger.length, 30 + 10 + 5);
  assert.ok(metrics.stats.claimConflicts + Object.values(results).reduce((n, r) => n + r.alreadyApplied.length, 0) >= 20);
  assert.equal(reconcileAll(results).total.unaccounted, 0);
  // all three ran at once: wall-clock well under the serial sum
  const serial = Object.values(metrics.portals).reduce((n, p) => n + p.ms, 0);
  assert.ok(wall < serial * 0.8, `wall ${wall}ms vs serial ${serial}ms`);
});

test('runParallel: a crashing portal is retried with backoff and does not disturb the others', async () => {
  const { log, stateDir } = setup();
  const ledger = [];
  const flaky = createFakeBot({ site: 'F', pages: [[job(1)], [job(2)], [job(3)]], ledger, crashTimes: 1 });
  const steady = createFakeBot({ site: 'S', pages: [[job(10)], [job(11)]], ledger });
  const { results, metrics } = await runParallel(parallelOpts({ bots: { flaky, steady }, portals: ['flaky', 'steady'], log, stateDir, portalRetries: 2 }));
  assert.equal(flaky.runs(), 2);
  assert.equal(metrics.retries, 1);
  assert.equal(metrics.portals.flaky.state, 'done');
  assert.equal(results.steady.applied.length, 2);
  // job 1 was submitted in the crashed attempt; the retry must not submit it again
  assert.equal(ledger.filter((l) => l.url === job(1).url).length, 1);
  assert.equal(results.flaky.applied.length, 3);
  assert.equal(reconcileAll(results).total.unaccounted, 0);
});

test('runParallel: CAPTCHA stops are never retried', async () => {
  const { log, stateDir } = setup();
  const bot = createCaptchaBot({ site: 'X', pages: [[job(1)]] });
  const { metrics, results } = await runParallel(parallelOpts({ bots: { x: bot }, portals: ['x'], log, stateDir }));
  assert.equal(metrics.retries, 0);
  assert.equal(metrics.portals.x.state, 'skipped');
  assert.match(results.x.note, /CAPTCHA/);
});

test('runParallel: a completed worker with blocked searches is reported partial', async () => {
  const { log, stateDir } = setup();
  const bot = { async run() { return { ...emptyResults(), note: 'verification blocked; remaining searches not run' }; } };
  const { metrics } = await runParallel(parallelOpts({ bots: { portal: bot }, portals: ['portal'], log, stateDir }));
  assert.equal(metrics.portals.portal.state, 'partial');
});

test('runParallel --resume skips portals finished in today\'s checkpoint and reuses their results', async () => {
  const { log, stateDir } = setup();
  const one = createFakeBot({ site: 'One', pages: [[job(1)]] });
  const two = createFakeBot({ site: 'Two', pages: [[job(2)]] });
  await runParallel(parallelOpts({ bots: { one }, portals: ['one'], log, stateDir }));
  const { results } = await runParallel(parallelOpts({ bots: { one, two }, portals: ['one', 'two'], log, stateDir, resume: true }));
  assert.equal(one.runs(), 1, 'finished portal not re-run');
  assert.equal(two.runs(), 1);
  assert.equal(results.one.applied.length, 1);
});

test('runParallel graceful shutdown: in-flight application finishes, nothing new starts, rerun does not duplicate', async () => {
  const { log, stateDir } = setup();
  const ledger = [];
  let ctl;
  let fired = false;
  const bot = createFakeBot({
    site: 'G',
    pages: [Array.from({ length: 10 }, (_, i) => job(i))],
    ledger,
    applyMs: 30,
    onApply: async () => {
      if (!fired) {
        fired = true;
        setTimeout(() => ctl.shutdown(), 5); // Ctrl+C while the first submission is in flight
      }
    },
  });
  const { results, metrics } = await runParallel(parallelOpts({ bots: { g: bot }, portals: ['g'], log, stateDir, onReady: (c) => (ctl = c) }));
  assert.equal(metrics.stopped, true);
  assert.equal(ledger.length, 1, 'only the in-flight submission completed');
  assert.equal(results.g.applied.length, 1);
  assert.equal(reconcileAll(results).total.unaccounted, 0);
  // resume: the rest are applied, job 0 is not resubmitted
  const ledger2 = [];
  const again = createFakeBot({ site: 'G', pages: [Array.from({ length: 10 }, (_, i) => job(i))], ledger: ledger2, applyMs: 1 });
  await runParallel(parallelOpts({ bots: { g: again }, portals: ['g'], log, stateDir, resume: true }));
  assert.equal(ledger2.length, 9);
  assert.ok(!ledger2.some((l) => l.url === job(0).url));
});

test('runParallel dry run submits nothing and writes nothing to the log', async () => {
  const { log, stateDir } = setup();
  const ledger = [];
  const bot = createFakeBot({ site: 'D', pages: [[job(1), job(2)]], ledger });
  const { results } = await runParallel(parallelOpts({ bots: { d: bot }, portals: ['d'], log, stateDir, dryRun: true }));
  assert.equal(ledger.length, 0);
  assert.equal(results.d.applied.length, 2);
  assert.equal(fs.existsSync(log.filePath), false);
});

test('adaptive control lowers application workers under memory pressure', async () => {
  const { log, stateDir } = setup();
  let mem = 60;
  const sampler = { sample: async () => ({ ...(await healthySampler.sample()), memAvailablePct: mem }) };
  const bot = createFakeBot({ site: 'M', pages: Array.from({ length: 12 }, (_, i) => [job(i)]), pageMs: 25 });
  setTimeout(() => (mem = 5), 60);
  const { metrics } = await runParallel(parallelOpts({ bots: { m: bot }, portals: ['m'], log, stateDir, sampler, limits: { discovery: 1, apply: 3 } }));
  assert.ok(metrics.limits.apply < 3, `apply limit should drop, got ${metrics.limits.apply}`);
  assert.ok(metrics.controlLog.some((c) => /resource pressure/.test(c.msg)));
});
