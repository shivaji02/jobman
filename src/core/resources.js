/**
 * Host resource sampling for adaptive concurrency (tuned for macOS / Apple Silicon).
 *
 * - CPU: busy fraction across all cores from os.cpus() tick deltas.
 * - Memory: on macOS `os.freemem()` reports only truly free pages (often a few
 *   hundred MB on a healthy machine, because macOS keeps inactive/cached pages),
 *   so it is useless as a pressure signal. We use `kern.memorystatus_level`
 *   (the % of memory the kernel considers available; the same signal Activity
 *   Monitor's pressure graph is derived from). Elsewhere we fall back to freemem.
 * - Chrome: RSS + CPU of the Chrome processes using the jobman profile (`ps`),
 *   never the user's everyday browser.
 */
const os = require('os');
const { execFile } = require('child_process');

function execText(cmd, args, timeout = 3000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

function createSampler({ profileDir = '' } = {}) {
  let prev = cpuTimes();
  const cores = os.cpus().length;
  const totalMemMb = Math.round(os.totalmem() / 1048576);

  async function memAvailablePct() {
    if (process.platform === 'darwin') {
      const out = (await execText('sysctl', ['-n', 'kern.memorystatus_level'])).trim();
      const n = parseInt(out, 10);
      if (Number.isFinite(n)) return n;
    }
    return Math.round((os.freemem() / os.totalmem()) * 100);
  }

  async function chromeStats() {
    if (!profileDir || process.platform === 'win32') return { procs: 0, rssMb: 0, cpuPct: 0 };
    const out = await execText('ps', ['-axo', 'rss=,pcpu=,command=']);
    let procs = 0;
    let rssKb = 0;
    let cpu = 0;
    for (const line of out.split('\n')) {
      if (!line.includes(profileDir)) continue;
      const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+/);
      if (!m) continue;
      procs++;
      rssKb += Number(m[1]);
      cpu += Number(m[2]);
    }
    return { procs, rssMb: Math.round(rssKb / 1024), cpuPct: Math.round(cpu) };
  }

  async function sample() {
    const now = cpuTimes();
    const dTotal = now.total - prev.total;
    const dIdle = now.idle - prev.idle;
    prev = now;
    const cpuBusy = dTotal > 0 ? 1 - dIdle / dTotal : 0;
    const [memPct, chrome] = await Promise.all([memAvailablePct(), chromeStats()]);
    return {
      at: Date.now(),
      cores,
      totalMemMb,
      cpuPct: Math.round(cpuBusy * 100),
      load1: os.loadavg()[0],
      memAvailablePct: memPct,
      nodeRssMb: Math.round(process.memoryUsage().rss / 1048576),
      chrome,
    };
  }

  return { sample, cores, totalMemMb };
}

/**
 * Starting limits scaled to the machine. The user's brief asks for 8 discovery /
 * 3 application / 2–3 ATS workers; we keep those on a machine that can carry
 * them and scale down on smaller ones (each discovery worker = ≥1 Chrome tab,
 * ~150–300 MB RSS).
 */
function recommendedLimits({ cores = os.cpus().length, totalMemMb = Math.round(os.totalmem() / 1048576) } = {}) {
  const memBound = Math.max(2, Math.floor((totalMemMb - 6144) / 1024)); // leave ~6 GB for macOS + apps
  return {
    discovery: Math.max(2, Math.min(8, Math.ceil(cores / 2), memBound)),
    apply: Math.max(1, Math.min(3, Math.floor(cores / 4))),
    ats: Math.max(1, Math.min(3, Math.floor(cores / 4))),
    http: Math.max(4, Math.min(16, cores)),
  };
}

module.exports = { createSampler, recommendedLimits };
