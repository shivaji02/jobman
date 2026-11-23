/**
 * Live terminal dashboard for the parallel runner (plain ANSI, no dependencies).
 *
 * Redraws in place once a second when stdout is a TTY. Log lines (logger +
 * console.*) are captured into a short tail shown under the panel and still
 * written to logs/<date>.log in full. On a non-TTY (cron, pipes) it prints one
 * compact status line every 30 s instead.
 */
const logger = require('./logger');
const terminal = require('./terminal');

const ESC = '\x1b[';
const clr = (code, s) => (process.stdout.isTTY ? `${ESC}${code}m${s}${ESC}0m` : s);
const bold = (s) => clr('1', s);
const dim = (s) => clr('2', s);
const green = (s) => clr('32', s);
const yellow = (s) => clr('33', s);
const red = (s) => clr('31', s);
const cyan = (s) => clr('36', s);

const pad = (s, n) => {
  const str = String(s);
  // eslint-disable-next-line no-control-regex
  const visible = str.replace(/\x1b\[[0-9;]*m/g, '').length;
  return visible >= n ? str : str + ' '.repeat(n - visible);
};
const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

function createDashboard({ store, scheduler, getResources, dryRun = false, stream = process.stdout, intervalMs = 1000 } = {}) {
  const screen = terminal.createScreen({ stream });
  const tty = screen.interactive;
  const tail = [];
  const TAIL = 50; // kept in memory; the panel shows the newest 3–15 that fit
  const startedAt = Date.now();
  let timer = null;
  let lastPlain = 0;
  let stopped = false;
  const orig = { log: console.log, warn: console.warn, error: console.error };

  function push(line) {
    for (const l of String(line).split('\n')) {
      if (!l.trim()) continue;
      tail.push(l.replace(/^\[\d{4}-\d\d-\d\dT([\d:]+)\.\d+Z\]/, '[$1]').slice(0, 160));
    }
    while (tail.length > TAIL) tail.shift();
  }

  function render() {
    const s = store.stats;
    const r = (getResources && getResources()) || {};
    const lim = scheduler.limits();
    const elapsed = Date.now() - startedAt;
    const perMin = s.confirmed / Math.max(1, elapsed / 60_000);
    const L = [];
    L.push(bold(`JOBMAN parallel${dryRun ? yellow(' (DRY RUN — nothing is submitted)') : ''}`) + dim(`  elapsed ${fmtDur(elapsed)}${store.shuttingDown ? red('  ⏹ shutting down — finishing in-flight work') : ''}`));
    L.push(
      `Workers  discovery ${bold(`${scheduler.activePortals()}/${lim.discovery}`)}` +
        `  application ${bold(`${store.applySlots.active}/${store.applySlots.limit}`)} ${dim(`(queued ${store.applySlots.waiting})`)}` +
        `  portals queued ${scheduler.queued()}  retries ${scheduler.retries()}`
    );
    // Live counts come from the same reconcile() the final report uses (2026-11-09: the
    // dashboard said "eligible 0" while the report listed 17 prepared jobs, because
    // "eligible" was counted only after the approval gate).
    const live = scheduler.live ? scheduler.live() : null;
    const pipe = scheduler.pipeline ? scheduler.pipeline() : null;
    const approval = scheduler.approvalCounts ? scheduler.approvalCounts() : null;
    if (approval) {
      L.push(`Approval ${bold(`prepared ${approval.prepared}`)}  pending ${approval.pending}  approved ${approval.approved}  submitting ${approval.submitting}  submitted ${approval.submitted}  confirmed ${green(approval.confirmed)}  unconfirmed ${approval.unconfirmed}  already ${approval.already_applied}  needs user ${yellow(approval.needs_user)}  failed ${red(approval.failed)}  rejected ${approval.rejected}`);
    }
    if (live) {
      const t = live.total;
      const c = t.counts;
      const pc = pipe?.counters || {};
      const stages = pipe?.stages || {};
      const queued = (stages.queued || 0) + (stages.enriching || 0) + (stages.evaluating || 0) + (stages.preparing || 0);
      L.push(
        `Funnel   sightings ${bold(t.discovered)}  unique ${bold(t.discovered - t.duplicates)}  screened ${bold(t.reviewed - c.needs_enrichment)}` +
          `  ${yellow(`insufficient ${c.needs_enrichment}`)}  eligible ${bold((pc.eligible || 0) + (pc.eligiblePrior || 0))}${pc.eligibleCardOnly ? dim(` (${pc.eligibleCardOnly} card-only)`) : ''}`
      );
      L.push(
        `Apply    in pipeline ${bold(queued)}  ${cyan(`awaiting approval ${c.awaiting_approval + (stages.awaiting_approval || 0)}`)}  ${dryRun ? 'simulated (dry run, not submitted)' : 'attempted'} ${bold(pc.attempted || 0)}` +
          `  ${green(`verified ${c.applied_confirmed}`)}  unverified ${c.applied_unconfirmed}  already ${c.already_applied}  ${yellow(`needs you ${c.manual_required}`)}  ${red(`failed ${c.failed_technical}`)}  ${yellow(`blocked by site ${c.blocked_by_site || 0}`)}`
      );
      L.push(
        `Stages   enrichment ${pc.enrichedOk || 0} read / ${pc.enrichFailed || 0} unavailable  preparing ${stages.preparing || 0}  ${dryRun ? 'simulated' : 'submitted'} ${pc.attempted || 0}  confirmed ${c.applied_confirmed}${dryRun ? dim('  (dry run: no real submissions)') : ''}`
      );
      L.push(
        `Rejected ${c.rejected_location + c.rejected_experience + c.rejected_role + c.rejected_stale}` +
          dim(`  location ${c.rejected_location} · experience ${c.rejected_experience} · role/stack ${c.rejected_role} · stale ${c.rejected_stale}`) +
          dim(`   portal restrictions: ${scheduler.portalRows().filter((p) => ['partial', 'skipped', 'crashed', 'stopped'].includes(p.state)).map((p) => `${p.name} ${p.state}${p.note ? ` (${p.note})` : ''}`).join('; ') || 'none reported'}`)
      );
      if (scheduler.followups) L.push(`Follow-ups ${scheduler.followups()} unresolved from earlier runs · recheck before preparing; never auto-submitted`);
    } else {
      L.push(
        `Jobs     seen ${bold(s.seen)}  screened ${bold(s.screened)}  claimed ${bold(s.eligible)}` +
          `  ${green(`confirmed ${s.confirmed}`)}  already ${s.alreadyApplied}  ${yellow(`needs you ${s.needsUser}`)}  ${red(`failed ${s.failed}`)}`
      );
    }
    L.push(`Rate     ${bold(perMin.toFixed(2))} confirmed/min  ·  claim conflicts avoided ${s.claimConflicts}${dryRun ? dim('  (dry run: nothing is submitted)') : ''}`);
    const chrome = r.chrome || {};
    L.push(
      `Mac      CPU ${bold(`${r.cpuPct ?? '-'}%`)} (${r.cores || '?'} cores, load ${r.load1 != null ? r.load1.toFixed(1) : '-'})` +
        `  mem available ${bold(`${r.memAvailablePct ?? '-'}%`)} of ${r.totalMemMb ? `${Math.round(r.totalMemMb / 1024)} GB` : '?'}` +
        `  Chrome ${chrome.procs || 0} procs ${chrome.rssMb || 0} MB  tabs ${scheduler.tabs()}  node ${r.nodeRssMb || 0} MB`
    );
    L.push('');
    L.push(dim(`${pad('Worker', 11)}${pad('State', 13)}${pad('Time', 8)}${pad('Seen', 6)}${pad('Uniq', 6)}${pad('Elig', 6)}${pad('Wait', 6)}${pad('Rej', 6)}${pad('You', 5)}${pad('Fail', 5)}${pad('Uniq/m', 8)}${pad('Conf', 6)}Note`));
    for (const p of scheduler.portalRows()) {
      const lp = live?.perPortal?.[p.name];
      const pp = pipe?.perPortal?.[p.name] || {};
      const ps = lp
        ? {
            seen: lp.discovered,
            screened: lp.reviewed,
            eligible: pp.eligible || 0,
            awaiting: lp.counts.awaiting_approval,
            confirmed: lp.counts.applied_confirmed,
            rejected: lp.counts.rejected_location + lp.counts.rejected_experience + lp.counts.rejected_role + lp.counts.rejected_stale,
            needsUser: lp.counts.manual_required,
            failed: lp.counts.failed_technical + (lp.counts.blocked_by_site || 0), // technical + blocked by site (both retried)
          }
        : s.perPortal[p.name] || {};
      const st = p.state === 'running' ? cyan(p.state) : p.state === 'done' ? green(p.state) : p.state === 'failed' || p.state === 'crashed' ? red(p.state) : p.state === 'backoff' || p.state === 'partial' || p.state === 'skipped' ? yellow(p.state) : dim(p.state);
      const time = p.startedAt ? fmtDur((p.endedAt || Date.now()) - p.startedAt) : '';
      const elapsedMin = p.startedAt ? Math.max(1 / 60, ((p.endedAt || Date.now()) - p.startedAt) / 60_000) : 0;
      L.push(
        `${pad(p.name, 11)}${pad(st, 13)}${pad(time, 8)}${pad(ps.seen || 0, 6)}${pad(ps.screened || 0, 6)}${pad(ps.eligible || 0, 6)}${pad(ps.awaiting || 0, 6)}${pad(ps.rejected || 0, 6)}${pad(ps.needsUser || 0, 5)}${pad(ps.failed || 0, 5)}${pad(((ps.screened || 0) / elapsedMin || 0).toFixed(1), 8)}${pad(ps.confirmed || 0, 6)}${dim(String(p.note || '').slice(0, 60))}`
      );
    }
    // Log section: the newest entries that fit below the panel (3–15 lines).
    const footer = 1;
    const room = Math.max(3, Math.min(15, screen.rowsAvailable() - L.length - 2 - footer));
    L.push('');
    L.push(dim('— recent log —'));
    for (const t of tail.slice(-room)) L.push(dim(t));
    L.push(dim('Ctrl+C once: stop gracefully (finish in-flight applications) · twice: stop now'));
    return L;
  }

  /** One compact line for non-interactive output (cron, pipes, CI). */
  function plainStatus() {
    const s = store.stats;
    const live = scheduler.live ? scheduler.live().total : null;
    const pc = scheduler.pipeline ? scheduler.pipeline().counters : {};
    return live
      ? `[status] ${fmtDur(Date.now() - startedAt)} portals ${scheduler.activePortals()} running/${scheduler.queued()} queued · unique ${live.discovered - live.duplicates} insufficient ${live.counts.needs_enrichment} eligible ${pc.eligible || 0} awaiting-approval ${live.counts.awaiting_approval} verified ${live.counts.applied_confirmed} needs-you ${live.counts.manual_required} failed ${live.counts.failed_technical} blocked ${live.counts.blocked_by_site || 0}${dryRun ? ' (dry run)' : ''}`
      : `[status] ${fmtDur(Date.now() - startedAt)} seen ${s.seen} confirmed ${s.confirmed}`;
  }

  function draw() {
    if (stopped) return;
    if (tty) {
      screen.paint(render());
    } else if (Date.now() - lastPlain > 30_000) {
      lastPlain = Date.now();
      orig.log(plainStatus());
    }
  }

  function start() {
    if (tty) {
      logger.setSink((level, entry) => push(entry));
      console.log = (...a) => push(a.join(' '));
      console.warn = (...a) => push(a.join(' '));
      console.error = (...a) => push(a.join(' '));
      screen.enter(draw); // alternate screen: one dashboard for the whole session
    }
    timer = setInterval(draw, tty ? intervalMs : 5000);
    timer.unref?.();
    draw();
  }

  /**
   * Stop once and restore the terminal: leave the alternate screen, put back the
   * console, and print ONE final summary into the normal scrollback.
   */
  function stop() {
    if (stopped) return;
    if (timer) clearInterval(timer);
    timer = null;
    if (tty) {
      const finalLines = render();
      stopped = true;
      screen.leave();
      logger.setSink(null);
      Object.assign(console, orig);
      for (const l of finalLines) orig.log(l);
    } else {
      stopped = true;
      orig.log(plainStatus());
    }
  }

  return { start, stop, render, push, screen };
}

module.exports = { createDashboard, fmtDur };
