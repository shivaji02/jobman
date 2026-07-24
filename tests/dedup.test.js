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

test('append() appends immediately — one call, one row, no batching', () => {
  const file = tempCsvPath();
  const log = createLog(file);
  log.append({ site: 'A', job_title: 'T1', company: 'C1', job_url: 'u1', status: 'applied', notes: '' });
  log.append({ site: 'B', job_title: 'T2', company: 'C2', job_url: 'u2', status: 'applied', notes: '' });

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3); // header + 2 rows
});
