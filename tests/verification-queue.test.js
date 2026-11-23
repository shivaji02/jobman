const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVerificationQueue, classifyVerificationError, nextDelayMs, STATES, MAX_ATTEMPTS } = require('../src/core/verification-queue');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-'));
  return path.join(dir, 'verification-queue.json');
}

test('enqueue persists the required fields and keeps the official URL and requisition id', () => {
  const file = tmpFile();
  const vq = createVerificationQueue({ file, now: () => Date.parse('2026-11-17T04:00:00Z') });
  vq.enqueue({ company: 'Acme', title: 'React Native Engineer', url: 'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/Hyderabad/RN_R-123?src=x', requisitionId: 'R-123', source: 'careers' }, { reason: 'description fetch failed' });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const [entry] = Object.values(saved.items);
  assert.equal(entry.company, 'Acme');
  assert.equal(entry.requisitionId, 'R-123');
  assert.equal(entry.source, 'careers');
  assert.equal(entry.state, STATES.NEEDS_VERIFICATION);
  assert.equal(entry.retryCount, 0);
  assert.ok(entry.firstDiscoveredAt);
  assert.ok(entry.url.startsWith('https://acme.wd1.myworkdayjobs.com'));
});

test('duplicate enqueues merge by normalized URL and never create a second entry', () => {
  const file = tmpFile();
  const vq = createVerificationQueue({ file });
  const a = vq.enqueue({ company: 'Acme', title: 'Frontend Engineer', url: 'https://boards.greenhouse.io/acme/jobs/42?utm=1' });
  const b = vq.enqueue({ company: 'Acme', title: 'Frontend Engineer', url: 'https://boards.greenhouse.io/acme/jobs/42?utm=2' });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(vq.list().length, 1);
});

test('duplicates also merge by company and requisition id when the URLs differ', () => {
  const file = tmpFile();
  const vq = createVerificationQueue({ file });
  vq.enqueue({ company: 'Acme', title: 'Frontend Engineer', url: 'https://a.example/job/1', requisitionId: 'REQ-9' });
  const second = vq.enqueue({ company: 'acme', title: 'Frontend Engineer', url: 'https://b.example/job/2', requisitionId: 'req-9' });
  assert.equal(second.created, false);
  assert.equal(vq.list().length, 1);
});

test('classifyVerificationError separates closed, blocked and transient failures', () => {
  assert.equal(classifyVerificationError({ closed: true, message: '404' }).classification, 'closed');
  assert.equal(classifyVerificationError(new Error('CAPTCHA challenge shown')).classification, 'blocked');
  assert.equal(classifyVerificationError(new Error('403 forbidden')).classification, 'blocked');
  assert.equal(classifyVerificationError({ rateLimited: true, retryable: true, message: '429' }).classification, 'transient');
  assert.equal(classifyVerificationError(new Error('ECONNRESET')).classification, 'transient');
  assert.equal(classifyVerificationError(new Error('something odd')).classification, 'unknown');
});

test('transient failures are retried with exponential backoff, capped', () => {
  assert.equal(nextDelayMs(1), 15 * 60_000);
  assert.equal(nextDelayMs(2), 30 * 60_000);
  assert.equal(nextDelayMs(3), 60 * 60_000);
  assert.equal(nextDelayMs(50), 6 * 60 * 60_000);
});

test('a transient failure schedules a retry; due() respects nextRetryAt', () => {
  const file = tmpFile();
  let clock = Date.parse('2026-11-17T04:00:00Z');
  const vq = createVerificationQueue({ file, now: () => clock });
  const { entry } = vq.enqueue({ company: 'Acme', title: 'RN', url: 'https://x.example/j/1' });
  assert.equal(vq.due(clock).length, 1);
  vq.recordAttempt(entry.key, { ok: false, error: Object.assign(new Error('503'), { status: 503, retryable: true }) });
  const after = vq.list()[0];
  assert.equal(after.state, STATES.NEEDS_VERIFICATION);
  assert.equal(after.retryCount, 1);
  assert.equal(vq.due(clock).length, 0, 'not due right after the failure');
  clock += nextDelayMs(1) + 1;
  assert.equal(vq.due(clock).length, 1, 'due once the backoff has passed');
});

test('retries are bounded: exhausted attempts move the job to MANUAL_ACTION', () => {
  const file = tmpFile();
  const vq = createVerificationQueue({ file });
  const { entry } = vq.enqueue({ company: 'Acme', title: 'RN', url: 'https://x.example/j/2' });
  let last;
  for (let i = 0; i < MAX_ATTEMPTS; i++) last = vq.recordAttempt(entry.key, { ok: false, error: Object.assign(new Error('timeout'), { retryable: true }) });
  assert.equal(last.state, STATES.MANUAL_ACTION);
  assert.match(last.manualReason, /after \d+ attempts/);
});

test('a closed posting is PERMANENTLY_UNAVAILABLE, never an active opening', () => {
  const file = tmpFile();
  const vq = createVerificationQueue({ file });
  const { entry } = vq.enqueue({ company: 'Acme', title: 'RN', url: 'https://x.example/j/3' });
  const after = vq.recordAttempt(entry.key, { ok: false, error: Object.assign(new Error('404 gone'), { closed: true }) });
  assert.equal(after.state, STATES.PERMANENTLY_UNAVAILABLE);
  assert.equal(vq.due(Date.now() + 1e9).length, 0);
});

test('a blocked verification (CAPTCHA/login) goes straight to manual review', () => {
  const file = tmpFile();
  const vq = createVerificationQueue({ file });
  const { entry } = vq.enqueue({ company: 'Acme', title: 'RN', url: 'https://x.example/j/4' });
  const after = vq.recordAttempt(entry.key, { ok: false, error: new Error('login required to view posting') });
  assert.equal(after.state, STATES.MANUAL_ACTION);
});

test('a successful re-read marks the entry VERIFIED_ACTIVE and it is no longer due', () => {
  const file = tmpFile();
  const vq = createVerificationQueue({ file });
  const { entry } = vq.enqueue({ company: 'Acme', title: 'RN', url: 'https://x.example/j/5' });
  const after = vq.recordAttempt(entry.key, { ok: true });
  assert.equal(after.state, STATES.VERIFIED_ACTIVE);
  assert.ok(after.verifiedAt);
  assert.equal(vq.due(Date.now() + 1e9).length, 0);
});

test('state survives a new process (recovery on a later run) and history is preserved', () => {
  const file = tmpFile();
  const first = createVerificationQueue({ file });
  first.enqueue({ company: 'Acme', title: 'RN', url: 'https://x.example/j/6' });
  const { entry } = first.enqueue({ company: 'Beta', title: 'Web Dev', url: 'https://x.example/j/7' });
  first.recordAttempt(entry.key, { ok: false, error: new Error('ECONNRESET') });
  const second = createVerificationQueue({ file });
  assert.equal(second.list().length, 2);
  const beta = second.list().find((e) => e.company === 'Beta');
  assert.equal(beta.retryCount, 1);
  assert.equal(beta.state, STATES.NEEDS_VERIFICATION);
  assert.ok(second.load().events.length >= 3, 'events are kept');
});

test('a corrupted queue file is never overwritten with an empty state', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ not json');
  const vq = createVerificationQueue({ file });
  assert.throws(() => vq.enqueue({ company: 'Acme', title: 'RN', url: 'https://x.example/j/8' }), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json', 'the damaged file is left as it was');
});

test('an empty queue file is refused rather than treated as fresh', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '');
  const vq = createVerificationQueue({ file });
  assert.throws(() => vq.enqueue({ company: 'Acme', title: 'RN', url: 'https://x.example/j/9' }), /empty/);
});
