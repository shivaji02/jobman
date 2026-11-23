const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPipeline, mergePipelineResults } = require('../src/core/pipeline');
const { createApprovalStore } = require('../src/core/approval');
const { createJobStore } = require('../src/core/jobdb');
const { createLog } = require('../src/core/dedup');
const { emptyResults, reconcile } = require('../src/core/disposition');

const quiet = { warn() {}, info() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RN_JD = 'We build a consumer app in React Native and TypeScript with a Node.js backend. 2-4 years of experience. '.repeat(8);
const RAILS_JD = 'Ruby on Rails, PostgreSQL, Sidekiq and Hotwire. 2+ years building Rails apps. '.repeat(10);

function setup({ enrich = {}, adapters = {}, dryRun = false, submitTimeoutMs, applyLimit = 2 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-'));
  const log = createLog(path.join(dir, 'log.csv'));
  log.load();
  const store = createJobStore({ dedup: log, stateDir: dir, applyLimit, dryRun });
  const approvals = createApprovalStore({ file: path.join(dir, 'approvals.json') });
  const enricher = {
    calls: [],
    async enrich({ url }) {
      this.calls.push(url);
      await sleep(5);
      const r = enrich[url];
      return r ? { ok: true, text: r } : { ok: false, error: 'HTTP 403' };
    },
    flush() {},
    stats: {},
  };
  const pipeline = createPipeline({ enricher, approvals, store, log, dryRun, adapters, profile: { current_ctc: '' }, logger: quiet, selectResume: () => 'rn.pdf', submitTimeoutMs, browser: {} });
  return { dir, log, store, approvals, enricher, pipeline, csv: () => fs.existsSync(path.join(dir, 'log.csv')) ? fs.readFileSync(path.join(dir, 'log.csv'), 'utf8') : '' };
}

/** A portal result as a bot would leave it: every offered listing was admitted (reviewed++). */
function botResults(n) {
  const r = emptyResults();
  r.discovered = n;
  r.reviewed = n;
  return r;
}

test('card-eligible job is enriched, prepared and queued for approval (never silently "needs you")', async () => {
  const url = 'https://www.linkedin.com/jobs/view/1/';
  const { pipeline, approvals, enricher } = setup({ enrich: { [url]: RN_JD } });
  pipeline.offer('linkedin', { title: 'React Native Developer', company: 'Acme', url }, { text: 'React Native Developer Acme Hyderabad' });
  await pipeline.drain();
  pipeline.close();
  assert.deepEqual(enricher.calls, [url]);
  const pending = approvals.list({ status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].evidence, 'full');
  assert.equal(pending[0].resume, 'rn.pdf');
  assert.ok(pending[0].snippets.some((s) => /React Native/.test(s)));
  const b = pipeline.resultsFor('linkedin');
  assert.equal(b.awaitingApproval.length, 1);
  assert.match(b.awaitingApproval[0].reason, new RegExp(pending[0].id));
  assert.equal(pipeline.snapshot().counters.eligible, 1);
});

test('a "Full Stack" card that is really Ruby on Rails is rejected on the full description, and logged', async () => {
  const url = 'https://www.linkedin.com/jobs/view/2/';
  const { pipeline, approvals, csv } = setup({ enrich: { [url]: RAILS_JD } });
  pipeline.offer('linkedin', { title: 'Full Stack Ruby on Rails Engineer', company: 'Teladoc', url }, { text: 'Full Stack Ruby on Rails Engineer' });
  await pipeline.drain();
  assert.equal(approvals.list().length, 0);
  const b = pipeline.resultsFor('linkedin');
  assert.equal(b.skipped.length, 1);
  assert.match(b.skipped[0].reason, /full description/);
  assert.match(csv(), /skipped,.*full description/);
});

test('inconclusive card + unreadable description → insufficient evidence, no CSV row (re-checked next run)', async () => {
  const url = 'https://www.naukri.com/job-listings-mobile-application-developer-x-hyderabad-2-to-4-years-1';
  const { pipeline, csv } = setup();
  pipeline.offer('naukri', { title: 'Mobile Application Developer', company: 'X', url }, { text: 'Mobile Application Developer X' });
  await pipeline.drain();
  const b = pipeline.resultsFor('naukri');
  assert.equal(b.insufficient.length, 1);
  assert.match(b.insufficient[0].reason, /insufficient evidence — full description unavailable \(HTTP 403\)/);
  assert.equal(csv(), '');
});

test('inconclusive card that IS a React Native job is recovered as eligible', async () => {
  const url = 'https://www.foundit.in/job/69718838';
  const { pipeline } = setup({ enrich: { [url]: RN_JD } });
  pipeline.offer('foundit', { title: 'Mobile Application Developer', company: 'MoneyView', url }, { text: 'Mobile Application Developer MoneyView' });
  await pipeline.drain();
  pipeline.close();
  assert.equal(pipeline.resultsFor('foundit').awaitingApproval.length, 1);
});

test('a 200-399 character detail snippet is enriched before final evaluation', async () => {
  const url = 'https://www.linkedin.com/jobs/view/201/';
  const { pipeline, approvals, enricher } = setup({ enrich: { [url]: RN_JD } });
  const partial = `React Native Developer Hyderabad ${'React Native and TypeScript. '.repeat(8)}`;
  assert.ok(partial.length >= 200 && partial.length < 400);
  pipeline.offer('linkedin', { title: 'React Native Developer', company: 'Acme', url }, { description: partial });
  await pipeline.drain();
  pipeline.close();
  assert.deepEqual(enricher.calls, [url]);
  assert.equal(approvals.list({ status: 'pending' }).length, 1);
});

test('candidate diagnostics retain evidence, enrichment outcome, score, and exact reason', async () => {
  const url = 'https://www.linkedin.com/jobs/view/202/';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-diagnostics-'));
  const diagnosticsFile = path.join(dir, 'candidates.jsonl');
  // Replace the fixture pipeline with one that writes diagnostics to an isolated file.
  const { createPipeline: makePipeline } = require('../src/core/pipeline');
  const log = createLog(path.join(dir, 'log.csv'));
  log.load();
  const approvals = createApprovalStore({ file: path.join(dir, 'approvals.json') });
  const store = createJobStore({ dedup: log, stateDir: dir, applyLimit: 1 });
  const tracked = makePipeline({
    enricher: { async enrich() { return { ok: false, error: 'HTTP 403' }; }, flush() {}, stats: {} },
    approvals, store, log, diagnosticsFile, logger: quiet,
  });
  tracked.offer('naukri', { title: 'Mobile Application Developer', company: 'X', url }, { text: 'Mobile Application Developer Hyderabad' });
  await tracked.drain();
  tracked.close();
  const row = JSON.parse(fs.readFileSync(diagnosticsFile, 'utf8').trim());
  assert.equal(row.portal, 'naukri');
  assert.equal(row.employer, 'X');
  assert.equal(row.fullDescriptionFetched, false);
  assert.ok(row.technologies.includes('React Native') === false);
  assert.equal(row.eligibilityScore, 50);
  assert.match(row.exactReason, /HTTP 403/);
});

test('the same job/role offered by two portals is prepared once', async () => {
  const a = 'https://www.naukri.com/job-listings-rn-acme-1';
  const { pipeline, approvals } = setup({ enrich: { [a]: RN_JD } });
  pipeline.offer('naukri', { title: 'React Native Developer', company: 'Acme Pvt Ltd', url: a });
  pipeline.offer('talent', { title: 'React Native Developer', company: 'Acme', url: 'https://in.talent.com/view?id=9' });
  await pipeline.drain();
  assert.equal(approvals.list().length, 1);
  assert.match(pipeline.resultsFor('talent').alreadyApplied[0].reason, /same role already in the pipeline via naukri/);
});

test('approval made while running → submitted, verified, logged once; approval file records the outcome', async () => {
  const url = 'https://www.linkedin.com/jobs/view/3/';
  const calls = [];
  const adapters = {
    linkedin: async ({ job }) => {
      calls.push(job.url);
      return { status: 'applied', evidence: { signal: 'text "Application sent"', url: job.url, screenshot: '/tmp/x.png', at: 'now' } };
    },
  };
  const { pipeline, approvals, csv, store } = setup({ enrich: { [url]: RN_JD }, adapters });
  pipeline.offer('linkedin', { title: 'React Native Developer', company: 'Acme', url });
  await pipeline.drain();
  const [p] = approvals.list({ status: 'pending' });
  approvals.decide([p.id], 'approved');
  pipeline.pollApprovals();
  pipeline.pollApprovals(); // a second poll must not resubmit
  await pipeline.drain();
  pipeline.close();
  assert.deepEqual(calls, [url]);
  const b = pipeline.resultsFor('linkedin');
  assert.equal(b.applied.length, 1);
  assert.equal(b.awaitingApproval.length, 0);
  assert.equal((csv().match(/,applied,/g) || []).length, 1);
  assert.equal(approvals.get(url).status, 'submitted');
  assert.equal(approvals.get(url).outcome.status, 'applied');
  assert.equal(store.stats.confirmed, 1);
});

test('a stalled form does not block other submissions; it ends unconfirmed and is never resubmitted', async () => {
  const slow = 'https://www.linkedin.com/jobs/view/10/';
  const fast = 'https://www.naukri.com/job-listings-rn-fast-2';
  let fastDone = 0;
  const adapters = {
    linkedin: () => new Promise(() => {}), // never settles
    naukri: async () => {
      fastDone = Date.now();
      return { status: 'applied', evidence: { signal: 'ok', url: fast, screenshot: '', at: '' } };
    },
  };
  const { pipeline, approvals, csv } = setup({ enrich: { [slow]: RN_JD, [fast]: RN_JD }, adapters, submitTimeoutMs: 300 });
  approvals.approveUrl(slow, { portal: 'linkedin' });
  approvals.approveUrl(fast, { portal: 'naukri' });
  const t0 = Date.now();
  pipeline.offer('linkedin', { title: 'React Native Developer', company: 'Slow', url: slow });
  pipeline.offer('naukri', { title: 'React Native Engineer', company: 'Fast', url: fast });
  await pipeline.drain();
  assert.ok(fastDone - t0 < 250, `unrelated job waited ${fastDone - t0} ms`);
  const li = pipeline.resultsFor('linkedin');
  assert.equal(li.unconfirmed.length, 1);
  assert.match(li.unconfirmed[0].reason, /did not finish within/);
  assert.match(csv(), /unconfirmed/);
  // A later run sees it as blocking in the log → never retried.
  const log2 = createLog(path.join(path.dirname(approvals.file), 'log.csv'));
  log2.load();
  assert.equal(log2.priorDisposition(slow).kind, 'already');
});

test('failed before submit is retried once; a failure after clicking submit is not', async () => {
  const a = 'https://www.naukri.com/job-listings-a-1';
  const b = 'https://in.talent.com/view?id=2';
  const n = { naukri: 0, talent: 0 };
  const adapters = {
    naukri: async () => { n.naukri++; return { status: 'failed', reason: 'network' }; },
    talent: async () => { n.talent++; return { status: 'failed', submitted: true, reason: 'crash after submit' }; },
  };
  const { pipeline, approvals } = setup({ enrich: { [a]: RN_JD, [b]: RN_JD }, adapters });
  approvals.approveUrl(a, { portal: 'naukri' });
  approvals.approveUrl(b, { portal: 'talent' });
  pipeline.offer('naukri', { title: 'React Native Developer', company: 'A', url: a });
  pipeline.offer('talent', { title: 'React Native Engineer', company: 'B', url: b });
  await pipeline.drain();
  assert.deepEqual(n, { naukri: 2, talent: 1 });
});

test('declined jobs are not prepared again; pending ones are not re-enriched (incremental)', async () => {
  const d = 'https://www.linkedin.com/jobs/view/20/';
  const p = 'https://www.linkedin.com/jobs/view/21/';
  const { pipeline, approvals, enricher } = setup({ enrich: { [d]: RN_JD, [p]: RN_JD } });
  approvals.upsertPrepared({ url: d, title: 'x' });
  approvals.upsertPrepared({ url: p, title: 'y' });
  approvals.decide([approvals.get(d).id], 'declined');
  pipeline.offer('linkedin', { title: 'React Native Developer', company: 'D', url: d });
  pipeline.offer('linkedin', { title: 'React Native Engineer', company: 'P', url: p });
  await pipeline.drain();
  pipeline.close();
  assert.deepEqual(enricher.calls, []);
  const b = pipeline.resultsFor('linkedin');
  assert.match(b.skipped[0].reason, /declined by you/);
  assert.equal(b.awaitingApproval.length, 1);
});

test('dry run: approved jobs are reported as would-submit and the adapter is never called', async () => {
  const url = 'https://www.linkedin.com/jobs/view/30/';
  let called = 0;
  const { pipeline, approvals } = setup({ enrich: { [url]: RN_JD }, adapters: { linkedin: async () => { called++; return {}; } }, dryRun: true });
  approvals.approveUrl(url, { portal: 'linkedin' });
  pipeline.offer('linkedin', { title: 'React Native Developer', company: 'Acme', url });
  await pipeline.drain();
  assert.equal(called, 0);
  assert.match(pipeline.resultsFor('linkedin').applied[0].reason, /would submit/);
});

test('offer() never blocks the bot; merged results reconcile with zero unaccounted', async () => {
  const urls = Array.from({ length: 12 }, (_, i) => `https://www.linkedin.com/jobs/view/${100 + i}/`);
  const enrich = Object.fromEntries(urls.slice(0, 6).map((u, i) => [u, i % 2 ? RN_JD : RAILS_JD]));
  const { pipeline } = setup({ enrich });
  const t0 = Date.now();
  urls.forEach((url, i) => pipeline.offer('linkedin', { title: i % 3 ? 'Full Stack Developer' : 'Mobile Application Developer', company: `C${i}`, url }));
  assert.ok(Date.now() - t0 < 50, 'offer is synchronous');
  await pipeline.drain();
  pipeline.close();
  const results = { linkedin: botResults(12) };
  mergePipelineResults(results, pipeline);
  const rec = reconcile(results.linkedin);
  assert.equal(rec.unaccounted, 0);
  assert.equal(rec.counts.awaiting_approval + rec.counts.rejected_role + rec.counts.needs_enrichment, 12);
});

test('approved earlier, not rediscovered: submitted as carry-over (outside this run\'s funnel)', async () => {
  const url = 'https://www.naukri.com/job-listings-old-1';
  const { pipeline, approvals } = setup({ adapters: { naukri: async () => ({ status: 'manual-apply', reason: 'needs your answer: current CTC' }) } });
  approvals.upsertPrepared({ url, portal: 'naukri', title: 'RN Dev', company: 'Old' });
  approvals.decide([approvals.get(url).id], 'approved');
  pipeline.pollApprovals();
  await pipeline.drain();
  assert.equal(pipeline.carryOver.length, 1);
  assert.equal(pipeline.carryOver[0].outcome, 'manualApply');
  assert.equal(approvals.get(url).outcome.status, 'manual');
});

test('submission-only run processes approved records with no portal discovery', async () => {
  const { runParallel } = require('../src/parallel');
  const { createLog } = require('../src/core/dedup');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approved-only-'));
  const url = 'https://www.linkedin.com/jobs/view/54321/';
  const approvals = createApprovalStore({ file: path.join(dir, 'approvals.json') });
  const job = approvals.upsertPrepared({ url, portal: 'linkedin', site: 'LinkedIn', title: 'React Native Engineer', company: 'Acme', location: 'Hyderabad', resume: 'rn.pdf', applyContext: { answers: { work_authorization: 'Yes' } } });
  approvals.decide([job.id], 'approved');
  const log = createLog(path.join(dir, 'applied.csv'));
  log.load();
  let discovered = 0, submitted = 0;
  const browser = { close: async () => {}, pages: async () => [] };
  const result = await runParallel({
    stateDir: dir, portals: [], approvals, log, profile: { current_ctc: '' }, dashboard: false, writeReport: false, adaptive: false, installSignals: false,
    launchBrowser: async () => ({ browser, newPage: async () => { throw new Error('discovery must not open a portal page'); } }),
    bots: { linkedin: { run: async () => { discovered++; } } },
    sampler: { sample: async () => ({ memAvailablePct: 80, cpuPct: 5, cores: 8, totalMemMb: 16_000, load1: 0, nodeRssMb: 1, chrome: { procs: 0, rssMb: 0 } }) },
    adapters: { linkedin: async ({ job: carried }) => { submitted++; assert.equal(carried.resume, 'rn.pdf'); assert.deepEqual(carried.answers, { work_authorization: 'Yes' }); return { status: 'applied', evidence: { signal: 'mock confirmation', url, at: 'test' } }; } },
  });
  assert.equal(discovered, 0);
  assert.equal(submitted, 1);
  assert.equal(result.metrics.limits.apply, 3);
  assert.equal(approvals.get(url).workflowStatus, 'confirmed');
});

test('approved submissions run concurrently up to the configured three-worker bound', async () => {
  const portals = ['linkedin', 'naukri', 'talent', 'wellfound'];
  const state = { active: 0, peak: 0 };
  const adapters = Object.fromEntries(portals.map((portal) => [portal, async ({ job }) => {
    state.active++;
    state.peak = Math.max(state.peak, state.active);
    await sleep(80);
    state.active--;
    return { status: 'applied', evidence: { signal: 'mock confirmation', url: job.url } };
  }]));
  const { pipeline, approvals } = setup({ adapters, applyLimit: 3 });
  for (const [i, portal] of portals.entries()) {
    const url = `https://example.test/${portal}/${i}`;
    approvals.approveUrl(url, { portal, title: `React Native Engineer ${i}`, company: `Company ${i}` });
    pipeline.offer(portal, { title: `React Native Engineer ${i}`, company: `Company ${i}`, url });
  }
  await pipeline.drain();
  assert.equal(state.peak, 3);
  assert.equal(approvals.list({ status: 'submitted' }).length, 4);
});
