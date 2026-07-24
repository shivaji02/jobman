/**
 * node-cron wiring — runs all portals daily at 7:00 AM IST.
 */
const cron = require('node-cron');
const { runAll } = require('./runner');
const logger = require('./core/logger');

function start({ dryRun = false } = {}) {
  logger.info(`[scheduler] jobman scheduled for 07:00 Asia/Kolkata daily${dryRun ? ' (dry run)' : ''}`);
  const task = cron.schedule(
    '0 7 * * *',
    () => {
      runAll({ dryRun }).catch((err) =>
        logger.error(`[scheduler] run failed: ${err.message}`)
      );
    },
    { timezone: 'Asia/Kolkata' }
  );
  return task;
}

module.exports = { start };
