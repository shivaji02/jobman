const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLog } = require('../src/core/dedup');

function tempCsvPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jobman-test-')), 'log.csv');
}

test('load() returns empty set when file does not exist', () => {
  const log = createLog(tempCsvPath());
  const urls = log.load();
  assert.equal(urls.size, 0);
});

test('has() is false for unseen url, true after appending as applied', () => {
  const log = createLog(tempCsvPath());
  const url = 'https://example.com/job/1';
  assert.equal(log.has(url), false);

  log.append({ site: 'Naukri', job_title: 'React Native Dev', company: 'Acme', job_url: url, status: 'applied', notes: 'ok' });
  assert.equal(log.has(url), true);
});

test('skipped/failed entries are not treated as applied for dedup', () => {
  const log = createLog(tempCsvPath());
  const url = 'https://example.com/job/2';
  log.append({ site: 'Naukri', job_title: 'X', company: 'Y', job_url: url, status: 'skipped', notes: 'low score' });
  assert.equal(log.has(url), false);

  log.append({ site: 'Naukri', job_title: 'X', company: 'Y', job_url: url, status: 'failed', notes: 'error' });
  assert.equal(log.has(url), false);
});

test('manual-apply entries are treated as seen for dedup', () => {
  const log = createLog(tempCsvPath());
  const url = 'https://example.com/job/manual-1';
  log.append({
    site: 'Naukri',
    job_title: 'RN Dev',
    company: 'Acme',
    job_url: url,
    status: 'manual-apply',
    notes: 'URL: https://boards.greenhouse.io/acme | Resume: /tmp/rn.pdf',
  });
  assert.equal(log.has(url), true);
});

test('append() persists rows across a fresh load from disk', () => {
  const file = tempCsvPath();
  const log1 = createLog(file);
  const url = 'https://example.com/job/3';
  log1.append({ site: 'Instahyre', job_title: 'RN Dev', company: 'Acme', job_url: url, status: 'applied', notes: 'auto' });

  const log2 = createLog(file);
  assert.equal(log2.has(url), true);
});

test('append() CSV-escapes fields containing commas and quotes', () => {
  const file = tempCsvPath();
  const log = createLog(file);
  const url = 'https://example.com/job/4';
  log.append({
    site: 'Naukri',
    job_title: 'Full Stack, React/Node',
    company: 'Acme "The Best" Inc',
    job_url: url,
    status: 'applied',
    notes: 'contains, a comma and "quotes"',
  });

  const raw = fs.readFileSync(file, 'utf8');
  assert.match(raw, /"Full Stack, React\/Node"/);
  assert.match(raw, /"Acme ""The Best"" Inc"/);

  // and it still round-trips correctly via load()/has()
  const log2 = createLog(file);
  assert.equal(log2.has(url), true);
});

test('has() matches URL variants after query-string / trailing-slash normalize', () => {
  const log = createLog(tempCsvPath());
  const stored = 'https://www.naukri.com/job-listings-react-native-developer-acme-210726011670';
  log.append({ site: 'Naukri', job_title: 'RN', company: 'Acme', job_url: stored, status: 'applied', notes: 'day 1' });

  assert.equal(log.has(`${stored}?src=jobsearchDesk&sid=abc`), true);
  assert.equal(log.isApplied(`${stored}?xp=1`), true);
  assert.equal(log.has(stored + '/'), true);
});

test('isApplied() is true only for applied rows, not failed/skipped/manual-apply', () => {
  const log = createLog(tempCsvPath());
  const applied = 'https://www.naukri.com/job-listings-applied-1';
  const failed = 'https://www.naukri.com/job-listings-failed-1';
  const manual = 'https://www.naukri.com/job-listings-manual-1';

  log.append({ site: 'Naukri', job_title: 'A', company: 'C', job_url: applied, status: 'applied', notes: '' });
  log.append({ site: 'Naukri', job_title: 'B', company: 'C', job_url: failed, status: 'failed', notes: 'Apply button not found' });
  log.append({ site: 'Naukri', job_title: 'C', company: 'C', job_url: manual, status: 'manual-apply', notes: '' });

  assert.equal(log.isApplied(applied), true);
  assert.equal(log.has(applied), true);
  assert.equal(log.isApplied(failed), false);
  assert.equal(log.has(failed), false);
  assert.equal(log.isApplied(manual), false);
  assert.equal(log.has(manual), true);
});

test('normalizeJobUrl keeps Instahyre hash keys and strips Naukri query params', () => {
  const { normalizeJobUrl } = require('../src/core/dedup');
  const insta = 'https://www.instahyre.com/#job/edatabae/edatabae-sde-1-react-native';
  assert.equal(normalizeJobUrl(insta), insta);
  assert.equal(
    normalizeJobUrl('https://www.naukri.com/job-listings-foo-123?src=desk&sid=x'),
    'https://www.naukri.com/job-listings-foo-123'
  );
});

test('append() appends immediately — one call, one row, no batching', () => {
  const file = tempCsvPath();
  const log = createLog(file);
  log.append({ site: 'A', job_title: 'T1', company: 'C1', job_url: 'u1', status: 'applied', notes: '' });
  log.append({ site: 'B', job_title: 'T2', company: 'C2', job_url: 'u2', status: 'applied', notes: '' });

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3); // header + 2 rows
});

test('normalizeJobUrl keeps the id param for Talent.com job links', () => {
  const { normalizeJobUrl } = require('../src/core/dedup');
  assert.equal(normalizeJobUrl('https://in.talent.com/view?id=abc123&utm=x'), 'https://in.talent.com/view?id=abc123');
  assert.notEqual(normalizeJobUrl('https://in.talent.com/view?id=1'), normalizeJobUrl('https://in.talent.com/view?id=2'));
});

test('canonical employer fingerprints merge NCR Voyix/NCR title variants', () => {
  const { jobFingerprint } = require('../src/core/dedup');
  assert.equal(jobFingerprint('NCR Voyix', 'Software Engineer II'), jobFingerprint('ncr', 'Software Engineer (II)'));
  assert.equal(jobFingerprint('SWIGGY', 'Software Dev Engineer I'), jobFingerprint('Swiggy', 'Software Dev Engineer 1'));
});

test('requeued lifts a manual-apply hand-off but never an applied / unconfirmed row', () => {
  const file = tempCsvPath();
  const log = createLog(file);
  const handed = 'https://example.com/job/handed';
  const applied = 'https://example.com/job/applied';
  const unconf = 'https://example.com/job/unconf';
  const row = (job_url, status) => log.append({ site: 'Naukri', job_title: `T ${status} ${job_url}`, company: 'C', job_url, status, notes: status });
  row(handed, 'manual-apply');
  row(applied, 'applied');
  row(unconf, 'unconfirmed');
  const failed = 'https://example.com/job/failed';
  row(failed, 'failed'); row(failed, 'failed');
  for (const u of [handed, applied, unconf, failed]) row(u, 'requeued');
  const fresh = createLog(file);
  assert.equal(fresh.has(handed), false);
  assert.equal(fresh.priorDisposition(handed), null);
  assert.equal(fresh.has(applied), true);
  assert.equal(fresh.has(unconf), true);
  assert.equal(fresh.priorDisposition(failed), null);
});
