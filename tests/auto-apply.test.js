const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { autoApplyGate, autoApplyEnabled, isEligibleLocation, classifyPrepared } = require('../src/core/auto-apply');

const GOOD_TEXT = 'We are hiring a React Native Engineer with React, TypeScript, Node.js and Expo experience. '.repeat(8);
const OTHER_TEXT = 'Angular, Vue, Django, Flask and Ruby on Rails are the core stack. Angular Vue Django Flask Rails. '.repeat(10) + ' React once.';

function resumeFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-'));
  const f = path.join(dir, 'shivajirn02.pdf');
  fs.writeFileSync(f, '%PDF-1.4 test');
  return f;
}

function good(overrides = {}) {
  return {
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    portal: 'careers',
    title: 'React Native Engineer',
    company: 'Acme',
    location: 'Hyderabad, Telangana, India (Hybrid)',
    verdict: { decision: 'eligible', evidence: 'full', reason: 'score 70 (full description)' },
    enrichment: { ok: true, cached: false },
    fullText: GOOD_TEXT,
    resume: resumeFile(),
    flags: [],
    priorApplied: false,
    supportedPortal: true,
    ...overrides,
  };
}

test('auto-apply is enabled only by JOBMAN_AUTO_APPLY=1', () => {
  assert.equal(autoApplyEnabled({ JOBMAN_AUTO_APPLY: '1' }), true);
  assert.equal(autoApplyEnabled({ JOBMAN_AUTO_APPLY: '0' }), false);
  assert.equal(autoApplyEnabled({}), false);
});

test('a fully verified, matching, Hyderabad job passes with no blockers', () => {
  const r = autoApplyGate(good());
  assert.equal(r.eligible, true, r.blockers.join('; '));
  assert.deepEqual(r.blockers, []);
});

test('a job whose description was served from cache is not verified active', () => {
  const r = autoApplyGate(good({ enrichment: { ok: true, cached: true } }));
  assert.equal(r.eligible, false);
  assert.match(r.blockers.join(' '), /not verified active/);
});

test('a card-only decision never auto-submits', () => {
  const r = autoApplyGate(good({ verdict: { decision: 'eligible', evidence: 'card', reason: 'score 40 (listing card)' } }));
  assert.equal(r.eligible, false);
  assert.match(r.blockers.join(' '), /listing-card/);
});

test('a previous application to the same job blocks auto-submission', () => {
  const r = autoApplyGate(good({ priorApplied: true }));
  assert.equal(r.eligible, false);
  assert.match(r.blockers.join(' '), /previous application/);
});

test('a missing resume file blocks submission (no default resume is substituted)', () => {
  const r = autoApplyGate(good({ resume: '/nowhere/missing.pdf' }));
  assert.equal(r.eligible, false);
  assert.match(r.blockers.join(' '), /missing on disk/);
});

test('no resume selected blocks submission', () => {
  const r = autoApplyGate(good({ resume: '' }));
  assert.equal(r.eligible, false);
  assert.match(r.blockers.join(' '), /no resume selected/);
});

test('a posting whose description is mainly another stack is not auto-submitted', () => {
  const r = autoApplyGate(good({ fullText: OTHER_TEXT, title: 'Frontend Engineer' }));
  assert.equal(r.eligible, false);
  assert.match(r.blockers.join(' '), /not the candidate's stack/);
});

test('an unsupported submit route is blocked, not guessed', () => {
  const r = autoApplyGate(good({ supportedPortal: false, portal: 'instahyre' }));
  assert.equal(r.eligible, false);
  assert.match(r.blockers.join(' '), /no supported submit route/);
});

test('location: the user\'s South India cities and India-remote pass; Mumbai, north, overseas and unknown fail', () => {
  assert.equal(isEligibleLocation('Hyderabad, Telangana').ok, true);
  assert.equal(isEligibleLocation('Hybrid - Hyderabad, Bengaluru, Chennai').ok, true);
  assert.equal(isEligibleLocation('Remote', 'Remote role open to candidates based in India').basis, 'india-remote');
  assert.equal(isEligibleLocation('Remote', 'Remote, US only').ok, false);
  assert.equal(isEligibleLocation('Bengaluru').basis, 'bangalore');
  assert.equal(isEligibleLocation('Chennai, Tamil Nadu').ok, true);
  assert.equal(isEligibleLocation('Kochi, Kerala').ok, true);
  assert.equal(isEligibleLocation('Pune, onsite', '', 'Unknown Startup').ok, false);
  assert.equal(isEligibleLocation('Pune', '', 'Razorpay').ok, true);
  assert.equal(isEligibleLocation('Mumbai').ok, false);
  assert.equal(isEligibleLocation('Gurgaon').ok, false);
  assert.equal(isEligibleLocation('').ok, false, 'missing location is not confirmed');
});

test('an unanswered screening question is deferred to the adapter, never answered by the gate', () => {
  const r = autoApplyGate(good({ flags: ['current CTC not in profile — a form asking for it is handed to you'] }));
  assert.equal(r.eligible, true);
  assert.equal(r.checks.unknownAnswersDeferred, true);
});

test('classifyPrepared: prior application → ALREADY_APPLIED', () => {
  const c = classifyPrepared({ url: 'https://x.example/a', portal: 'naukri', title: 'RN', company: 'A', location: 'Hyderabad' }, { priorApplied: true });
  assert.equal(c.category, 'ALREADY_APPLIED');
});

test('classifyPrepared: closed posting → EXPIRED_OR_INELIGIBLE', () => {
  const c = classifyPrepared({ url: 'https://x.example/a', portal: 'careers', title: 'RN', company: 'A', location: 'Hyderabad' }, { live: { closed: true, reason: '404' }, supportedPortal: true });
  assert.equal(c.category, 'EXPIRED_OR_INELIGIBLE');
});

test('classifyPrepared: unsupported portal → NEEDS_USER_INPUT', () => {
  const c = classifyPrepared({ url: 'https://x.example/a', portal: 'instahyre', title: 'RN', company: 'A', location: 'Hyderabad' }, { supportedPortal: false });
  assert.equal(c.category, 'NEEDS_USER_INPUT');
});

test('classifyPrepared: no live check ever yields READY (offline runs cannot prove a posting is open)', () => {
  const c = classifyPrepared({ url: 'https://x.example/a', portal: 'careers', title: 'RN', company: 'A', location: 'Hyderabad', resume: resumeFile() }, { supportedPortal: true, live: null });
  assert.equal(c.category, 'NEEDS_REVERIFICATION');
});

test('classifyPrepared: live-verified, eligible, Hyderabad, resume present → READY_FOR_AUTO_APPLY', () => {
  const c = classifyPrepared(
    { url: 'https://x.example/a', portal: 'careers', title: 'React Native Engineer', company: 'A', location: 'Hyderabad', resume: resumeFile() },
    { supportedPortal: true, live: { ok: true, fullText: GOOD_TEXT, verdict: { decision: 'eligible', evidence: 'full', reason: 'score 70' } } },
  );
  assert.equal(c.category, 'READY_FOR_AUTO_APPLY', c.reasons.join('; '));
});

test('classifyPrepared: live description rejected on the full text → EXPIRED_OR_INELIGIBLE', () => {
  const c = classifyPrepared(
    { url: 'https://x.example/a', portal: 'careers', title: 'Java Developer', company: 'A', location: 'Hyderabad', resume: resumeFile() },
    { supportedPortal: true, live: { ok: true, fullText: OTHER_TEXT, verdict: { decision: 'rejected', evidence: 'full', reason: 'java only' } } },
  );
  assert.equal(c.category, 'EXPIRED_OR_INELIGIBLE');
});
