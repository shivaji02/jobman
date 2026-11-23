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
const { createPipeline, mergePipelineResults } = require('./core/pipeline');
const { createEnricher } = require('./core/enrich');
const { createApprovalStore, normalizeApprovals } = require('./core/approval');
const { ADAPTERS } = require('./core/submit');
const { reconcileAll } = require('./core/disposition');

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

function checkpointPath(stateDir, dryRun, suffix = '') {
  return path.join(stateDir, `checkpoint${dryRun ? '.dry-run' : ''}${suffix ? `.${suffix}` : ''}.json`);
}

function loadCheckpoint(stateDir, dryRun, date, suffix = '') {
  try {
    const cp = JSON.parse(fs.readFileSync(checkpointPath(stateDir, dryRun, suffix), 'utf8'));
    return cp.date === date ? cp : null;
  } catch {
    return null;
  }
}

function saveCheckpoint(stateDir, dryRun, cp) {
  const file = checkpointPath(stateDir, dryRun, cp.suffix);
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
  // Resumable bots continue in the same results object: nothing to merge.
  if (first === second) return second;
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
    approvedJobs: approvedJobsOpt = [],
    sampler: samplerOpt,
    controlIntervalMs = 5000,
    writeReport = true,
    installSignals = true,
    onReady,
    enrich = true,
    fullScan = false,
    waitApprovalsMs = 0,
    approvals: approvalsOpt,
    enricher: enricherOpt,
    adapters = ADAPTERS,
    reportSuffix = '',
  } = opts;
  const runner = require('./runner');
  const bots = botsOpt || runner.BOTS;
  // Approval queue (data/approvals.json): --approve-url adds to it; approvals made in
  // another terminal while this run is going are picked up live by the pipeline.
  const approvals = approvalsOpt === null ? null : approvalsOpt || createApprovalStore({ file: path.join(stateDir, '..', dryRun ? 'approvals.dry-run.json' : 'approvals.json') });
  for (const url of approvedJobsOpt || []) approvals?.approveUrl(url);
  const approvedJobs = normalizeApprovals([...(approvedJobsOpt || []), ...(approvals ? [...approvals.approvedKeys()] : [])]);
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
  const recoveredApprovals = approvals?.recoverSubmitting?.() || [];
  if (recoveredApprovals.length) logger.warn(`[parallel] ${recoveredApprovals.length} interrupted submission(s) marked unconfirmed and will not be retried`);
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

  const prior = resume ? loadCheckpoint(stateDir, dryRun, date, reportSuffix) : null;
  const checkpoint = { date, dryRun, startedAt: new Date(t0).toISOString(), portals: {}, ...(reportSuffix ? { suffix: reportSuffix } : {}) };
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
  // Every portal shares this Chrome. When it dies, all of them fail at once, so
  // relaunch it (once, shared) before the next attempt instead of retrying a dead handle.
  let relaunching = null;
  const ensureBrowser = () => {
    if (browser && typeof browser.isConnected === 'function' && browser.isConnected()) return Promise.resolve();
    if (!relaunching) {
      relaunching = (async () => {
        logger.warn('[parallel] shared Chrome disconnected — relaunching');
        await Promise.resolve(browser?.close?.()).catch(() => {});
        ({ browser, newPage } = await launchBrowser());
      })().finally(() => { relaunching = null; });
    }
    return relaunching;
  };
  const livePage = (...args) => newPage(...args);
  try {
    ({ browser, newPage } = await launchBrowser());
  } catch (err) {
    releaseLock();
    const note = `crashed — browser launch failed: ${err.message}`;
    logger.error(`[parallel] ${note}`);
    for (const p of portals) results[p] = results[p] || emptyResults(note);
    return { results, metrics: { wallMs: Date.now() - t0, error: note } };
  }

  // ---- application pipeline (runs alongside discovery) ----
  const profileForPipeline = profileOpt || runner.loadProfile();
  const enricher = !enrich ? null : enricherOpt || createEnricher({ newPage: livePage, useCache: !fullScan, cacheFile: path.join(stateDir, '..', 'jd-cache.json') });
  const diagnosticsStamp = new Date(t0).toISOString().replace(/[:.]/g, '-');
  const diagnosticsFile = path.join(stateDir, `candidate-diagnostics-${date}${dryRun ? '-dry-run' : ''}-${diagnosticsStamp}.jsonl`);
  const pipeline = createPipeline({ enricher, approvals, store, log, dryRun, profile: profileForPipeline, adapters, browser, approvedJobs, diagnosticsFile });
  pipeline.startPolling(Number(process.env.JOBMAN_APPROVAL_POLL_MS) || 10_000);
  const portalState = Object.fromEntries(portals.map((p) => [p, {}]));

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
    portalRows: () => [...rows.values()].map((r) => ({ ...r, note: portalState[r.name]?.status || r.note })),
    live: () => liveFunnel(),
    pipeline: () => pipeline.snapshot(),
    followups: () => require('./core/followups').createFollowupStore().list().length,
    approvalCounts: () => {
      const list = approvals?.list() || [];
      const counts = { prepared: list.length, pending: 0, approved: 0, submitting: 0, submitted: 0, confirmed: 0, unconfirmed: 0, already_applied: 0, needs_user: 0, failed: 0, rejected: 0 };
      for (const j of list) {
        const state = j.workflowStatus || j.status;
        if (state === 'approved' && !ADAPTERS[j.portal]) counts.needs_user++;
        else if (state in counts) counts[state]++;
        else if (state === 'declined') counts.rejected++;
        if (j.submittedAt) counts.submitted++;
      }
      return counts;
    },
  };
  /** Same reconciliation the report uses, on the live (partial) results. */
  function liveFunnel() {
    const live = {};
    for (const p of portals) {
      const base = portalState[p].results || results[p];
      if (!base) continue;
      live[p] = { ...base };
    }
    mergePipelineResults(live, { results: pipeline.results });
    return reconcileAll(live, { dryRun });
  }
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
      await ensureBrowser();
      res = await bots[name].run({ profile, dedup: view, dryRun, newPage, browser, approvedJobs, pipeline, portal: name, resume: portalState[name], fullScan, isStopping: () => !!store.shuttingDown });
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
        const incompleteCoverage = !!(out.res.note || out.res.searchFailures?.length || out.res.searchLog?.some((x) => /blocked|restricted|captcha/i.test(x.settled || '')));
        row.state = out.kind === 'ok' ? (incompleteCoverage ? 'partial' : 'done') : store.shuttingDown ? 'stopped' : out.kind === 'skipped' ? 'skipped' : 'crashed';
        row.endedAt = Date.now();
        row.note = out.kind === 'ok' ? (incompleteCoverage ? String(out.res.note || out.res.searchFailures.join('; ')).slice(0, 120) : '') : out.message.slice(0, 80);
        results[name] = attemptsResults[name];
        checkpoint.portals[name] = { state: row.state, attempts: row.attempts, durationMs: row.endedAt - row.startedAt, result: results[name] };
        saveCheckpoint(stateDir, dryRun, checkpoint);
        writeInterim();
        break;
      }
    }
  }

  /**
   * Fast portals are reported without waiting for the slowest one: after each
   * portal finishes, the report file is rewritten with everything known so far
   * (marked in progress), and data/approvals.json already holds every prepared job.
   */
  let interimAt = 0;
  function writeInterim() {
    if (!writeReport || Date.now() - interimAt < 5000) return;
    interimAt = Date.now();
    try {
      const done = Object.fromEntries(portals.filter((p) => results[p]).map((p) => [p, { ...results[p], awaitingApproval: [...(results[p].awaitingApproval || [])], insufficient: [...(results[p].insufficient || [])] }]));
      mergePipelineResults(done, { results: pipeline.results });
      const file = reporter.write(date, done, { dryRun, suffix: reportSuffix });
      fs.appendFileSync(file, `\n> ⏳ Run in progress — ${Object.keys(done).length}/${portals.length} portals finished (${[...rows.values()].filter((r) => r.state === 'running').map((r) => r.name).join(', ') || 'none'} still running). This file is rewritten when the run ends.\n`);
    } catch (err) {
      logger.debug(`[parallel] interim report skipped: ${err.message}`);
    }
  }

  onReady?.({ store, discovery, scheduler, shutdown: onSignal, pipeline });
  await Promise.all(units.map((u) => runUnit(u)));
  const discoveryDoneAt = Date.now();

  // Recover prepared jobs that were not rediscovered this run. A saved approval
  // alone is never proof that the job remains open: only live ATS reads enter
  // the normal matching/auto-approval path. This is deliberately bounded.
  if (process.env.JOBMAN_AUTO_APPLY === '1' && !store.shuttingDown) {
    const { parseAtsUrl, fetchPosting } = require('./core/ats');
    const pending = approvals.list({ status: 'pending' });
    const maxRecovery = Math.max(0, Number(process.env.JOBMAN_PENDING_RECOVERY_LIMIT) || 25);
    let recoveredPending = 0;
    for (const entry of pending) {
      if (recoveredPending >= maxRecovery || store.shuttingDown) break;
      if (pipeline.records.has(entry.key)) continue;
      const ref = parseAtsUrl(entry.url);
      const id = ref?.jobId || ref?.id;
      if (!ref?.ats || !id || !adapters[entry.portal]) continue;
      recoveredPending++;
      try {
        const posting = await fetchPosting({ ...ref, id, name: entry.company });
        const description = posting.text || '';
        if (description.length < 400) continue; // never auto-submit card-only evidence
        pipeline.offer(entry.portal, {
          title: posting.title || entry.title, company: entry.company,
          url: entry.url, location: posting.location || entry.location,
        }, { description, site: entry.site || entry.portal });
        if (!results[entry.portal]) results[entry.portal] = emptyResults('recovered pending approval');
      } catch (err) {
        logger.warn(`[parallel] pending approval ${entry.id}: live verification failed: ${err.message}`);
      }
    }
    logger.info(`[parallel] attempted live recovery of ${recoveredPending}/${pending.length} pending approvals`);
  }

  // ---- finish the pipeline: every offered job reaches a final state ----
  await pipeline.drain();
  if (waitApprovalsMs > 0 && !store.shuttingDown) {
    logger.info(`[parallel] discovery finished — waiting up to ${Math.round(waitApprovalsMs / 60000)} min for approvals (npm run review in another terminal)`);
    const until = Date.now() + waitApprovalsMs;
    while (Date.now() < until && !store.shuttingDown && pipeline.snapshot().stages.awaiting_approval) {
      await sleep(5000);
      pipeline.pollApprovals();
      await pipeline.drain();
    }
  }
  pipeline.pollApprovals();
  await pipeline.drain();
  pipeline.close();

  // ---- wrap up ----
  clearInterval(controlTimer);
  dash?.stop();
  if (installSignals) {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  for (const p of portals) results[p] = results[p] || emptyResults('not started — run stopped');
  const ordered = Object.fromEntries(portals.map((p) => [p, results[p]]));
  mergePipelineResults(ordered, pipeline);
  // Persist the merged results so --resume reports pipeline outcomes too.
  for (const p of portals) if (checkpoint.portals[p]) checkpoint.portals[p].result = ordered[p];
  saveCheckpoint(stateDir, dryRun, checkpoint);
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
    recoveredApprovals: recoveredApprovals.length,
    stopped: store.shuttingDown,
    discoveryMs: discoveryDoneAt - t0,
    pipeline: pipeline.metricsSummary(wallMs),
    carryOver: pipeline.carryOver,
    searchLogs: Object.fromEntries(portals.filter((p) => results[p]?.searchLog).map((p) => [p, results[p].searchLog])),
    diagnosticsFile,
    funnel: reconcileAll(ordered, { dryRun }).total,
    portalFunnel: reconcileAll(ordered, { dryRun }).perPortal,
  };

  if (browser && opts.closeBrowser !== false) {
    const needsKeepTabs = !dryRun && portals.some((p) => runner.KEEP_TABS_PORTALS.has(p));
    if (needsKeepTabs || browser.__jobmanAttached) await runner.keepBrowserOpen(browser);
    else await browser.close().catch(() => {});
  }
  releaseLock();

  if (writeReport) {
    const file = reporter.write(date, ordered, { dryRun, suffix: reportSuffix });
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

const pctStr = (x) => `${Math.round((x || 0) * 100)}%`;
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;

function parallelSection(m) {
  const lines = ['', '## Parallel run', '', `Wall-clock ${fmtDur(m.wallMs)} (discovery finished at ${fmtDur(m.discoveryMs || 0)}) · workers at start: discovery ${m.startLimits.discovery}, application ${m.startLimits.apply}, ATS ${m.limits.ats} · at end: discovery ${m.limits.discovery}, application ${m.limits.apply}`, ''];
  lines.push('| Portal | State | Attempts | Time | Unique listings | Unique / min | Eligible (full check) |', '|---|---|---|---|---|---|---|');
  const pp = m.pipeline?.perPortal || {};
  for (const [p, r] of Object.entries(m.portals)) {
    const uniq = m.portalFunnel?.[p]?.reviewed ?? '';
    const rate = uniq !== '' && r.ms ? (uniq / (r.ms / 60000)).toFixed(1) : '';
    lines.push(`| ${p} | ${r.state} | ${r.attempts} | ${fmtDur(r.ms)} | ${uniq} | ${rate} | ${pp[p]?.eligible ?? 0} |`);
  }
  lines.push('', `Cross-portal duplicate claims avoided: ${m.stats.claimConflicts} · pipeline cross-portal duplicates: ${m.pipeline?.counters?.crossPortalDupes ?? 0} · portal retries: ${m.retries} · interrupted attempts recovered: ${m.recovered}`);

  if (m.funnel) {
    const f = m.funnel;
    const c = f.counts;
    const rejected = c.rejected_location + c.rejected_experience + c.rejected_role + c.rejected_stale;
    lines.push('', '### Funnel (one set of definitions — the live dashboard uses the same function)', '');
    lines.push('| Stage | Count | Meaning |', '|---|---|---|');
    lines.push(`| Raw sightings | ${f.discovered} | every card seen in every search (same job counted per query) |`);
    lines.push(`| Unique discovered | ${f.discovered - f.duplicates} | after removing repeat sightings |`);
    lines.push(`| Out of discovery scope | ${f.outOfScope} | dropped by a cheap pre-filter (e.g. career-site roles outside India) |`);
    lines.push(`| Fully screened | ${f.reviewed - c.needs_enrichment} | reached a final decision on sufficient evidence |`);
    lines.push(`| Insufficient evidence | ${c.needs_enrichment} | full description could not be read — re-checked next run, not rejected |`);
    lines.push(`| Eligible | ${(m.pipeline?.counters?.eligible ?? 0) + (m.pipeline?.counters?.eligiblePrior ?? 0)} | passed every rule (${m.pipeline?.counters?.eligible ?? 0} newly screened this run, ${m.pipeline?.counters?.eligiblePrior ?? 0} prepared in an earlier run and still listed) |`);
    lines.push(`| Applications prepared | ${m.pipeline?.stages?.prepare?.count ?? 0} | resume and application channel prepared concurrently |`);
    lines.push(`| Awaiting approval | ${c.awaiting_approval} | prepared; approve by id |`);
    lines.push(`| Automatically approved | ${m.pipeline?.counters?.autoApproved ?? 0} | passed autonomous eligibility checks |`);
    lines.push(`| Auto-apply blocked | ${m.pipeline?.counters?.autoBlocked ?? 0} | requires additional evidence or manual action |`);
    lines.push(`| Verification queued | ${m.pipeline?.counters?.verificationQueued ?? 0} | evidence incomplete; not counted as rejected |`);
    lines.push(`| Manual actions queued | ${m.pipeline?.counters?.manualQueued ?? 0} | unsupported form, unknown answer or unconfirmed submission |`);
    lines.push(`| Attempted submissions | ${m.pipeline?.counters?.attempted ?? 0} | approved jobs sent to the portal |`);
    lines.push(`| Verified submissions | ${c.applied_confirmed} | portal showed success; screenshot kept |`);
    lines.push(`| Submitted, unverified | ${c.applied_unconfirmed} | never resubmitted |`);
    lines.push(`| Already applied | ${c.already_applied} | log / earlier run / another portal this run |`);
    lines.push(`| Needs you | ${c.manual_required} | CAPTCHA, login, external ATS, unanswered question |`);
    lines.push(`| Rejected | ${rejected} | location ${c.rejected_location} · experience ${c.rejected_experience} · role/stack ${c.rejected_role} · stale ${c.rejected_stale} |`);
    const restrictions = Object.entries(m.portals).filter(([, p]) => p.state !== 'done');
    lines.push(`| Portal restrictions / incomplete searches | ${restrictions.length} | ${restrictions.map(([p, v]) => `${p}: ${v.state}`).join('; ') || 'none'} |`);
    const followups = require('./core/followups').createFollowupStore().list().length;
    lines.push(`| Carried manual follow-ups | ${followups} | earlier candidates requiring a fresh posting and eligibility check; never submitted automatically |`);
  }

  const st = m.pipeline?.stages;
  if (st) {
    lines.push('', '### Pipeline stages (overlap with discovery)', '');
    lines.push('| Stage | Jobs | Workers | Peak busy | Queue wait p50 / p95 | Service p50 / p95 | Utilization | Throughput jobs/min |', '|---|---|---|---|---|---|---|---|');
    for (const s of Object.values(st)) lines.push(`| ${s.name} | ${s.count} | ${s.limit} | ${s.peak} | ${sec(s.waitP50)} / ${sec(s.waitP95)} | ${sec(s.runP50)} / ${sec(s.runP95)} | ${pctStr(s.utilization)} | ${(s.throughputPerMin || 0).toFixed(1)} |`);
    const e = m.pipeline.enricher;
    if (e) {
      lines.push('', `Enrichment: ${e.requests} requests · ${e.ok} descriptions read (${e.cacheHits} from cache) · ${e.failed} unavailable · ${e.blocked} blocked by a verification page · HTTP ${e.http} / browser ${e.browser}`);
      const bh = Object.entries(e.blockedHosts || {});
      if (bh.length) lines.push(`Paused hosts (verification page, not bypassed): ${bh.map(([h, why]) => `${h} (${why})`).join(', ')}`);
    }
    if (m.diagnosticsFile) lines.push(`Candidate-level structured diagnostics: \`${m.diagnosticsFile}\` (JSONL)`);
  }

  for (const [p, log] of Object.entries(m.searchLogs || {})) {
    if (!log.length) continue;
    const ms = log.map((x) => x.ms);
    const slow = [...log].sort((a, b) => b.ms - a.ms).slice(0, 3);
    const outcomes = log.reduce((a, x) => ((a[x.settled] = (a[x.settled] || 0) + 1), a), {});
    lines.push('', `### ${p} search profile`, '', `${log.length} searches · total ${sec(ms.reduce((a, b) => a + b, 0))} · p50 ${sec(pct(ms, 50))} · max ${sec(Math.max(...ms))} · settle outcomes ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    lines.push(`Slowest: ${slow.map((x) => `"${x.query}" @ ${x.city} ${sec(x.ms)}`).join(' · ')}`);
  }

  if (m.carryOver?.length) {
    lines.push('', '### Approved earlier, submitted this run', '');
    for (const c of m.carryOver) lines.push(`- **${c.title}** — ${c.company} — ${c.url} → ${c.outcome}${c.reason ? ` (${c.reason})` : ''}`);
  }
  if (m.controlLog.length) {
    lines.push('', 'Adaptive concurrency:');
    for (const c of m.controlLog) lines.push(`- +${fmtDur(c.at)} ${c.msg}`);
  }
  return `${lines.join('\n')}\n`;
}

function pct(list, p) {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

module.exports = { runParallel, buildUnits, mergeAttempts, acquireLock, loadCheckpoint, saveCheckpoint };
