const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPipeline } = require('../src/core/pipeline');
const { createVerificationQueue, STATES } = require('../src/core/verification-queue');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const GOOD_TEXT = 'We are hiring a React Native Engineer with React, TypeScript, Node.js and Expo experience. '.repeat(8);

function tmp(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-')), name);
}

function resumeFile() {
  const f = tmp('shivajirn02.pdf');
  fs.writeFileSync(f, '%PDF-1.4');
  return f;
}

const job = (over = {}) => ({
  title: 'React Native Engineer',
  company: 'Acme',
  url: `https://boards.greenhouse.io/acme/jobs/${Math.floor(Math.random() * 1e9)}`,
  location: 'Hyderabad, Telangana, India',
  ...over,
});

test('a job whose description cannot be read is queued for verification, not rejected', async () => {
  const vq = createVerificationQueue({ file: tmp('verification-queue.json') });
  const pipe = createPipeline({
    enricher: { enrich: async () => ({ ok: false, error: 'HTTP 503', blocked: null }) },
    log: null,
    dryRun: false,
    adapters: {},
    verificationQueue: vq,
    manualActions: null,
    logger: silent,
    selectResume: () => resumeFile(),
    autoApply: false,
  });
  pipe.offer('careers', job({ title: 'React Native Engineer' }), { text: 'React Native engineer, Hyderabad' });
  await pipe.drain();
  pipe.close();
  const entries = vq.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].state, STATES.NEEDS_VERIFICATION);
  assert.equal(entries[0].source, 'careers');
  assert.match(entries[0].lastError, /full description not read/);
  assert.equal(pipe.snapshot().counters.verificationQueued, 1);
});

test('dry run with JOBMAN_AUTO_APPLY: a passing job reports "would submit" and writes no approval state', async () => {
  const approvalCalls = [];
  const fakeApprovals = {
    get: () => null,
    autoApprove: (...a) => approvalCalls.push(a),
    upsertPrepared: () => ({ id: 'abc1234' }),
    markSubmitting: () => true,
    recordOutcome: () => {},
    list: () => [],
  };
  const pipe = createPipeline({
    enricher: { enrich: async () => ({ ok: true, text: GOOD_TEXT, postedDaysAgo: 1, via: 'test' }) },
    approvals: fakeApprovals,
    log: null,
    dryRun: true,
    adapters: { careers: async () => ({ status: 'applied' }) },
    verificationQueue: null,
    manualActions: null,
    logger: silent,
    selectResume: () => resumeFile(),
    autoApply: true,
    limits: { prepare: 1 },
  });
  pipe.offer('careers', job(), { text: 'React Native engineer' });
  await pipe.drain();
  pipe.close();
  const buckets = pipe.resultsFor('careers');
  assert.equal(approvalCalls.length, 0, 'dry run must never auto-approve');
  assert.ok(buckets.applied.some((e) => /would submit/.test(e.reason || '')), `expected a "would submit" entry, got ${JSON.stringify(buckets)}`);
});

test('without JOBMAN_AUTO_APPLY the same passing job is left for approval (no auto-approval)', async () => {
  const approvalCalls = [];
  const fakeApprovals = {
    get: () => null,
    autoApprove: (...a) => approvalCalls.push(a),
    upsertPrepared: () => ({ id: 'abc1234' }),
    markSubmitting: () => true,
    recordOutcome: () => {},
    list: () => [],
  };
  const pipe = createPipeline({
    enricher: { enrich: async () => ({ ok: true, text: GOOD_TEXT, postedDaysAgo: 1, via: 'test' }) },
    approvals: fakeApprovals,
    log: null,
    dryRun: true,
    adapters: { careers: async () => ({ status: 'applied' }) },
    verificationQueue: null,
    manualActions: null,
    logger: silent,
    selectResume: () => resumeFile(),
    autoApply: false,
  });
  pipe.offer('careers', job(), { text: 'React Native engineer' });
  await pipe.drain();
  pipe.close();
  assert.equal(approvalCalls.length, 0);
  assert.equal(pipe.resultsFor('careers').applied.length, 0);
});

test('auto mode re-evaluates a pending approval instead of skipping it', async () => {
  const j = job();
  const pending = { id: 'old1234', status: 'pending', resume: resumeFile(), evidence: 'full', score: 80 };
  let preparedWrites = 0;
  const approvals = {
    get: (key) => key === j.url ? pending : null,
    upsertPrepared: () => { preparedWrites++; return pending; },
    list: () => [],
  };
  const pipe = createPipeline({
    approvals, dryRun: true, autoApply: true,
    enricher: { enrich: async () => ({ ok: true, text: GOOD_TEXT, cached: false }) },
    adapters: { careers: async () => { throw new Error('dry run must not call adapter'); } },
    logger: silent, selectResume: () => pending.resume,
    verificationQueue: null, manualActions: null,
  });
  pipe.offer('careers', j, { text: 'React Native Hyderabad' });
  await pipe.drain();
  pipe.close();
  assert.equal(preparedWrites, 0, 'dry run must not modify existing approval');
  assert.equal(pipe.snapshot().counters.autoApproved, 1);
  assert.match(pipe.resultsFor('careers').applied[0].reason, /would submit/);
});

test('auto mode re-reads a cached description live before the gate (cache hits never pass)', async () => {
  const j = job();
  const pending = { id: 'old5678', status: 'pending', resume: resumeFile(), evidence: 'full', score: 80 };
  const calls = [];
  const approvals = {
    get: (key) => key === j.url ? pending : null,
    upsertPrepared: () => pending,
    list: () => [],
  };
  const pipe = createPipeline({
    approvals, dryRun: true, autoApply: true,
    enricher: {
      enrich: async (req) => {
        calls.push(!!req.fresh);
        return req.fresh ? { ok: true, text: GOOD_TEXT, cached: false } : { ok: true, text: GOOD_TEXT, via: 'cache(x)', cached: true };
      },
    },
    adapters: { careers: async () => { throw new Error('dry run must not call adapter'); } },
    logger: silent, selectResume: () => pending.resume,
    verificationQueue: null, manualActions: null,
  });
  pipe.offer('careers', j, { text: 'React Native Hyderabad' });
  await pipe.drain();
  pipe.close();
  assert.deepEqual(calls, [false, true], 'cached read first, then one live re-read');
  assert.equal(pipe.snapshot().counters.autoApproved, 1);
});
