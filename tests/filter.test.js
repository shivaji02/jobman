const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreJob, shouldApply, parseExperienceRange, TARGET_EXP } = require('../src/core/filter');

test('parseExperienceRange handles common formats', () => {
  assert.deepEqual(parseExperienceRange('3-5 Yrs'), { min: 3, max: 5 });
  assert.deepEqual(parseExperienceRange('2 - 6 years'), { min: 2, max: 6 });
  assert.deepEqual(parseExperienceRange('0-2 Yrs'), { min: 0, max: 2 });
  assert.deepEqual(parseExperienceRange('2 to 6 years'), { min: 2, max: 6 });
  assert.deepEqual(parseExperienceRange('5+ years'), { min: 5, max: Infinity });
  assert.deepEqual(parseExperienceRange('3 years'), { min: 3, max: 3 });
  assert.equal(parseExperienceRange('not specified'), null);
  assert.equal(parseExperienceRange(''), null);
  assert.equal(parseExperienceRange(null), null);
});

test('scoreJob rewards React Native / mobile titles highly', () => {
  const score = scoreJob({
    title: 'React Native Developer',
    description: 'Build cross-platform apps using React Native and TypeScript',
    experienceText: '2-4 Yrs',
  });
  assert.ok(score >= 60, `expected score >= 60, got ${score}`);
});

test('scoreJob rewards frontend/full-stack roles that mention our stack', () => {
  // 25 (title "React") + 20 (stack) + 10 (experience overlap) = 55, at the new
  // 55 threshold — frontend/full-stack roles now reach the bar.
  const score = scoreJob({
    title: 'Frontend Engineer (React)',
    description: 'React, TypeScript, REST APIs',
    experienceText: '2-3 Yrs',
  });
  assert.equal(score, 55);
  assert.equal(shouldApply(score), true);
});

test('scoreJob hard rejects senior/staff/lead titles', () => {
  const score = scoreJob({ title: 'Senior React Native Developer', experienceText: '2-4 Yrs' });
  assert.equal(score, -100);
});

test('scoreJob hard rejects level-numbered senior titles like SDE 3', () => {
  assert.equal(scoreJob({ title: 'SDE 3 - React Native' }), -100);
  assert.equal(scoreJob({ title: 'SDE-III (Mobile)' }), -100);
  assert.equal(scoreJob({ title: 'Software Engineer III - React' }), -100);
});

test('scoreJob keeps junior/mid level-numbered titles eligible', () => {
  assert.ok(scoreJob({ title: 'SDE 1 - React Native' }) >= 55);
  assert.ok(scoreJob({ title: 'React Native Developer 2' }) >= 55);
  assert.ok(scoreJob({ title: 'React Native Developer', experienceText: '3-5 Yrs' }) >= 55);
});

test('scoreJob scores React JS / React.js titles at +25', () => {
  // React title (25) + React stack (20) + no exp (10) = 55
  const score = scoreJob({
    title: 'React JS Developer',
    description: 'Build web UIs with React and TypeScript',
  });
  assert.equal(score, 55);
  assert.equal(shouldApply(score), true);
});

test('scoreJob hard rejects .NET roles', () => {
  const score = scoreJob({ title: '.NET Developer', description: 'C# and .NET Core' });
  assert.equal(score, -100);
});

test('scoreJob hard rejects pure native iOS/Android roles', () => {
  const score = scoreJob({ title: 'iOS Developer', description: 'Swift, UIKit, Objective-C' });
  assert.equal(score, -100);
});

test('scoreJob does not reject hybrid native roles that mention React Native', () => {
  const score = scoreJob({
    title: 'Mobile Developer',
    description: 'React Native, some native Swift/Kotlin modules',
    experienceText: '2-4 Yrs',
  });
  assert.ok(score > 0, `expected positive score, got ${score}`);
});

test('scoreJob hard rejects Java-only backend roles', () => {
  const score = scoreJob({ title: 'Java Backend Engineer', description: 'Spring Boot, Java, Hibernate' });
  assert.equal(score, -100);
});

test('scoreJob hard rejects when minimum experience exceeds target max', () => {
  const score = scoreJob({ title: 'React Native Developer', experienceText: '5-8 Yrs' });
  assert.equal(score, -100);
});

test('shouldApply uses a 55 threshold by default', () => {
  assert.equal(shouldApply(55), true);
  assert.equal(shouldApply(54), false);
  assert.equal(shouldApply(-100), false);
});

test('shouldApply accepts a custom threshold', () => {
  assert.equal(shouldApply(50, 40), true);
  assert.equal(shouldApply(30, 40), false);
});

test('TARGET_EXP matches candidate profile range', () => {
  assert.deepEqual(TARGET_EXP, { min: 1.5, max: 3.5 });
});
