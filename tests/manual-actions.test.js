const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createManualActions, kindFromReason, KINDS } = require('../src/core/manual-actions');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ma-')), 'manual-actions.json');
}

test('blocker kinds are classified from the exact reason', () => {
  assert.equal(kindFromReason('CAPTCHA shown on the apply form'), KINDS.CAPTCHA);
  assert.equal(kindFromReason('login required to apply'), KINDS.AUTH);
  assert.equal(kindFromReason('resume upload failed on the form'), KINDS.RESUME_UPLOAD);
  assert.equal(kindFromReason('selected resume is missing on disk: /x.pdf'), KINDS.RESUME_UPLOAD);
  assert.equal(kindFromReason('unanswered required question: expected CTC'), KINDS.MISSING_INFO);
  assert.equal(kindFromReason('no supported submit route for instahyre'), KINDS.UNSUPPORTED_FORM);
  assert.equal(kindFromReason('posting not verified active in this run'), KINDS.VERIFICATION_FAILED);
  assert.equal(kindFromReason('submission uncertain — verify on the portal'), KINDS.SUBMISSION_UNCERTAIN);
  assert.equal(kindFromReason('something else entirely'), KINDS.OTHER);
});

test('one job is one entry: re-queueing updates it instead of duplicating', () => {
  const file = tmpFile();
  const ma = createManualActions({ file });
  ma.upsert({ url: 'https://boards.greenhouse.io/acme/jobs/1?utm=a', company: 'Acme', title: 'RN', exactReason: 'CAPTCHA shown', applicationUrl: 'https://boards.greenhouse.io/acme/jobs/1' });
  ma.upsert({ url: 'https://boards.greenhouse.io/acme/jobs/1?utm=b', company: 'Acme', title: 'RN', exactReason: 'login required' });
  const open = ma.list();
  assert.equal(open.length, 1);
  assert.equal(open[0].blockerKind, KINDS.AUTH, 'latest blocker wins');
  assert.equal(open[0].applicationUrl, 'https://boards.greenhouse.io/acme/jobs/1', 'direct application URL is kept');
  assert.ok(open[0].requiredUserAction.length > 0);
});

test('each entry carries the direct URL, the exact reason and the required user action', () => {
  const file = tmpFile();
  const ma = createManualActions({ file });
  const e = ma.upsert({ url: 'https://jobs.lever.co/beta/abc', company: 'Beta', title: 'Frontend', portal: 'careers', resume: '/r/shivajife02.pdf', exactReason: 'unsupported form: multi-step custom widget', companyUrl: 'https://jobs.lever.co/beta/abc/apply' });
  assert.equal(e.exactBlocker, 'unsupported form: multi-step custom widget');
  assert.equal(e.blockerKind, KINDS.UNSUPPORTED_FORM);
  assert.equal(e.resume, '/r/shivajife02.pdf');
  assert.match(e.requiredUserAction, /employer site|application URL/);
});

test('resolved entries leave the open list and stay in history', () => {
  const file = tmpFile();
  const ma = createManualActions({ file });
  ma.upsert({ url: 'https://x.example/j/1', company: 'X', title: 'RN', exactReason: 'captcha' });
  ma.resolve('https://x.example/j/1', 'applied by hand');
  assert.equal(ma.list().length, 0);
  assert.equal(ma.list({ status: 'resolved' }).length, 1);
  // a later re-queue does not reopen a resolved entry's resolution record
  const again = ma.upsert({ url: 'https://x.example/j/1', company: 'X', title: 'RN', exactReason: 'captcha' });
  assert.equal(again.status, 'resolved');
});

test('summary counts open actions by blocker kind', () => {
  const file = tmpFile();
  const ma = createManualActions({ file });
  ma.upsert({ url: 'https://x.example/a', company: 'A', exactReason: 'captcha' });
  ma.upsert({ url: 'https://x.example/b', company: 'B', exactReason: 'captcha' });
  ma.upsert({ url: 'https://x.example/c', company: 'C', exactReason: 'resume upload failed' });
  const s = ma.summary();
  assert.equal(s.open, 3);
  assert.equal(s.byKind.captcha, 2);
  assert.equal(s.byKind.resume_upload, 1);
});

test('a corrupted manual-actions file is never overwritten', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '[[broken');
  const ma = createManualActions({ file });
  assert.throws(() => ma.upsert({ url: 'https://x.example/z', exactReason: 'captcha' }), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '[[broken');
});
