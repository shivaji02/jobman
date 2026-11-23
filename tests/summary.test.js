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
  assert.equal(skipBucket('score 29 below threshold'), 'Role / stack threshold (evidence level unspecified)');
  assert.equal(skipBucket('score 50 below threshold'), 'Near match — review JD (below apply threshold)');
  assert.equal(skipBucket('score 10 below threshold (full description)'), 'Role / stack below threshold (full description checked)');
  assert.equal(skipBucket('score 10 below threshold (listing card)'), 'Needs enrichment (listing card only)');
});

test('formatRunSummary shows applied, open and failed sections', () => {
  const out = formatRunSummary({
    naukri: { reviewed: 5, applied: [{ title: 'RN Dev', company: 'Acme' }], manualApply: [{ title: 'FE', company: 'Beta', companyUrl: 'https://x.test' }], failed: [{ title: 'BE', company: 'C', reason: 'boom' }], skipped: [{ reason: 'Mumbai region excluded' }] },
  });
  for (const s of ['RUN SUMMARY', 'RN Dev', 'https://x.test', 'boom', 'Mumbai excluded', 'TOTAL']) assert.ok(out.includes(s), s);
});

test('manual queue deduplicates ATS syndication and hides transient response/form URLs', () => {
  const out = formatRunSummary({
    naukri: { reviewed: 1, manualApply: [{ title: 'Software Dev Engineer I', company: 'Swiggy', url: 'https://www.naukri.com/job-listings-1', companyUrl: 'https://jobs.smartrecruiters.com/swiggy/6000000001552647' }] },
    careers: { reviewed: 1, manualApply: [{ title: 'Software Dev Engineer I', company: 'SWIGGY', url: 'https://jobs.smartrecruiters.com/SWIGGY/6000000001552647', companyUrl: 'https://jobs.smartrecruiters.com/oneclick-ui/company/SWIGGY/publication/x' }] },
    indeed: { reviewed: 1, manualApply: [{ title: 'React Native', company: 'Acme', url: 'https://in.indeed.com/viewjob?jk=1234567890abcdef', companyUrl: 'https://smartapply.indeed.com/beta/indeedapply/form/demographic-questions/1' }] },
  });
  assert.equal((out.match(/Software Dev Engineer I/g) || []).length, 1);
  assert.ok(out.includes('https://jobs.smartrecruiters.com/swiggy/6000000001552647'));
  assert.ok(out.includes('https://in.indeed.com/viewjob?jk=1234567890abcdef'));
  assert.ok(!out.includes('smartapply.indeed.com'));
  assert.ok(!out.includes('oneclick-ui'));
});
