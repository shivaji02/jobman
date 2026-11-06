/**
 * Live terminal dashboard for the parallel runner (plain ANSI, no dependencies).
 *
 * Redraws in place once a second when stdout is a TTY. Log lines (logger +
 * console.*) are captured into a short tail shown under the panel and still
 * written to logs/<date>.log in full. On a non-TTY (cron, pipes) it prints one
 * compact status line every 30 s instead.
 */
const logger = require('./logger');

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
  const tty = !!stream.isTTY && process.env.JOBMAN_NO_DASHBOARD !== 'true';
  const tail = [];
  const TAIL = 8;
  const startedAt = Date.now();
  let timer = null;
  let lastPlain = 0;
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
    L.push(
      `Jobs     seen ${bold(s.seen)}  screened ${bold(s.screened)}  eligible ${bold(s.eligible)}` +
        `  ${green(`confirmed ${s.confirmed}`)}${s.confirmed !== s.confirmedWithEvidence ? dim(` (${s.confirmedWithEvidence} w/ evidence)`) : ''}` +
        `  already ${s.alreadyApplied}  ${yellow(`needs you ${s.needsUser}`)}  ${red(`failed ${s.failed}`)}`
    );
    L.push(`Rate     ${bold(perMin.toFixed(2))} confirmed/min  ·  claim conflicts avoided ${s.claimConflicts}${dryRun ? dim('  (dry run: eligible = would apply)') : ''}`);
    const chrome = r.chrome || {};
    L.push(
      `Mac      CPU ${bold(`${r.cpuPct ?? '-'}%`)} (${r.cores || '?'} cores, load ${r.load1 != null ? r.load1.toFixed(1) : '-'})` +
        `  mem available ${bold(`${r.memAvailablePct ?? '-'}%`)} of ${r.totalMemMb ? `${Math.round(r.totalMemMb / 1024)} GB` : '?'}` +
        `  Chrome ${chrome.procs || 0} procs ${chrome.rssMb || 0} MB  tabs ${scheduler.tabs()}  node ${r.nodeRssMb || 0} MB`
    );
    const rej = Object.entries(s.rejectedBy).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');
    L.push(`Rejected ${s.rejected}${rej ? dim(`  ${rej}`) : ''}`);
    L.push('');
    L.push(dim(`${pad('Portal', 11)}${pad('State', 13)}${pad('Time', 8)}${pad('Seen', 6)}${pad('Screen', 7)}${pad('Elig', 6)}${pad('Conf', 6)}${pad('Rej', 6)}${pad('You', 5)}${pad('Fail', 5)}Note`));
    for (const p of scheduler.portalRows()) {
      const ps = s.perPortal[p.name] || {};
      const st = p.state === 'running' ? cyan(p.state) : p.state === 'done' ? green(p.state) : p.state === 'failed' || p.state === 'crashed' ? red(p.state) : p.state === 'backoff' ? yellow(p.state) : dim(p.state);
      const time = p.startedAt ? fmtDur((p.endedAt || Date.now()) - p.startedAt) : '';
      L.push(
        `${pad(p.name, 11)}${pad(st, 13)}${pad(time, 8)}${pad(ps.seen || 0, 6)}${pad(ps.screened || 0, 7)}${pad(ps.eligible || 0, 6)}${pad(ps.confirmed || 0, 6)}${pad(ps.rejected || 0, 6)}${pad(ps.needsUser || 0, 5)}${pad(ps.failed || 0, 5)}${dim(String(p.note || '').slice(0, 60))}`
      );
    }
    L.push('');
    L.push(dim('— recent log —'));
    for (const t of tail) L.push(dim(t));
    L.push(dim('Ctrl+C once: stop gracefully (finish in-flight applications) · twice: stop now'));
    return L;
  }

  function draw() {
    if (tty) {
      const lines = render();
      const cols = stream.columns || 140;
      stream.write(`${ESC}H${ESC}2J${lines.map((l) => l.slice(0, cols + 40)).join('\n')}\n`);
    } else if (Date.now() - lastPlain > 30_000) {
      lastPlain = Date.now();
      const s = store.stats;
      orig.log(
        `[status] ${fmtDur(Date.now() - startedAt)} portals ${scheduler.activePortals()} running/${scheduler.queued()} queued · seen ${s.seen} screened ${s.screened} eligible ${s.eligible} confirmed ${s.confirmed} needs-you ${s.needsUser} failed ${s.failed} · apply slots ${store.applySlots.active}/${store.applySlots.limit}`
      );
    }
  }

  function start() {
    if (tty) {
      logger.setSink((level, entry) => push(entry));
      console.log = (...a) => push(a.join(' '));
      console.warn = (...a) => push(a.join(' '));
      console.error = (...a) => push(a.join(' '));
      stream.write(`${ESC}?25l`); // hide cursor
    }
    timer = setInterval(draw, tty ? intervalMs : 5000);
    timer.unref?.();
    draw();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (tty) {
      draw();
      stream.write(`${ESC}?25h`);
      logger.setSink(null);
      Object.assign(console, orig);
    }
  }

  return { start, stop, render, push };
}

module.exports = { createDashboard, fmtDur };
