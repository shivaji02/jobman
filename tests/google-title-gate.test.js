const test = require('node:test');
const assert = require('node:assert/strict');
const { offTargetTitle } = require('../src/bots/google');

test('google leads with off-target titles are dropped before the live ATS read', () => {
  for (const t of ['Senior UX Designer, Digital Experience - Myworkday', 'Data Scientist- Gen AI - Myworkdayjobs', 'HIH - Co-Op/Intern (Non-US Only)', 'QA Automation - Manager - Myworkday', 'Program Management Analyst - Cigna']) {
    assert.equal(offTargetTitle(t), true, t);
  }
  for (const t of ['Software Developer II (Front-End) - Myworkday', 'Software Engineer II - Full Stack - Myworkday', 'React Native Developer', '', '(closed posting)']) {
    assert.equal(offTargetTitle(t), false, t);
  }
});
