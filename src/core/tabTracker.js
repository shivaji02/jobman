/**
 * Tracks browser tabs that stay open for manual action.
 * Successful applies are closed; manual-apply + failed tabs remain open.
 */

async function closePageQuietly(page) {
  if (!page) return;
  try {
    await page.close();
  } catch {
    // already closed / detached
  }
}

/**
 * Close every attempt page except the one we intentionally keep open
 * (manual-apply or final failed tab).
 */
async function settleAttemptPages(attemptPages, keepPage) {
  for (const page of attemptPages) {
    if (page && page !== keepPage) await closePageQuietly(page);
  }
}

function createTabTracker(portal) {
  const manualApply = [];
  const failed = [];

  function trackManualApply(job, pageUrl) {
    manualApply.push({
      title: job.title || 'Unknown',
      company: job.company || 'Unknown',
      url: pageUrl || job.companyUrl || job.url || '',
      resume: job.resume || '',
    });
  }

  function trackFailed(job, pageUrl) {
    failed.push({
      title: job.title || 'Unknown',
      company: job.company || 'Unknown',
      url: pageUrl || job.url || '',
      reason: job.reason || '',
    });
  }

  function printSummary() {
    const openCount = manualApply.length + failed.length;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[${portal}] OPEN TABS SUMMARY`);
    console.log(`${'='.repeat(60)}`);

    console.log(`\n⚠️  MANUAL APPLY (${manualApply.length} tabs) — Ready to apply manually:`);
    if (!manualApply.length) {
      console.log('  (none)');
    } else {
      manualApply.forEach((tab, idx) => {
        console.log(`\n  ${idx + 1}. ${tab.title} @ ${tab.company}`);
        console.log(`     URL: ${tab.url}`);
        if (tab.resume) console.log(`     Resume: ${tab.resume}`);
      });
    }

    if (failed.length) {
      console.log(`\n❌ FAILED (${failed.length} tabs) — Inspect & retry manually:`);
      failed.forEach((tab, idx) => {
        console.log(`\n  ${idx + 1}. ${tab.title} @ ${tab.company}`);
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

  return {
    trackManualApply,
    trackFailed,
    printSummary,
    get counts() {
      return {
        manualApply: manualApply.length,
        failed: failed.length,
        open: manualApply.length + failed.length,
      };
    },
  };
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

module.exports = {
  createTabTracker,
  printRunTabSummary,
  closePageQuietly,
  settleAttemptPages,
};
