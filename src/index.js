#!/usr/bin/env node
require('dotenv').config();
const { Command } = require('commander');
const { runAll, ALL_PORTALS } = require('./runner');
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
  .option('--portal <name>', 'single portal (alias of --portals)')
  .option('--sequential', 'legacy runner: no enrichment pipeline or approval queue', false)
  .option('--no-dashboard', 'plain log output instead of the live dashboard')
  .action(async (opts) => {
    if (opts.portal && !opts.portals) opts.portals = opts.portal;
    const portals = opts.portals ? opts.portals.split(',').map((p) => p.trim()).filter((p) => ALL_PORTALS.includes(p)) : undefined;
    if (opts.sequential) return void (await runAll({ dryRun: opts.dryRun, ...(portals && portals.length ? { portals } : {}) }));
    // Default: the parallel runner, so every entry point gets enrichment + the approval queue.
    const { runParallel } = require('./parallel');
    await runParallel({ dryRun: opts.dryRun, dashboard: opts.dashboard, ...(portals && portals.length ? { portals } : {}) });
  });

program
  .command('parallel')
  .description('run every portal concurrently with a shared job store, live dashboard, checkpoints and graceful Ctrl+C')
  .option('--dry-run', 'do everything except submit; log what would happen', false)
  .option('--portals <list>', 'comma-separated subset, e.g. naukri,linkedin')
  .option('--approve-url <url>', 'explicitly approve this exact posting URL for external submission (repeatable)', (v, prev) => [...(prev || []), v], [])
  .option('--resume', "skip portals already finished in today's checkpoint (after Ctrl+C / crash)", false)
  .option('--discovery-workers <n>', 'portals running at once (default: 8 on this class of Mac)', (v) => parseInt(v, 10))
  .option('--apply-workers <n>', 'submissions in flight across all portals (default 3)', (v) => parseInt(v, 10))
  .option('--apply-workers-max <n>', 'ceiling for adaptive scaling of application workers (default 5)', (v) => parseInt(v, 10))
  .option('--ats-workers <n>', 'employer postings handled at once in the careers channel (default 3)', (v) => parseInt(v, 10))
  .option('--retries <n>', 'retries for a crashed portal, with exponential backoff (default 2)', (v) => parseInt(v, 10))
  .option('--no-adaptive', 'keep worker limits fixed (no resource-based scaling)')
  .option('--no-dashboard', 'plain log output instead of the live dashboard')
  .option('--no-enrich', 'do not fetch full job descriptions (uncertain cards are reported as insufficient evidence)')
  .option('--full-scan', 'ignore the description cache and re-read every posting (default: incremental)', false)
  .option('--wait-approvals <min>', 'after discovery, keep running this many minutes to submit jobs you approve meanwhile (npm run review)', (v) => parseFloat(v))
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
      approvedJobs: opts.approveUrl,
      enrich: opts.enrich,
      fullScan: opts.fullScan,
      waitApprovalsMs: Number.isFinite(opts.waitApprovals) ? opts.waitApprovals * 60_000 : 0,
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
    // Same pipeline as `parallel` (enrichment, approval queue, report with metrics).
    const { runParallel } = require('./parallel');
    await runParallel({ dryRun: opts.dryRun, dashboard: false, portals: [portal] });
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


// ---------------------------------------------------------------- approval queue

function approvalStore(opts = {}) {
  const path = require('path');
  const { createApprovalStore } = require('./core/approval');
  return createApprovalStore(opts.dryRun ? { file: path.join(__dirname, '..', 'data', 'approvals.dry-run.json') } : {});
}

function describe(j, i) {
  const lines = [
    `${i != null ? `${i}. ` : ''}[${j.id}] ${j.title} — ${j.company} (${j.portal})`,
    `   ${j.location || 'location n/a'} · score ${j.score ?? '-'} · evidence: ${j.evidence === 'full' ? 'full description' : 'listing card only'} · resume ${j.resume || '-'}`,
    `   why: ${j.why || '-'}`,
    ...(j.snippets || []).map((x) => `   » ${x.slice(0, 160)}`),
    ...(j.flags || []).map((x) => `   ⚠ ${x}`),
    `   ${j.url}`,
  ];
  if (j.status === 'submitted' && j.outcome) lines.push(`   → ${j.outcome.status}${j.outcome.reason ? ` (${j.outcome.reason})` : ''}`);
  return lines.join('\n');
}

program
  .command('approvals')
  .description('open local application review, or list prepared applications')
  .option('--list', 'print the queue in the terminal')
  .option('--status <s>', 'pending | approved | declined | submitted | all')
  .option('--port <n>', 'local review server port', (v) => parseInt(v, 10), 4177)
  .option('--dry-run', 'show the dry-run queue instead', false)
  .action(async (opts) => {
    const store = approvalStore(opts);
    if (opts.list || opts.status) {
      const status = opts.status || 'pending';
      const list = store.list(status === 'all' ? {} : { status });
      if (!list.length) return console.log(`No ${status} applications in ${store.file}`);
      console.log(list.map((j, i) => describe(j, i + 1)).join('\n\n'));
      return;
    }
    const { createApprovalServer } = require('./core/approval-ui');
    const ui = createApprovalServer(store, { port: opts.port, onApproved: async () => {
      const { runParallel } = require('./parallel');
      await runParallel({ portals: [], limits: { apply: 3 }, reportSuffix: 'submit', writeReport: false });
    } });
    const address = await ui.listen();
    console.log(`Jobman approval review: http://127.0.0.1:${address.port}/`);
    console.log('Keep this terminal running while reviewing; Ctrl+C stops the local interface.');
  });

program
  .command('approve <refs...>')
  .description('approve specific prepared jobs by id (or posting URL) — each job is approved individually')
  .option('--dry-run', 'act on the dry-run queue', false)
  .action((refs, opts) => {
    const { changed, missing } = approvalStore(opts).decide(refs, 'approved');
    for (const j of changed) console.log(`✔ approved [${j.id}] ${j.title} — ${j.company}`);
    for (const m of missing) console.log(`✖ not found: ${m}`);
    if (changed.length) console.log('\nA running `npm run parallel` submits them within ~10 s; otherwise run: npm run submit');
  });

program
  .command('decline <refs...>')
  .description('decline prepared jobs by id (never prepared or submitted again)')
  .option('--dry-run', 'act on the dry-run queue', false)
  .action((refs, opts) => {
    const { changed, missing } = approvalStore(opts).decide(refs, 'declined');
    for (const j of changed) console.log(`✔ declined [${j.id}] ${j.title} — ${j.company}`);
    for (const m of missing) console.log(`✖ not found: ${m}`);
  });

program
  .command('review')
  .description('go through pending applications one at a time: approve / decline / skip')
  .option('--dry-run', 'review the dry-run queue', false)
  .action(async (opts) => {
    const readline = require('readline/promises');
    const store = approvalStore(opts);
    const pending = store.list({ status: 'pending' });
    if (!pending.length) return console.log('Nothing waiting for approval.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let approved = 0;
    try {
      for (let i = 0; i < pending.length; i++) {
        console.log(`\n${describe(pending[i], `${i + 1}/${pending.length}`)}`);
        const a = (await rl.question('   [a]pprove  [d]ecline  [s]kip  [q]uit > ')).trim().toLowerCase();
        if (a === 'q') break;
        if (a === 'a') {
          store.decide([pending[i].id], 'approved');
          approved++;
          console.log('   ✔ approved');
        } else if (a === 'd') {
          store.decide([pending[i].id], 'declined');
          console.log('   ✔ declined');
        }
      }
    } finally {
      rl.close();
    }
    if (approved) console.log(`\n${approved} approved. A running \`npm run parallel\` submits them within ~10 s; otherwise run: npm run submit`);
  });

program
  .command('followups')
  .description('list unresolved manual follow-ups retained from earlier runs')
  .action(() => {
    const { createFollowupStore } = require('./core/followups');
    const items = createFollowupStore().list();
    if (!items.length) return console.log('No unresolved manual follow-ups.');
    console.log(`${items.length} unresolved follow-up(s) — recheck each posting and eligibility before preparing an application:\n`);
    for (const item of items) console.log(`[${item.portal}] ${item.title} — ${item.company}\n  ${item.reason}\n  ${item.url}\n`);
    console.log("After rechecking a posting, resolve it with: npm run followup:resolve -- '<posting URL>' --note '<result>'");
  });

program
  .command('followup:resolve <url>')
  .description('mark a retained follow-up resolved after rechecking the posting')
  .option('--note <text>', 'resolution note', 'rechecked')
  .action((url, opts) => {
    const { createFollowupStore } = require('./core/followups');
    if (!createFollowupStore().resolve(url, opts.note)) return console.log(`No follow-up found for ${url}`);
    console.log(`Resolved follow-up: ${url}`);
  });

program
  .command('submit-approved')
  .alias('submit')
  .description('submit already-approved applications only; does not run discovery or screening')
  .option('--dry-run', 'show what would be submitted', false)
  .option('--no-dashboard', 'plain log output')
  .action(async (opts) => {
    const { runParallel } = require('./parallel');
    const { ADAPTERS } = require('./core/submit');
    const approved = approvalStore(opts).list({ status: 'approved' });
    if (!approved.length) return console.log('No approved jobs waiting. Approve with: npm run review');
    const ready = approved.filter((j) => ADAPTERS[j.portal]);
    const deferred = approved.length - ready.length;
    console.log(`${ready.length} approved application(s) ready for submission with 3 bounded workers.${deferred ? ` ${deferred} remain approved because their portal needs a direct-submit adapter or user action.` : ''}`);
    if (!ready.length) return;
    await runParallel({ dryRun: opts.dryRun, dashboard: opts.dashboard, portals: [], reportSuffix: 'submit', limits: { apply: 3 }, writeReport: false });
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error(err && err.message ? err.message : String(err));
  process.exitCode = 1;
});
