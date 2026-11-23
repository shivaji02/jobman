const test = require('node:test');
const assert = require('node:assert/strict');
const { emptyResults, claimGate } = require('../src/core/disposition');

test('external submission waits for exact per-job approval', async () => {
  const results = emptyResults();
  const job = { title: 'React Native Engineer', company: 'Acme', url: 'https://jobs.example/role/123' };
  assert.equal(await claimGate(results, {}, job.url, job), false);
  assert.equal(results.manualApply.length, 1);
  assert.equal(results.manualApply[0].needsApproval, true);
  assert.match(results.manualApply[0].reason, /explicit per-job approval/);
});

test('exact normalized posting approval opens the submission gate', async () => {
  const results = emptyResults();
  const job = { title: 'React Native Engineer', company: 'Acme', url: 'https://jobs.example/role/123?utm_source=feed' };
  assert.equal(await claimGate(results, {}, job.url, job, { approvedJobs: ['https://jobs.example/role/123'] }), true);
  assert.equal(results.manualApply.length, 0);
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApprovalStore } = require('../src/core/approval');
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'appr-')), 'approvals.json');

test('batch decisions are restricted to pending jobs and leave a per-job audit trail', () => {
  const s = createApprovalStore({ file: tmpFile(), now: () => 1_800_000_000_000 });
  const a = s.upsertPrepared({ url: 'https://jobs.example/a', title: 'Frontend Engineer' });
  const b = s.upsertPrepared({ url: 'https://jobs.example/b', title: 'React Native Engineer' });
  const changed = s.decide([a.id], 'approved').changed;
  assert.deepEqual(changed.map((j) => j.id), [a.id]);
  assert.equal(s.get('https://jobs.example/b').status, 'pending', 'unselected application was untouched');
  const events = s.read().events;
  assert.equal(events.at(-1).type, 'approved');
  assert.equal(events.at(-1).id, a.id);
  assert.equal(events.at(-1).at, new Date(1_800_000_000_000).toISOString());
});

test('submission write-ahead state recovers to unconfirmed and cannot be approved again', () => {
  const s = createApprovalStore({ file: tmpFile() });
  const job = s.upsertPrepared({ url: 'https://jobs.example/crash', portal: 'linkedin' });
  s.decide([job.id], 'approved');
  assert.equal(s.markSubmitting(job.key), true);
  assert.equal(s.get(job.key).status, 'submitting');
  const recovered = s.recoverSubmitting();
  assert.equal(recovered.length, 1);
  assert.equal(s.get(job.key).status, 'unconfirmed');
  assert.match(s.get(job.key).outcome.reason, /verify on the portal/);
  assert.equal(s.decide([job.id], 'approved').changed.length, 0);
});

test('local approval UI renders review fields and changes only the exact selected ids', () => {
  const store = createApprovalStore({ file: tmpFile() });
  const a = store.upsertPrepared({ url: 'https://jobs.example/a', title: 'Frontend Engineer', company: 'Acme' });
  const b = store.upsertPrepared({ url: 'https://jobs.example/b', title: 'React Native Engineer', company: 'Beta' });
  const { decideSelected, page } = require('../src/core/approval-ui');
  const html = page(store.list());
  for (const field of ['Company / title', 'Location / experience', 'Technology match / score', 'Resume / requirements', 'URL / status', 'Review the exact jobs']) assert.ok(html.includes(field));
  const out = decideSelected(store, [a.id], 'approved');
  assert.deepEqual(out.changed.map((j) => j.id), [a.id]);
  assert.equal(store.get('https://jobs.example/a').status, 'approved');
  assert.equal(store.get('https://jobs.example/b').status, 'pending');
  assert.equal(store.read().events.at(-1).id, a.id);
  assert.throws(() => decideSelected(store, [a.id, b.id], 'approved'), /no longer pending/);
  assert.equal(decideSelected(store, [b.id], 'declined').changed[0].status, 'declined');
  assert.equal(store.read().events.at(-1).type, 'declined');
});

test('approval UI exposes only review fields and flags approved portals needing user action', () => {
  const store = createApprovalStore({ file: tmpFile() });
  const job = store.upsertPrepared({ url: 'https://example.test/r', title: 'Developer', portal: 'yourstory', applyContext: { answers: { password: 'never expose' } } });
  store.decide([job.id], 'approved');
  const { viewJob } = require('../src/core/approval-ui');
  const safe = viewJob(store.get(job.url));
  assert.equal(safe.displayStatus, 'approved · needs user action');
  assert.equal(Object.hasOwn(safe, 'applyContext'), false);
  assert.equal(JSON.stringify(safe).includes('never expose'), false);
});

test('approval queue: per-job ids, approve/decline by id or URL, decisions survive re-preparation', () => {
  const file = tmpFile();
  const s = createApprovalStore({ file });
  const a = s.upsertPrepared({ url: 'https://www.linkedin.com/jobs/view/1/?trk=x', title: 'RN', company: 'A', portal: 'linkedin' });
  const b = s.upsertPrepared({ url: 'https://www.naukri.com/job-listings-b-2', title: 'FS', company: 'B', portal: 'naukri' });
  assert.match(a.id, /^[0-9a-f]{7}$/);
  assert.notEqual(a.id, b.id);
  assert.equal(s.list({ status: 'pending' }).length, 2);
  const r = s.decide([a.id, 'https://www.naukri.com/job-listings-b-2', 'nope'], 'approved');
  assert.equal(r.changed.length, 2);
  assert.deepEqual(r.missing, ['nope']);
  // Seeing the job again in a later run never resets your decision.
  s.upsertPrepared({ url: 'https://www.linkedin.com/jobs/view/1/', title: 'RN (updated)' });
  assert.equal(s.get('https://www.linkedin.com/jobs/view/1/').status, 'approved');
  assert.equal(s.approvedKeys().size, 2);
});

test('approval queue: a second process (review in another terminal) sees and changes the same file', () => {
  const file = tmpFile();
  const runner = createApprovalStore({ file });
  const reviewer = createApprovalStore({ file });
  const j = runner.upsertPrepared({ url: 'https://in.talent.com/view?id=5', title: 'RN' });
  reviewer.decide([j.id], 'approved');
  assert.equal(runner.get('https://in.talent.com/view?id=5').status, 'approved');
  runner.recordOutcome('https://in.talent.com/view?id=5', { status: 'applied' });
  const again = reviewer.decide([j.id], 'approved');
  assert.match(again.missing[0], /already submitted/);
  assert.equal(fs.existsSync(`${file}.lock`), false, 'lock released');
});

test('approval queue: a stale lock from a crashed process is recovered', () => {
  const file = tmpFile();
  fs.writeFileSync(`${file}.lock`, '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${file}.lock`, old, old);
  const s = createApprovalStore({ file });
  assert.equal(s.upsertPrepared({ url: 'https://x.example/1' }).status, 'pending');
});
