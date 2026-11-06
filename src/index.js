#!/usr/bin/env node
require('dotenv').config();
const { Command } = require('commander');
const { runAll, runPortal, ALL_PORTALS } = require('./runner');
const reporter = require('./core/reporter');
const dedup = require('./core/dedup');
const scheduler = require('./scheduler');
const logger = require('./core/logger');

const program = new Command();
program.name('jobman').description('Automated job application bot');

program
  .command('run-all')
  .description(`run every portal in priority order (${ALL_PORTALS.join(', ')})`)
  .option('--dry-run', 'do everything except click Apply; log what would happen', false)
  .option('--portals <list>', 'comma-separated subset, e.g. linkedin,indeed')
  .action(async (opts) => {
    const portals = opts.portals ? opts.portals.split(',').map((p) => p.trim()).filter((p) => ALL_PORTALS.includes(p)) : undefined;
    await runAll({ dryRun: opts.dryRun, ...(portals && portals.length ? { portals } : {}) });
  });

program
  .command('parallel')
  .description('run every portal concurrently with a shared job store, live dashboard, checkpoints and graceful Ctrl+C')
  .option('--dry-run', 'do everything except submit; log what would happen', false)
  .option('--portals <list>', 'comma-separated subset, e.g. naukri,linkedin')
  .option('--resume', "skip portals already finished in today's checkpoint (after Ctrl+C / crash)", false)
  .option('--discovery-workers <n>', 'portals running at once (default: 8 on this class of Mac)', (v) => parseInt(v, 10))
  .option('--apply-workers <n>', 'submissions in flight across all portals (default 3)', (v) => parseInt(v, 10))
  .option('--apply-workers-max <n>', 'ceiling for adaptive scaling of application workers (default 5)', (v) => parseInt(v, 10))
  .option('--ats-workers <n>', 'employer postings handled at once in the careers channel (default 3)', (v) => parseInt(v, 10))
  .option('--retries <n>', 'retries for a crashed portal, with exponential backoff (default 2)', (v) => parseInt(v, 10))
  .option('--no-adaptive', 'keep worker limits fixed (no resource-based scaling)')
  .option('--no-dashboard', 'plain log output instead of the live dashboard')
  .action(async (opts) => {
    const { runParallel } = require('./parallel');
    const portals = opts.portals ? opts.portals.split(',').map((p) => p.trim()).filter((p) => ALL_PORTALS.includes(p)) : undefined;
    const limits = {};
    if (opts.discoveryWorkers) limits.discovery = opts.discoveryWorkers;
    if (opts.applyWorkers) limits.apply = opts.applyWorkers;
    if (opts.applyWorkersMax) limits.applyMax = opts.applyWorkersMax;
    if (opts.atsWorkers) limits.ats = opts.atsWorkers;
    await runParallel({
      dryRun: opts.dryRun,
      resume: opts.resume,
      adaptive: opts.adaptive,
      dashboard: opts.dashboard,
      limits,
      ...(Number.isFinite(opts.retries) ? { portalRetries: opts.retries } : {}),
      ...(portals && portals.length ? { portals } : {}),
    });
  });

program
  .command('run <portal>')
  .description('run a single portal: google | careers | instahyre | naukri | linkedin | talent | foundit | indeed | wellfound | yourstory')
  .option('--dry-run', 'do everything except click Apply; log what would happen', false)
  .action(async (portal, opts) => {
    if (!ALL_PORTALS.includes(portal)) {
      logger.error(`unknown portal "${portal}" — choose one of: ${ALL_PORTALS.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    const result = await runPortal(portal, { dryRun: opts.dryRun });
    const date = dedup.istDate();
    const reportFile = reporter.write(date, { [portal]: result }, { dryRun: opts.dryRun });
    logger.info(`Report written to ${reportFile}`);
    console.log(require('./core/summary').formatRunSummary({ [portal]: result }, { dryRun: opts.dryRun }));
  });

program
  .command('schedule')
  .description('start the node-cron daemon (runs run-all daily at 07:00 IST)')
  .option('--dry-run', 'run scheduled runs in dry-run mode', false)
  .action((opts) => {
    scheduler.start({ dryRun: opts.dryRun });
  });

program
  .command('report [date]')
  .description('print an existing daily report (defaults to today, IST)')
  .action((date) => {
    const targetDate = date || dedup.istDate();
    const content = reporter.read(targetDate);
    if (!content) {
      logger.error(`no report found for ${targetDate}`);
      process.exitCode = 1;
      return;
    }
    logger.info(content);
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error(err && err.message ? err.message : String(err));
  process.exitCode = 1;
});
