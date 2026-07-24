/**
 * node-cron wiring — runs all portals daily at 7:00 AM IST.
 */
const cron = require('node-cron');
const { runAll } = require('./runner');

function start({ dryRun = false } = {}) {
  console.log(`[scheduler] jobman scheduled for 07:00 Asia/Kolkata daily${dryRun ? ' (dry run)' : ''}`);
  const task = cron.schedule(
    '0 7 * * *',
    () => {
      runAll({ dryRun }).catch((err) => console.error('[scheduler] run failed:', err));
    },
    { timezone: 'Asia/Kolkata' }
  );
  return task;
}

module.exports = { start };
