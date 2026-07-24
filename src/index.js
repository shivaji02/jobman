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
  .description('run every active portal in priority order (instahyre, naukri, linkedin — yourstory is disabled, see src/bots/yourstory.js)')
  .option('--dry-run', 'do everything except click Apply; log what would happen', false)
  .action(async (opts) => {
    await runAll({ dryRun: opts.dryRun });
  });

program
  .command('run <portal>')
  .description('run a single portal: instahyre | naukri | linkedin | yourstory (disabled)')
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
