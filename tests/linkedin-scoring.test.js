const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateTitleScore,
  calculateSeniorityScore,
  calculateKeywordScore,
  calculateLocationScore,
  calculateLinkedinScore,
  shouldApplyLinkedin,
  LINKEDIN_THRESHOLD,
} = require('../src/bots/linkedin');

test('linkedin title scoring prioritizes React Native and mobile roles', () => {
  assert.equal(calculateTitleScore('React Native Developer'), 100);
  assert.equal(calculateTitleScore('Mobile Engineer'), 90);
  assert.equal(calculateTitleScore('Frontend Engineer (React)'), 70);
  assert.equal(calculateTitleScore('Front-End Developer'), 70);
  assert.equal(calculateTitleScore('Full Stack Developer'), 60);
  assert.equal(calculateTitleScore('Backend Java Engineer'), 0);
});

test('linkedin seniority scoring distinguishes junior and senior roles', () => {
  assert.equal(calculateSeniorityScore('junior role with 0-2 years'), 40);
  assert.equal(calculateSeniorityScore('mid-level role for 2-4 years'), 50);
  assert.equal(calculateSeniorityScore('senior engineer'), 20);
  assert.equal(calculateSeniorityScore('lead platform engineer'), 10);
  assert.equal(calculateSeniorityScore('plain posting without level'), 25);
});

test('linkedin keyword scoring rewards relevant stack and clamps negatives', () => {
  assert.equal(calculateKeywordScore('React Native Node TypeScript remote India startup'), 50);
  assert.equal(calculateKeywordScore('senior lead architect principal 10+ years 8+ years'), 0);
});

test('linkedin location scoring rewards remote and India matches', () => {
  assert.equal(calculateLocationScore('Remote - India'), 50);
  assert.equal(calculateLocationScore('Bengaluru, Karnataka, India'), 40);
  assert.equal(calculateLocationScore('On-site, Pune'), 10);
  assert.equal(calculateLocationScore('Unknown'), 0);
});

test('linkedin aggregate scoring varies by job quality', () => {
  const rnJob = calculateLinkedinScore({
    title: 'React Native Developer',
    company: 'Acme',
    location: 'Remote - India',
    text: 'Build mobile apps with React Native, TypeScript, JavaScript, Node in a startup',
  });
  const seniorBackend = calculateLinkedinScore({
    title: 'Senior Backend Engineer',
    company: 'BigCorp',
    location: 'Berlin',
    text: 'Principal architect role, 10+ years, Java microservices',
  });
  const genericSoftware = calculateLinkedinScore({
    title: 'Software Engineer | Remote',
    company: 'Gamma',
    location: 'Remote - India',
    text: 'JavaScript and React',
  });
  const fullStack = calculateLinkedinScore({
    title: 'Full Stack Developer',
    company: 'ScaleUp',
    location: 'Hyderabad, India',
    text: 'React, Node, TypeScript, JavaScript, flexible remote hybrid team, 2-4 years',
  });

  assert.ok(rnJob.totalScore > 150, `expected RN score > 150, got ${rnJob.totalScore}`);
  assert.ok(fullStack.totalScore >= LINKEDIN_THRESHOLD, `expected Full Stack score >= ${LINKEDIN_THRESHOLD}, got ${fullStack.totalScore}`);
  assert.ok(seniorBackend.totalScore < LINKEDIN_THRESHOLD, `expected senior backend score < ${LINKEDIN_THRESHOLD}, got ${seniorBackend.totalScore}`);
  assert.ok(genericSoftware.totalScore < LINKEDIN_THRESHOLD, `expected generic software score < ${LINKEDIN_THRESHOLD}, got ${genericSoftware.totalScore}`);
  assert.equal(shouldApplyLinkedin(rnJob), true);
  assert.equal(shouldApplyLinkedin(seniorBackend), false);
});
