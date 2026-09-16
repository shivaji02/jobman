/**
 * Shared run orchestration used by both the CLI and the scheduler.
 *
 * Each portal is wrapped in try/catch so one crashing bot doesn't kill the
 * run (CLAUDE.md requirement #9). SkipPortalError from a bot (login wall /
 * CAPTCHA) is treated as a clean "portal skipped" outcome, not a crash.
 *
 * Successful apply tabs are closed by bots. Manual-apply / failed tabs stay
 * open — browser is disconnected (not closed) at the end so Chrome survives.
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

/** Portals that leave manual-apply / failed tabs open for user review. */
const KEEP_TABS_PORTALS = new Set(['naukri', 'linkedin', 'wellfound']);

let activeKeepBrowser = null;
let sigintHookInstalled = false;

function emptyResults(note) {
  return { reviewed: 0, applied: [], manualApply: [], skipped: [], failed: [], note };
}

function loadProfile() {
  const file = path.join(__dirname, '..', 'config', 'candidate.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function installSigintHook() {
  if (sigintHookInstalled) return;
  sigintHookInstalled = true;
  process.on('SIGINT', async () => {
    console.log('\n\nClosing browser (Ctrl+C)...');
    const browser = activeKeepBrowser;
    activeKeepBrowser = null;
    if (browser) {
      try {
        await browser.close();
      } catch {
        // may already be disconnected
      }
    }
    process.exit(0);
  });
}

/** Aggregate open-tab summary across portals at end of full run. */
function printRunTabSummary(resultsByPortal) {
  const manualApply = [];
  const failed = [];

  for (const [portal, r] of Object.entries(resultsByPortal || {})) {
    for (const j of r.manualApply || []) {
      manualApply.push({ portal, ...j });
    }
    for (const j of r.failed || []) {
      failed.push({ portal, ...j });
    }
  }

  const openCount = manualApply.length + failed.length;
  const appliedCount = Object.values(resultsByPortal || {}).reduce(
    (n, r) => n + ((r.applied || []).length),
    0
  );

  console.log(`\n${'='.repeat(60)}`);
  console.log('OPEN TABS SUMMARY');
  console.log(`${'='.repeat(60)}`);
  console.log(`✅ Applied (closed automatically): ${appliedCount}`);

  console.log(`\n⚠️  MANUAL APPLY (${manualApply.length} tabs) — Ready to apply manually:`);
  if (!manualApply.length) {
    console.log('  (none)');
  } else {
    manualApply.forEach((tab, idx) => {
      const url = tab.companyUrl || tab.url || '';
      console.log(`\n  ${idx + 1}. [${tab.portal}] ${tab.title} @ ${tab.company}`);
      console.log(`     URL: ${url}`);
      if (tab.resume) console.log(`     Resume: ${tab.resume}`);
    });
  }

  if (failed.length) {
    console.log(`\n❌ FAILED (${failed.length} tabs) — Inspect & retry manually:`);
    failed.forEach((tab, idx) => {
      console.log(`\n  ${idx + 1}. [${tab.portal}] ${tab.title} @ ${tab.company}`);
      if (tab.url) console.log(`     URL: ${tab.url}`);
      if (tab.reason) console.log(`     Error: ${tab.reason}`);
    });
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`ℹ️  ${openCount} tabs left OPEN`);
  console.log('→ Go through each tab and apply/inspect manually');
  console.log('→ Close tab when done');
  console.log('→ Press Ctrl+C to shutdown browser when all done');
  console.log(`${'='.repeat(60)}\n`);
}

/** Detach Puppeteer from Chrome so tabs survive process exit. */
async function keepBrowserOpen(browser) {
  activeKeepBrowser = browser;
  installSigintHook();
  try {
    const proc = browser.process?.();
    if (proc && typeof proc.unref === 'function') proc.unref();
  } catch {
    // ignore
  }
  try {
    browser.disconnect();
  } catch {
    // ignore
  }
  console.log(
    '\nChrome left open with manual-apply / failed tabs.\n' +
      'Close those tabs yourself when finished, then press Ctrl+C if this process is still attached.\n'
  );
}

async function runPortal(portalName, { dryRun = false, browser, newPage } = {}) {
  const bot = BOTS[portalName];
  if (!bot) throw new Error(`unknown portal: ${portalName}`);

  const profile = loadProfile();
  dedup.load();

  let ownedBrowser = false;
  let activeBrowser = browser;
  let activeNewPage = newPage;

  if (!activeBrowser) {
    try {
      ({ browser: activeBrowser, newPage: activeNewPage } = await browserCore.launch());
      ownedBrowser = true;
    } catch (err) {
      if (err instanceof browserCore.SkipPortalError) {
        logger.warn(`[${portalName}] skipped: ${err.message}`);
        return emptyResults(`skipped — ${err.message}`);
      }
      logger.error(`[${portalName}] browser launch failed: ${err.message}`);
      return emptyResults(`crashed — browser launch failed: ${err.message}`);
    }
  }

  try {
    return await bot.run({
      profile,
      dedup,
      dryRun,
      newPage: activeNewPage,
      browser: activeBrowser,
    });
  } catch (err) {
    if (err instanceof browserCore.SkipPortalError) {
      logger.warn(`[${portalName}] skipped: ${err.message}`);
      return emptyResults(`skipped — ${err.message}`);
    }
    logger.error(`[${portalName}] crashed: ${err.message}`);
    return emptyResults(`crashed — ${err.message}`);
  } finally {
    // Shared browser: leave open for other portals / user review.
    // Solo run of a keep-tabs portal: disconnect (don't close) so tabs survive.
    // Solo run of other portals: close as before.
    if (ownedBrowser) {
      if (KEEP_TABS_PORTALS.has(portalName) && !dryRun) {
        await keepBrowserOpen(activeBrowser);
      } else {
        await activeBrowser.close().catch(() => {});
      }
    }
  }
}

async function runAll({ dryRun = false, portals = PORTALS_IN_PRIORITY_ORDER } = {}) {
  const results = {};
  const needsKeepTabs = !dryRun && portals.some((p) => KEEP_TABS_PORTALS.has(p));

  let browser;
  let newPage;
  try {
    ({ browser, newPage } = await browserCore.launch());
  } catch (err) {
    if (err instanceof browserCore.SkipPortalError) {
      logger.error(`browser launch skipped: ${err.message}`);
    } else {
      logger.error(`browser launch failed: ${err.message}`);
    }
    for (const portalName of portals) {
      results[portalName] = emptyResults(`crashed — browser launch failed: ${err.message}`);
    }
    return results;
  }

  try {
    for (const portalName of portals) {
      logger.info(`\n=== ${portalName} ===`);
      try {
        results[portalName] = await runPortal(portalName, { dryRun, browser, newPage });
      } catch (err) {
        // Defensive: runPortal already catches, but never let one portal abort the run
        logger.error(`[${portalName}] crashed: ${err.message}`);
        results[portalName] = emptyResults(`crashed — ${err.message}`);
      }
    }
  } finally {
    if (needsKeepTabs) {
      await keepBrowserOpen(browser);
    } else {
      await browser.close().catch(() => {});
    }
  }

  const date = dedup.istDate();
  const reportFile = reporter.write(date, results, { dryRun });
  logger.info(`\nReport written to ${reportFile}`);
  printRunTabSummary(results);

  return results;
}

module.exports = { runAll, runPortal, loadProfile, PORTALS_IN_PRIORITY_ORDER, ALL_PORTALS };
