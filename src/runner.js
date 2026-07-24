/**
 * Shared run orchestration used by both the CLI and the scheduler.
 *
 * Each portal is wrapped in try/catch so one crashing bot doesn't kill the
 * run (CLAUDE.md requirement #9). SkipPortalError from a bot (login wall /
 * CAPTCHA) is treated as a clean "portal skipped" outcome, not a crash.
 */
const fs = require('fs');
const path = require('path');
const dedup = require('./core/dedup');
const reporter = require('./core/reporter');
const browserCore = require('./core/browser');

// yourstory is addressable via `jobman run yourstory` (it reports why it's
// disabled) but excluded from the default run-all/scheduler order — its job
// board no longer exists (see src/bots/yourstory.js).
const PORTALS_IN_PRIORITY_ORDER = ['instahyre', 'naukri', 'linkedin'];
const ALL_PORTALS = [...PORTALS_IN_PRIORITY_ORDER, 'yourstory'];
const BOTS = {
  instahyre: require('./bots/instahyre'),
  naukri: require('./bots/naukri'),
  linkedin: require('./bots/linkedin'),
  yourstory: require('./bots/yourstory'),
};

function loadProfile() {
  const file = path.join(__dirname, '..', 'config', 'candidate.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function runPortal(portalName, { dryRun = false } = {}) {
  const bot = BOTS[portalName];
  if (!bot) throw new Error(`unknown portal: ${portalName}`);

  const profile = loadProfile();
  dedup.load();

  const { browser, newPage } = await browserCore.launch();
  try {
    return await bot.run({ profile, dedup, dryRun, newPage, browser });
  } catch (err) {
    if (err instanceof browserCore.SkipPortalError) {
      console.warn(`[${portalName}] skipped: ${err.message}`);
      return { reviewed: 0, applied: [], skipped: [], failed: [], note: `skipped — ${err.message}` };
    }
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runAll({ dryRun = false, portals = PORTALS_IN_PRIORITY_ORDER } = {}) {
  const results = {};
  for (const portalName of portals) {
    console.log(`\n=== ${portalName} ===`);
    try {
      results[portalName] = await runPortal(portalName, { dryRun });
    } catch (err) {
      console.error(`[${portalName}] crashed: ${err.message}`);
      results[portalName] = { reviewed: 0, applied: [], skipped: [], failed: [], note: `crashed — ${err.message}` };
    }
  }

  const date = dedup.istDate();
  const reportFile = reporter.write(date, results, { dryRun });
  console.log(`\nReport written to ${reportFile}`);

  return results;
}

module.exports = { runAll, runPortal, loadProfile, PORTALS_IN_PRIORITY_ORDER, ALL_PORTALS };
