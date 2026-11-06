/**
 * Parallel run: every portal is an independent worker, coordinated through one
 * job store (core/jobdb) and one Chrome.
 *
 *   discovery workers   portals running at once (each bot discovers → screens →
 *                       applies in its own tabs). Limit = `discovery` semaphore.
 *   application workers global cap on submissions in flight across all portals
 *                       (`store.applySlots`). A bot that finds an eligible job
 *                       claims it atomically and waits for a slot; every other
 *                       portal keeps discovering meanwhile.
 *   ATS workers         employer postings handled concurrently inside the
 *                       careers channel (JOBMAN_ATS_WORKERS).
 *
 * Safety properties:
 *   - one Chrome, one user-data-dir: workers are tabs of the same browser, so no
 *     two processes ever write the profile; a lock file stops a second jobman run.
 *   - atomic job/role claiming + the CSV log → no duplicate submissions, also
 *     across syndicated copies of a posting on different portals.
 *   - write-ahead journal → an interrupted attempt is marked `unconfirmed`, never
 *     resubmitted.
 *   - per-portal crash isolation, bounded exponential backoff retries (never for
 *     CAPTCHA / login walls), checkpoint after every portal, `--resume`.
 *   - Ctrl+C once: no new listings or applications; in-flight ones finish and the
 *     report is written. Twice: exit now (journal covers in-flight attempts).
 */
const fs = require('fs');
const path = require('path');
const dedup = require('./core/dedup');
const reporter = require('./core/reporter');
const browserCore = require('./core/browser');
const logger = require('./core/logger');
const { formatRunSummary } = require('./core/summary');
const { emptyResults, BUCKETS } = require('./core/disposition');
const { createJobStore } = require('./core/jobdb');
const { Semaphore, backoffMs, sleep } = require('./core/concurrency');
const { createSampler, recommendedLimits } = require('./core/resources');
const { createDashboard, fmtDur } = require('./core/dashboard');

const STATE_DIR = path.join(__dirname, '..', 'data', 'run-state');

/** google + careers stay one unit: boards Google finds are read by careers in the same run. */
const GROUPS = [['google', 'careers']];

function buildUnits(portals) {
  const units = [];
  const grouped = new Set();
  for (const g of GROUPS) {
    const members = g.filter((p) => portals.includes(p));
    if (members.length) {
      units.push(members);
      members.forEach((m) => grouped.add(m));
    }
  }
  for (const p of portals) if (!grouped.has(p)) units.push([p]);
  return units;
}

// ---------------------------------------------------------------- lock + checkpoint

function acquireLock(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'run.lock');
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch {
    const pid = parseInt(fs.readFileSync(file, 'utf8'), 10);
    let alive = false;
    try {
      if (pid && pid !== process.pid) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch {
      alive = false;
    }
    if (alive) throw new Error(`another jobman run is active (pid ${pid}) — it owns the Chrome profile; wait for it or stop it first`);
    fs.writeFileSync(file, String(process.pid)); // stale lock from a crash
  }
  return () => {
    try {
      if (parseInt(fs.readFileSync(file, 'utf8'), 10) === process.pid) fs.unlinkSync(file);
    } catch {
      // ignore
    }
  };
}

function checkpointPath(stateDir, dryRun) {
  return path.join(stateDir, dryRun ? 'checkpoint.dry-run.json' : 'checkpoint.json');
}

function loadCheckpoint(stateDir, dryRun, date) {
  try {
    const cp = JSON.parse(fs.readFileSync(checkpointPath(stateDir, dryRun), 'utf8'));
    return cp.date === date ? cp : null;
  } catch {
    return null;
  }
}

function saveCheckpoint(stateDir, dryRun, cp) {
  const file = checkpointPath(stateDir, dryRun);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cp));
    fs.renameSync(tmp, file); // atomic replace — a crash never leaves a half-written checkpoint
  } catch (err) {
    logger.warn(`[parallel] checkpoint not saved: ${err.message}`);
  }
}

// ---------------------------------------------------------------- results merging

const keyOf = (e) => dedup.normalizeJobUrl(e.url || e.companyUrl || '') || `${e.company}|${e.title}`;

/**
 * A portal retried after a crash re-reads its listings: what the first attempt
 * already submitted / handed off now shows as "already applied" in the retry.
 * Keep the first attempt's real outcome instead, so the report stays truthful
 * and the funnel still reconciles.
 */
function mergeAttempts(first, second) {
  if (!first) return second;
  if (!second) return first;
  const out = { ...second };
  for (const b of BUCKETS) out[b] = [...(second[b] || [])];
  const keep = ['applied', 'unconfirmed', 'manualApply', 'failed'];
  for (const b of keep) {
    for (const e of first[b] || []) {
      const k = keyOf(e);
      let found = false;
      for (const bb of BUCKETS) {
        const i = out[bb].findIndex((x) => keyOf(x) === k);
        if (i >= 0) {
          found = true;
          if (bb === 'alreadyApplied' || (b !== 'failed' && bb === 'failed')) {
            out[bb].splice(i, 1);
            out[b].push(e);
          }
          break;
        }
      }
      if (!found) {
        out[b].push(e);
        out.reviewed = (out.reviewed || 0) + 1;
        out.discovered = (out.discovered || 0) + 1;
      }
    }
  }
  out.note = [first.note, second.note].filter(Boolean).join(' → retried → ') || undefined;
  return out;
}

// ---------------------------------------------------------------- main

async function runParallel(opts = {}) {
  const {
    dryRun = false,
    portals: portalsOpt,
    resume = false,
    dashboard: wantDashboard = true,
    adaptive = true,
    portalRetries = 2,
    retryBaseMs = 20_000,
    stateDir = STATE_DIR,
    bots: botsOpt,
    launchBrowser = () => browserCore.launch(),
    log = dedup,
    profile: profileOpt,
    sampler: samplerOpt,
    controlIntervalMs = 5000,
    writeReport = true,
    installSignals = true,
    onReady,
  } = opts;
  const runner = require('./runner');
  const bots = botsOpt || runner.BOTS;
  const portals = (portalsOpt || runner.PORTALS_IN_PRIORITY_ORDER).filter((p) => bots[p]);
  const rec = recommendedLimits();
  const limits = {
    discovery: opts.limits?.discovery ?? (Number(process.env.JOBMAN_DISCOVERY_WORKERS) || rec.discovery),
    apply: opts.limits?.apply ?? (Number(process.env.JOBMAN_APPLY_WORKERS) || rec.apply),
    applyMax: opts.limits?.applyMax ?? (Number(process.env.JOBMAN_APPLY_WORKERS_MAX) || 5),
    maxTabs: opts.limits?.maxTabs ?? (Number(process.env.JOBMAN_MAX_TABS) || 30),
    memLowPct: opts.limits?.memLowPct ?? 15,
    cpuHighPct: opts.limits?.cpuHighPct ?? 90,
  };
  if (!process.env.JOBMAN_ATS_WORKERS) process.env.JOBMAN_ATS_WORKERS = String(opts.limits?.ats ?? rec.ats);

  const releaseLock = acquireLock(stateDir);
  const date = dedup.istDate();
  const t0 = Date.now();
  log.load();

  const store = opts.store || createJobStore({ dedup: log, stateDir, applyLimit: limits.apply, dryRun });
  const recovered = store.recover();
  if (recovered.length) logger.warn(`[parallel] ${recovered.length} interrupted apply attempt(s) from the last run marked unconfirmed (never auto-resubmitted)`);

  const units = buildUnits(portals);
  const discovery = new Semaphore(Math.min(limits.discovery, units.length), { name: 'discovery', min: 1, max: units.length });
  const rows = new Map(portals.map((p) => [p, { name: p, state: 'queued', attempts: 0, note: '' }]));
  const results = {};
  const attemptsResults = {};
  let retries = 0;
  let tabsOpen = 0;
  let lastResources = null;
  const controlLog = [];

  const prior = resume ? loadCheckpoint(stateDir, dryRun, date) : null;
  const checkpoint = { date, dryRun, startedAt: new Date(t0).toISOString(), portals: {} };
  if (prior) {
    for (const [p, st] of Object.entries(prior.portals || {})) {
      if (portals.includes(p) && st.state === 'done' && st.result) {
        results[p] = st.result;
        checkpoint.portals[p] = st;
        Object.assign(rows.get(p), { state: 'done', note: 'resumed from checkpoint' });
      }
    }
  }

  // ---- browser (one Chrome, one profile; workers are tabs) ----
  let browser;
  let newPage;
  try {
    ({ browser, newPage } = await launchBrowser());
  } catch (err) {
    releaseLock();
    const note = `crashed — browser launch failed: ${err.message}`;
    logger.error(`[parallel] ${note}`);
    for (const p of portals) results[p] = results[p] || emptyResults(note);
    return { results, metrics: { wallMs: Date.now() - t0, error: note } };
  }

  // ---- resources + adaptive control ----
  const sampler = samplerOpt || createSampler({ profileDir: browserCore.PROFILE_DIR });
  let lastIncrease = null;
  async function control() {
    try {
      lastResources = await sampler.sample();
      tabsOpen = browser?.pages ? (await browser.pages().catch(() => [])).length : 0;
    } catch {
      return;
    }
    if (!adaptive || store.shuttingDown) return;
    const r = lastResources;
    const apply = store.applySlots;
    const pressure = r.memAvailablePct < limits.memLowPct || r.cpuPct > limits.cpuHighPct || tabsOpen > limits.maxTabs;
    const note = (m) => {
      controlLog.push({ at: Date.now() - t0, msg: m });
      logger.info(`[parallel] ${m}`);
    };
    if (pressure) {
      const why = `mem ${r.memAvailablePct}% cpu ${r.cpuPct}% tabs ${tabsOpen}`;
      if (apply.limit > 1) note(`resource pressure (${why}) → application workers ${apply.limit} → ${apply.setLimit(apply.limit - 1)}`);
      if (discovery.limit > 2) note(`resource pressure (${why}) → discovery workers ${discovery.limit} → ${discovery.setLimit(discovery.limit - 1)}`);
      lastIncrease = null;
      return;
    }
    const healthy = r.memAvailablePct > limits.memLowPct + 20 && r.cpuPct < limits.cpuHighPct - 25 && tabsOpen < limits.maxTabs * 0.7;
    if (!healthy) return;
    // Hill-climb on throughput: undo an increase that didn't pay off.
    if (lastIncrease && Date.now() - lastIncrease.at > 120_000) {
      const nowRate = store.appsPerMinute(120_000);
      if (nowRate < lastIncrease.rate * 0.8 && apply.limit > limits.apply) note(`throughput fell (${lastIncrease.rate.toFixed(2)} → ${nowRate.toFixed(2)}/min) → application workers ${apply.limit} → ${apply.setLimit(apply.limit - 1)}`);
      lastIncrease = null;
    }
    if (apply.waiting > 0 && apply.limit < limits.applyMax && !lastIncrease) {
      lastIncrease = { at: Date.now(), rate: store.appsPerMinute(120_000) };
      note(`${apply.waiting} eligible job(s) waiting, resources healthy → application workers ${apply.limit} → ${apply.setLimit(apply.limit + 1)}`);
    }
    if (discovery.waiting > 0 && discovery.limit < Math.max(limits.discovery, discovery.max)) {
      note(`portals queued, resources healthy → discovery workers ${discovery.limit} → ${discovery.setLimit(discovery.limit + 1)}`);
    }
  }
  await control();
  const controlTimer = setInterval(control, controlIntervalMs);
  controlTimer.unref?.();

  // ---- dashboard ----
  const scheduler = {
    limits: () => ({ discovery: discovery.limit, apply: store.applySlots.limit }),
    activePortals: () => [...rows.values()].filter((r) => r.state === 'running').length,
    queued: () => [...rows.values()].filter((r) => r.state === 'queued' || r.state === 'backoff').length,
    retries: () => retries,
    tabs: () => tabsOpen,
    portalRows: () => [...rows.values()],
  };
  const dash = wantDashboard ? createDashboard({ store, scheduler, getResources: () => lastResources, dryRun }) : null;
  dash?.start();

  // ---- signals ----
  let interrupts = 0;
  const onSignal = () => {
    interrupts++;
    if (interrupts === 1) {
      logger.warn('[parallel] stop requested — no new listings or applications; finishing in-flight work (Ctrl+C again to exit now)');
      store.shutdown();
      discovery.rejectWaiters(new Error('shutdown'));
      return;
    }
    dash?.stop();
    saveCheckpoint(stateDir, dryRun, checkpoint);
    releaseLock();
    console.log('\nStopped immediately. Interrupted attempts are journaled and will be marked unconfirmed on the next start.');
    process.exit(130);
  };
  if (installSignals) {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }

  // ---- one portal ----
  const profile = profileOpt || runner.loadProfile();
  async function runOne(name) {
    const row = rows.get(name);
    const view = store.view(name);
    row.state = 'running';
    row.attempts++;
    row.startedAt = row.startedAt || Date.now();
    let res;
    let kind = 'ok';
    let message = '';
    try {
      res = await bots[name].run({ profile, dedup: view, dryRun, newPage, browser });
    } catch (err) {
      message = err.message || String(err);
      kind = err instanceof browserCore.SkipPortalError || err.name === 'SkipPortalError' ? 'skipped' : 'crashed';
      res = err.partialResults ? { ...err.partialResults, note: `${kind === 'skipped' ? 'stopped early' : 'crashed'} — ${message}` } : emptyResults(`${kind === 'skipped' ? 'skipped' : 'crashed'} — ${message}`);
      (kind === 'skipped' ? logger.warn : logger.error).call(logger, `[${name}] ${kind === 'skipped' ? 'stopped' : 'crashed'}: ${message}`);
    } finally {
      view.close();
    }
    return { res, kind, message };
  }

  // ---- unit task: acquire a discovery slot, run, maybe retry with backoff ----
  async function runUnit(unit) {
    const todo = unit.filter((p) => rows.get(p).state !== 'done');
    if (!todo.length) return;
    for (const name of todo) {
      for (;;) {
        let release;
        try {
          release = await discovery.acquire();
        } catch {
          rows.get(name).state = 'not started';
          rows.get(name).note = 'stopped before start';
          results[name] = results[name] || emptyResults('not started — run stopped');
          break;
        }
        let out;
        try {
          if (store.shuttingDown) {
            rows.get(name).state = 'not started';
            results[name] = results[name] || emptyResults('not started — run stopped');
            break;
          }
          out = await runOne(name);
        } finally {
          release();
        }
        const row = rows.get(name);
        attemptsResults[name] = mergeAttempts(attemptsResults[name], out.res);
        const canRetry = out.kind === 'crashed' && row.attempts <= portalRetries && !store.shuttingDown;
        if (canRetry) {
          retries++;
          const wait = backoffMs(row.attempts, { baseMs: retryBaseMs, maxMs: retryBaseMs * 8 });
          row.state = 'backoff';
          row.note = `crashed (${out.message.slice(0, 40)}) — retry ${row.attempts}/${portalRetries} in ${Math.round(wait / 1000)}s`;
          logger.warn(`[${name}] ${row.note}`);
          await sleep(wait);
          if (store.shuttingDown) break;
          continue;
        }
        // A Ctrl+C stop is not a finished portal: --resume must run it again.
        row.state = out.kind === 'ok' ? 'done' : store.shuttingDown ? 'stopped' : out.kind === 'skipped' ? 'skipped' : 'crashed';
        row.endedAt = Date.now();
        row.note = out.kind === 'ok' ? '' : out.message.slice(0, 80);
        results[name] = attemptsResults[name];
        checkpoint.portals[name] = { state: row.state, attempts: row.attempts, durationMs: row.endedAt - row.startedAt, result: results[name] };
        saveCheckpoint(stateDir, dryRun, checkpoint);
        break;
      }
    }
  }

  onReady?.({ store, discovery, scheduler, shutdown: onSignal });
  await Promise.all(units.map((u) => runUnit(u)));

  // ---- wrap up ----
  clearInterval(controlTimer);
  dash?.stop();
  if (installSignals) {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  for (const p of portals) results[p] = results[p] || emptyResults('not started — run stopped');
  const ordered = Object.fromEntries(portals.map((p) => [p, results[p]]));
  const wallMs = Date.now() - t0;
  const metrics = {
    wallMs,
    limits: { discovery: discovery.limit, apply: store.applySlots.limit, ats: Number(process.env.JOBMAN_ATS_WORKERS) },
    startLimits: { ...limits },
    portals: Object.fromEntries([...rows.values()].map((r) => [r.name, { state: r.state, attempts: r.attempts, ms: r.startedAt ? (r.endedAt || Date.now()) - r.startedAt : 0 }])),
    stats: { ...store.stats, confirmedAt: undefined },
    retries,
    controlLog,
    recovered: recovered.length,
    stopped: store.shuttingDown,
  };

  if (browser && opts.closeBrowser !== false) {
    const needsKeepTabs = !dryRun && portals.some((p) => runner.KEEP_TABS_PORTALS.has(p));
    if (needsKeepTabs || browser.__jobmanAttached) await runner.keepBrowserOpen(browser);
    else await browser.close().catch(() => {});
  }
  releaseLock();

  if (writeReport) {
    const file = reporter.write(date, ordered, { dryRun });
    try {
      fs.appendFileSync(file, parallelSection(metrics));
    } catch {
      // ignore
    }
    logger.info(`Report written to ${file}`);
    console.log(formatRunSummary(ordered, { dryRun }));
    console.log(`\nParallel run: ${fmtDur(wallMs)} wall-clock · ${metrics.stats.confirmed} confirmed · ${metrics.stats.claimConflicts} cross-portal duplicates avoided · ${retries} portal retries${metrics.stopped ? ' · stopped early (Ctrl+C) — rerun with --resume' : ''}`);
  }
  return { results: ordered, metrics };
}

function parallelSection(m) {
  const lines = ['', '## Parallel run', '', `Wall-clock ${fmtDur(m.wallMs)} · workers at start: discovery ${m.startLimits.discovery}, application ${m.startLimits.apply}, ATS ${m.limits.ats} · at end: discovery ${m.limits.discovery}, application ${m.limits.apply}`, ''];
  lines.push('| Portal | State | Attempts | Time |', '|---|---|---|---|');
  for (const [p, r] of Object.entries(m.portals)) lines.push(`| ${p} | ${r.state} | ${r.attempts} | ${fmtDur(r.ms)} |`);
  lines.push('', `Cross-portal duplicate claims avoided: ${m.stats.claimConflicts} · portal retries: ${m.retries} · interrupted attempts recovered: ${m.recovered}`);
  if (m.controlLog.length) {
    lines.push('', 'Adaptive concurrency:');
    for (const c of m.controlLog) lines.push(`- +${fmtDur(c.at)} ${c.msg}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { runParallel, buildUnits, mergeAttempts, acquireLock, loadCheckpoint, saveCheckpoint };
