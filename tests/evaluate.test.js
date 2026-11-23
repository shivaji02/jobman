const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateJob, unresolved, isRoleFamily, evidenceSnippets } = require('../src/core/evaluate');

const LONG_RN = `We are hiring a mobile engineer to build our consumer app.
You will work with React Native, TypeScript and Redux, shipping to the Play Store and App Store.
Experience: 2-4 years building production mobile apps. Familiarity with Node.js APIs is a plus.
`.repeat(3);

// Real records from the 2026-11-09 run (checkpoint.json), card evidence only.
test('Nov 9 false negatives become needs_enrichment, not rejections', () => {
  for (const [title, company] of [
    ['Mobile Application Developer', 'MoneyView'],
    ['Full Stack Developer', 'Wissen Technology'],
    ['Mobile Developer (Android & iOS)', 'turium ai'],
    ['Software Development Engineer (SDE) – Mobile (iOS & Android) with Web', 'Niti Aide'],
    ['Hybrid Mobile Application Developer', 'HCL TechBee'],
  ]) {
    const v = evaluateJob({ title, description: `${title} ${company} Hyderabad`, source: 'card' });
    assert.equal(v.decision, 'needs_enrichment', `${title}: ${v.reason}`);
    assert.equal(v.evidence, 'card');
  }
});

test('Expo titles count as React Native (was title=0, score 29 on LinkedIn)', () => {
  const v = evaluateJob({ title: 'Expo (Android/iOS) developer', description: 'Expo (Android/iOS) developer Rentesy', source: 'card' });
  assert.equal(v.decision, 'eligible', v.reason);
  assert.equal(v.evidence, 'card'); // provisional — the pipeline still reads the full posting
  const { calculateTitleScore } = require('../src/bots/linkedin');
  assert.equal(calculateTitleScore('Expo (Android/iOS) developer'), 100);
  assert.equal(calculateTitleScore('Mobile Application Developer'), 90);
});

test('the same jobs are decided on the full description once it is read', () => {
  const ok = evaluateJob({ title: 'Mobile Application Developer', description: LONG_RN, source: 'full' });
  assert.equal(ok.decision, 'eligible', ok.reason);
  assert.equal(ok.evidence, 'full');
  const rails = evaluateJob({
    title: 'Full Stack Ruby on Rails Engineer',
    description: 'Build features in Ruby on Rails and PostgreSQL. Hotwire, RSpec, Sidekiq. 2+ years of Rails experience required. '.repeat(6),
    source: 'full',
  });
  assert.equal(rails.decision, 'rejected', rails.reason);
  assert.match(rails.reason, /full description/);
});

test('definitive rules are unchanged: seniority, .NET, stated experience reject on card evidence', () => {
  assert.equal(evaluateJob({ title: 'Senior React Native Developer', source: 'card' }).decision, 'rejected');
  assert.equal(evaluateJob({ title: '.NET Full Stack Developer', source: 'card' }).decision, 'rejected');
  assert.equal(evaluateJob({ title: 'React Native Developer', experienceText: '5-8 Yrs', source: 'card' }).decision, 'rejected');
  assert.equal(evaluateJob({ title: 'React Native Developer', experienceText: '5-8 Yrs', source: 'card' }).category, 'experience');
});

test('Java-only on a card is inconclusive for a full-stack title, definitive on the full description', () => {
  const card = evaluateJob({ title: 'Java Full Stack Developer', description: 'Java Spring Boot Hyderabad', source: 'card' });
  assert.equal(card.decision, 'needs_enrichment');
  const full = evaluateJob({ title: 'Java Full Stack Developer', description: 'Java, Spring Boot, Hibernate, Oracle, microservices. '.repeat(12), source: 'full' });
  assert.equal(full.decision, 'rejected');
});

test('titles outside the role family are rejected on card evidence (no fetch)', () => {
  const v = evaluateJob({ title: 'Recruitment Specialist', description: 'IT recruiter', source: 'card' });
  assert.equal(v.decision, 'rejected');
  assert.equal(isRoleFamily('US IT Recruiter'), false);
});

test('a short "full" description is still treated as card evidence', () => {
  const v = evaluateJob({ title: 'Full Stack Developer', description: 'Full stack role', source: 'full' });
  assert.equal(v.evidence, 'card');
  assert.equal(v.decision, 'needs_enrichment');
});

test('experience stated only in the description is applied once it is read', () => {
  const desc = `${LONG_RN.replace(/2-4 years/g, '6+ years')}`;
  const v = evaluateJob({ title: 'React Native Developer', description: desc, source: 'full' });
  assert.equal(v.decision, 'rejected');
  assert.equal(v.category, 'experience');
});

test('unresolved(): card-eligible stays eligible, inconclusive becomes needs_enrichment with the reason', () => {
  const elig = evaluateJob({ title: 'React Native Developer', description: 'React Native TypeScript', source: 'card' });
  assert.equal(elig.decision, 'eligible');
  assert.equal(unresolved(elig, 'HTTP 403').decision, 'eligible');
  const inc = evaluateJob({ title: 'Mobile Application Developer', source: 'card' });
  const u = unresolved(inc, 'timeout');
  assert.equal(u.decision, 'needs_enrichment');
  assert.match(u.reason, /insufficient evidence — full description unavailable \(timeout\)/);
});

test('stale postings reject', () => {
  assert.equal(evaluateJob({ title: 'React Native Developer', postedDaysAgo: 45, source: 'card' }).category, 'stale');
});

test('evidenceSnippets picks stack/experience lines', () => {
  const s = evidenceSnippets(LONG_RN);
  assert.ok(s.length > 0 && s.some((l) => /React Native/.test(l)));
});

test('a "Freshers" title is outside the 1.5–3.5 yr overlap (existing rule, title now parsed)', () => {
  const v = evaluateJob({ title: 'Full Stack Developer - Freshers - Onsite', description: 'React Node '.repeat(60), source: 'full' });
  assert.equal(v.decision, 'rejected');
  assert.equal(v.category, 'experience');
});

test('stackBalance flags descriptions where another stack dominates (flag only, not a rejection)', () => {
  const { stackBalance } = require('../src/core/filter');
  const b = stackBalance('Python, Django, Django REST, Python scripting, Angular, and some React.');
  assert.equal(b.dominant, 'other');
  assert.equal(stackBalance('React Native, TypeScript, Node.js, Expo, Java a plus').dominant, 'ours');
});
