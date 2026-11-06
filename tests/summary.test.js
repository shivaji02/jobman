const test = require('node:test');
const assert = require('node:assert/strict');
const { renderTable } = require('../src/core/table');
const { formatRunSummary, skipBucket } = require('../src/core/summary');

test('renderTable aligns columns and clips long cells', () => {
  const t = renderTable(['A', 'B'], [['x', 'y'.repeat(50)]], [5, 10]);
  const lines = t.split('\n');
  assert.equal(new Set(lines.map((l) => l.length)).size, 1);
  assert.ok(t.includes('…'));
});

test('skipBucket groups reasons', () => {
  assert.equal(skipBucket('Mumbai region excluded'), 'Mumbai excluded');
  assert.equal(skipBucket('experience 5-8 Yrs out of range'), 'Experience out of range');
  assert.equal(skipBucket('score 29 below threshold'), 'Not a matching role');
});

test('formatRunSummary shows applied, open and failed sections', () => {
  const out = formatRunSummary({
    naukri: { reviewed: 5, applied: [{ title: 'RN Dev', company: 'Acme' }], manualApply: [{ title: 'FE', company: 'Beta', companyUrl: 'https://x.test' }], failed: [{ title: 'BE', company: 'C', reason: 'boom' }], skipped: [{ reason: 'Mumbai region excluded' }] },
  });
  for (const s of ['RUN SUMMARY', 'RN Dev', 'https://x.test', 'boom', 'Mumbai excluded', 'TOTAL']) assert.ok(out.includes(s), s);
});
