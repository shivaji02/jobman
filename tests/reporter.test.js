const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { write } = require('../src/core/reporter');

test('reporter.write includes Manual Apply summary', () => {
  const date = `test-${Date.now()}`;
  const file = write(date, {
    naukri: {
      reviewed: 3,
      applied: [{ title: 'Full Stack Dev', company: 'Acme', url: 'https://naukri.com/1', evidence: { signal: 'selector #already-applied: Applied', screenshot: '' } }],
      manualApply: [
        {
          title: 'React Native Developer',
          company: 'Beta',
          url: 'https://naukri.com/2',
          companyUrl: 'https://boards.greenhouse.io/beta',
          resume: '/Users/neosoft/Downloads/Resumes/shivajirn02.pdf',
        },
      ],
      skipped: [],
      failed: [{ title: 'X', company: 'Y', url: 'https://naukri.com/3', reason: 'button not found' }],
    },
  });

  try {
    const md = fs.readFileSync(file, 'utf8');
    assert.match(md, /Manual Apply/);
    assert.match(md, /## Summary/);
    assert.match(md, /\*\*Applied:\*\* 1/);
    assert.match(md, /\*\*Manual Apply:\*\* 1/);
    assert.match(md, /\*\*Failed:\*\* 1/);
    assert.match(md, /boards\.greenhouse\.io\/beta/);
    assert.match(md, /shivajirn02\.pdf/);
    assert.match(md, /0 unaccounted/);
    assert.match(md, /#already-applied/); // evidence is printed next to the applied job
  } finally {
    fs.unlinkSync(file);
  }
});
