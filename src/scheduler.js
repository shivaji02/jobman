/**
 * node-cron wiring — runs all portals daily at 7:00 AM IST (parallel runner + application pipeline).
 */
const cron = require('node-cron');
const { runParallel } = require('./parallel');
const logger = require('./core/logger');

function start({ dryRun = false } = {}) {
  logger.info(`[scheduler] jobman scheduled for 07:00 Asia/Kolkata daily${dryRun ? ' (dry run)' : ''}`);
  const task = cron.schedule(
    '0 7 * * *',
    () => {
      // Same pipeline as `npm run parallel` (enrichment, approval queue, metrics); no live dashboard under cron.
      runParallel({ dryRun, dashboard: false }).catch((err) =>
        logger.error(`[scheduler] run failed: ${err.message}`)
      );
    },
    { timezone: 'Asia/Kolkata' }
  );
  return task;
}

module.exports = { start };
