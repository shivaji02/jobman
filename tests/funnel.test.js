/**
 * Regression tests for the 2026-11-05 pipeline audit:
 * dedup identity, resubmission safety, disposition taxonomy, funnel reconciliation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLog, normalizeJobUrl, jobFingerprint, istDate } = require('../src/core/dedup');
const { classify, reconcile, reconcileAll, emptyResults, admit } = require('../src/core/disposition');

const tmpLog = () => createLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jobman-funnel-')), 'log.csv'));

// ---------------------------------------------------------------- job identity

test('Indeed job keys survive normalization (root cause: every job collapsed to /viewjob)', () => {
  assert.equal(normalizeJobUrl('https://in.indeed.com/viewjob?jk=abc123def4567890&from=serp&vjs=3'), 'https://in.indeed.com/viewjob?jk=abc123def4567890');
  assert.notEqual(
    normalizeJobUrl('https://in.indeed.com/viewjob?jk=aaaaaaaaaaaaaaaa'),
    normalizeJobUrl('https://in.indeed.com/viewjob?jk=bbbbbbbbbbbbbbbb')
  );
});

test('one Indeed manual-apply row no longer blocks every other Indeed job', () => {
  const log = tmpLog();
  log.append({ site: 'Indeed', job_title: 'RN Dev', company: 'Q', job_url: 'https://in.indeed.com/viewjob?jk=1111111111111111', status: 'manual-apply' });
  assert.equal(log.has('https://in.indeed.com/viewjob?jk=1111111111111111'), true);
  assert.equal(log.has('https://in.indeed.com/viewjob?jk=2222222222222222'), false);
});

test('legacy identity-less Indeed rows are ignored instead of blocking everything', () => {
  const log = tmpLog();
  log.append({ site: 'Indeed', job_title: 'RN Dev', company: 'Q', job_url: 'https://in.indeed.com/viewjob', status: 'manual-apply' });
  assert.equal(log.has('https://in.indeed.com/viewjob?jk=2222222222222222'), false);
});

test('LinkedIn search-result and view URLs share one canonical key', () => {
  const a = normalizeJobUrl('https://www.linkedin.com/jobs/search-results/?currentJobId=4487253924&keywords=x');
  const b = normalizeJobUrl('https://www.linkedin.com/jobs/view/4487253924/?trackingId=abc&refId=z');
  const c = normalizeJobUrl('https://www.linkedin.com/jobs/view/4487253924/');
  assert.equal(a, 'https://www.linkedin.com/jobs/view/4487253924');
  assert.equal(a, b);
  assert.equal(b, c);
});

test('Naukri tracking params are still stripped', () => {
  assert.equal(normalizeJobUrl('https://www.naukri.com/job-listings-x-123?src=jobsearchDesk&sid=1'), 'https://www.naukri.com/job-listings-x-123');
});

// ---------------------------------------------------------------- resubmission safety

test('unconfirmed submissions block re-application (never blindly resubmitted)', () => {
  const log = tmpLog();
  const url = 'https://www.foundit.in/job/42';
  log.append({ site: 'Foundit', job_title: 'RN', company: 'A', job_url: url, status: 'unconfirmed', notes: 'Apply clicked, no Applied state' });
  assert.equal(log.has(url), true);
  assert.equal(log.isApplied(url), false);
  assert.equal(log.priorDisposition(url).kind, 'already');
});

test('failed jobs retry across runs, then are handed to the user after MAX_FAILED_ATTEMPTS', () => {
  const log = tmpLog();
  const url = 'https://www.naukri.com/job-listings-y-9';
  log.append({ site: 'Naukri', job_title: 'FE', company: 'B', job_url: url, status: 'failed', notes: 'timeout' });
  assert.equal(log.priorDisposition(url), null); // 1 failure: retry next run
  log.append({ site: 'Naukri', job_title: 'FE', company: 'B', job_url: url, status: 'failed', notes: 'timeout' });
  assert.equal(log.priorDisposition(url).kind, 'exhausted');
});

test('same company + title submitted on another portal counts as already applied', () => {
  const log = tmpLog();
  log.append({ site: 'Naukri', job_title: 'React Native Developer', company: 'Acme Technologies Pvt Ltd', job_url: 'https://www.naukri.com/job-listings-a-1', status: 'applied', date: istDate() });
  const prior = log.priorDisposition('https://www.talent.com/view?id=77', { company: 'Acme', title: 'React Native Developer' });
  assert.equal(prior.kind, 'already');
  assert.match(prior.reason, /same role already applied/);
  assert.equal(jobFingerprint('Acme Technologies Pvt Ltd', 'React Native Developer'), jobFingerprint('ACME', 'react-native developer'.replace('-', ' ')));
});

test('fingerprint match expires after the window', () => {
  const log = tmpLog();
  log.append({ site: 'Naukri', job_title: 'React Developer', company: 'Old Co', job_url: 'https://www.naukri.com/job-listings-old-1', status: 'applied', date: '2026-01-01' });
  assert.equal(log.submittedElsewhere('Old Co', 'React Developer', 'https://x.test/2', { now: new Date('2026-11-05') }), null);
});

test('identical repeat "skipped" rows are not re-appended (log bloat)', () => {
  const log = tmpLog();
  const row = { site: 'Wellfound', job_title: 'X', company: 'Y', job_url: 'https://wellfound.com/jobs/1', status: 'skipped', notes: 'score 10 below threshold' };
  assert.equal(log.append(row), true);
  assert.equal(log.append(row), false);
  assert.equal(log.append({ ...row, notes: 'score 20 below threshold' }), true);
  const lines = fs.readFileSync(log.filePath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3); // header + 2 distinct verdicts
});

// ---------------------------------------------------------------- dispositions

test('classify maps buckets + reasons to one canonical disposition', () => {
  assert.equal(classify('applied', { evidence: { signal: 'x' } }), 'applied_confirmed');
  assert.equal(classify('applied', {}), 'applied_unconfirmed');
  assert.equal(classify('applied', {}, { dryRun: true }), 'would_apply');
  assert.equal(classify('unconfirmed', {}), 'applied_unconfirmed');
  assert.equal(classify('alreadyApplied', {}), 'already_applied');
  assert.equal(classify('manualApply', { reason: 'CAPTCHA' }), 'manual_required');
  assert.equal(classify('failed', { reason: 'Navigation timeout' }), 'failed_technical');
  assert.equal(classify('failed', { reason: 'apply not confirmed (extra questions)' }), 'applied_unconfirmed');
  assert.equal(classify('skipped', { reason: 'experience 5-10 Yrs out of range' }), 'rejected_experience');
  assert.equal(classify('skipped', { reason: 'Mumbai region excluded' }), 'rejected_location');
  assert.equal(classify('skipped', { reason: 'pune only allowed for good companies' }), 'rejected_location');
  assert.equal(classify('skipped', { reason: 'remote-only, no south india city' }), 'rejected_location');
  assert.equal(classify('skipped', { reason: 'score 29 below threshold' }), 'rejected_role');
  assert.equal(classify('skipped', { reason: 'already applied on Naukri' }), 'already_applied');
  assert.equal(classify('skipped', { reason: 'per-run cap reached' }), 'deferred_cap');
});

test('admit(): duplicates, prior submissions and new jobs are each accounted once', () => {
  const log = tmpLog();
  log.append({ site: 'Naukri', job_title: 'Old', company: 'Z', job_url: 'https://n.test/old', status: 'applied' });
  const results = emptyResults();
  const seen = new Set();
  const cards = ['https://n.test/a', 'https://n.test/a', 'https://n.test/old', 'https://n.test/b'];
  results.discovered += cards.length;
  const gates = cards.map((url) => admit(results, { key: url, seen, dedup: log, job: { title: url, company: 'C', url } }));
  assert.deepEqual(gates, ['new', 'duplicate', 'already', 'new']);
  // bot puts the two new ones in buckets
  results.skipped.push({ reason: 'score 1 below threshold' });
  results.applied.push({ evidence: { signal: 'ok' } });
  const rec = reconcile(results);
  assert.equal(rec.discovered, 4);
  assert.equal(rec.duplicates, 1);
  assert.equal(rec.reviewed, 3);
  assert.equal(rec.unaccounted, 0);
  assert.equal(rec.discoveryGap, 0);
  assert.equal(rec.counts.already_applied, 1);
  assert.equal(rec.counts.applied_confirmed, 1);
});

test('reconcile flags listings that were reviewed but never dispositioned', () => {
  const rec = reconcile({ reviewed: 708, skipped: new Array(277).fill({ reason: 'score 1 below threshold' }) });
  assert.equal(rec.unaccounted, 431); // the 2026-11-05 Naukri gap, now visible instead of silent
});

test('reconcileAll sums portals and keeps out-of-scope separate from reviewed', () => {
  const { total } = reconcileAll({
    careers: { discovered: 3624, outOfScope: 3334, reviewed: 290, skipped: new Array(290).fill({ reason: 'not in a south India city' }) },
    naukri: { discovered: 10, duplicates: 4, reviewed: 6, applied: [{ evidence: { signal: 's' } }], skipped: new Array(5).fill({ reason: 'score 0 below threshold' }) },
  });
  assert.equal(total.discovered, 3634);
  assert.equal(total.reviewed, 296);
  assert.equal(total.unaccounted, 0);
  assert.equal(total.discoveryGap, 0);
  assert.equal(total.counts.applied_confirmed, 1);
});

// ---------------------------------------------------------------- discovery

test('LinkedIn new-UI card lines parse into title/company/location/applied', () => {
  const { parseCardLines } = require('../src/bots/linkedin');
  const c = parseCardLines(['Senior Software Engineer ', 'SS&C Technologies', 'Hyderabad (Hybrid)', '2 school alumni work here', 'Viewed', ' · ', 'Easy Apply']);
  assert.deepEqual(
    { title: c.title, company: c.company, location: c.location, appliedOnPortal: c.appliedOnPortal, easyApply: c.easyApply },
    { title: 'Senior Software Engineer', company: 'SS&C Technologies', location: 'Hyderabad (Hybrid)', appliedOnPortal: false, easyApply: true }
  );
  assert.equal(parseCardLines(['FULL STACK DEVELOPER', 'Anytime Diesel', 'Greater Hyderabad Area (On-site)', 'Applied 2 days ago']).appliedOnPortal, true);
  assert.equal(parseCardLines(['Selected, React Dev (Verified job)', 'React Dev (Verified job)', 'Acme', 'Chennai']).title, 'React Dev');
});

test('career-site pre-filter keeps Indian software roles and drops global/non-software roles', () => {
  const { inDiscoveryScope } = require('../src/bots/careers');
  assert.equal(inDiscoveryScope({ title: 'Software Engineer, Mobile', location: 'Bengaluru, India' }), true);
  assert.equal(inDiscoveryScope({ title: 'Frontend Engineer', location: 'Remote - US' }), false);
  assert.equal(inDiscoveryScope({ title: 'Account Executive', location: 'Hyderabad' }), false);
  assert.equal(inDiscoveryScope({ title: 'React Developer', location: 'Dublin / London' }), false);
});

test('Naukri search URL pushes the experience filter into discovery', () => {
  const { searchUrl } = require('../src/bots/naukri');
  assert.match(searchUrl('react native developer', 'hyderabad'), /[?&]experience=3\b/);
  assert.match(searchUrl('react native developer', 'hyderabad'), /jobAge=3/);
});

test('an unconfirmed job is unblocked only by a later "verified not applied" check', () => {
  const log = tmpLog();
  const url = 'https://www.naukri.com/job-listings-z-1';
  log.append({ site: 'Naukri', job_title: 'J', company: 'K', job_url: url, status: 'unconfirmed', notes: 'Apply clicked' });
  log.append({ site: 'Naukri', job_title: 'J', company: 'K', job_url: url, status: 'failed', notes: 'timeout' });
  assert.equal(log.has(url), true); // an ordinary failure never lifts the block
  log.append({ site: 'Naukri', job_title: 'J', company: 'K', job_url: url, status: 'failed', notes: 'verified not applied — Apply still offered on job page' });
  assert.equal(log.has(url), false);
  const log2 = createLog(log.filePath); // same verdict after reloading from disk
  assert.equal(log2.has(url), false);
  // …and the cross-portal fingerprint no longer blocks other listings of the same role
  assert.equal(log2.submittedElsewhere('K', 'J', 'https://www.naukri.com/job-listings-z-2'), null);
});
