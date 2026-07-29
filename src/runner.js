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
const logger = require('./core/logger');

// Priority: proven portals first, then newer boards. YourStory remains last —
// its public startup board is gone (media careers only).
const PORTALS_IN_PRIORITY_ORDER = [
  'instahyre',
  'naukri',
  'linkedin',
  'wellfound',
  'yourstory',
];
const ALL_PORTALS = [...PORTALS_IN_PRIORITY_ORDER];
const BOTS = {
  instahyre: require('./bots/instahyre'),
  naukri: require('./bots/naukri'),
  linkedin: require('./bots/linkedin'),
  wellfound: require('./bots/wellfound'),
  yourstory: require('./bots/yourstory'),
};

function emptyResults(note) {
  return { reviewed: 0, applied: [], manualApply: [], skipped: [], failed: [], note };
}

function loadProfile() {
  const file = path.join(__dirname, '..', 'config', 'candidate.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function runPortal(portalName, { dryRun = false } = {}) {
  const bot = BOTS[portalName];
  if (!bot) throw new Error(`unknown portal: ${portalName}`);

  const profile = loadProfile();
  dedup.load();

  let browser;
  try {
    ({ browser } = await browserCore.launch());
  } catch (err) {
    if (err instanceof browserCore.SkipPortalError) {
      logger.warn(`[${portalName}] skipped: ${err.message}`);
      return emptyResults(`skipped — ${err.message}`);
    }
    logger.error(`[${portalName}] browser launch failed: ${err.message}`);
    return emptyResults(`crashed — browser launch failed: ${err.message}`);
  }

  const newPage = async () => {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(45_000);
    page.setDefaultTimeout(30_000);
    return page;
  };

  try {
    return await bot.run({ profile, dedup, dryRun, newPage, browser });
  } catch (err) {
    if (err instanceof browserCore.SkipPortalError) {
      logger.warn(`[${portalName}] skipped: ${err.message}`);
      return emptyResults(`skipped — ${err.message}`);
    }
    logger.error(`[${portalName}] crashed: ${err.message}`);
    return emptyResults(`crashed — ${err.message}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runAll({ dryRun = false, portals = PORTALS_IN_PRIORITY_ORDER } = {}) {
  const results = {};
  for (const portalName of portals) {
    logger.info(`\n=== ${portalName} ===`);
    try {
      results[portalName] = await runPortal(portalName, { dryRun });
    } catch (err) {
      // Defensive: runPortal already catches, but never let one portal abort the run
      logger.error(`[${portalName}] crashed: ${err.message}`);
      results[portalName] = emptyResults(`crashed — ${err.message}`);
    }
  }

  const date = dedup.istDate();
  const reportFile = reporter.write(date, results, { dryRun });
  logger.info(`\nReport written to ${reportFile}`);

  return results;
}

module.exports = { runAll, runPortal, loadProfile, PORTALS_IN_PRIORITY_ORDER, ALL_PORTALS };
