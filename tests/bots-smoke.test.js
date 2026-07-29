// Smoke test: every bot module loads and exposes run(). Catches syntax errors
// in the bots without needing a browser.
const test = require('node:test');
const assert = require('node:assert/strict');

for (const name of ['instahyre', 'naukri', 'linkedin', 'yourstory', 'wellfound']) {
  test(`bots/${name} loads and exports run()`, () => {
    const bot = require(`../src/bots/${name}`);
    assert.equal(typeof bot.run, 'function');
  });
}

test('bots/naukri pickExperienceYears follows junior vs mid rules', () => {
  const { pickExperienceYears, buildScreeningAnswers } = require('../src/bots/naukri');
  assert.equal(pickExperienceYears('0-2 years junior React Native'), '2.7');
  assert.equal(pickExperienceYears('fresher-friendly mobile role'), '2.7');
  assert.equal(pickExperienceYears('2-4 years mid-level React Native'), '3');
  assert.equal(pickExperienceYears('Senior React Native Developer'), '3');
  assert.equal(pickExperienceYears('React Native Developer'), '2.7');

  const answers = buildScreeningAnswers(
    { title: 'React Native Developer', experienceText: '2-4 Yrs' },
    { expected_ctc: '15-20 LPA' }
  );
  assert.equal(answers.relocate, 'Yes');
  assert.equal(answers.experience, '3');
  assert.equal(answers.notice, 'Immediate');
  assert.equal(answers.ctc, '15-20 LPA');
});

test('bots/yourstory searchUrl encodes query', () => {
  const { searchUrl } = require('../src/bots/yourstory');
  assert.match(searchUrl('react native'), /search=react%20native/);
});

test('bots/wellfound searchUrl uses role slug path', () => {
  const { searchUrl } = require('../src/bots/wellfound');
  assert.equal(searchUrl('react native developer'), 'https://wellfound.com/role/l/react-native/india');
  assert.equal(searchUrl('frontend engineer react'), 'https://wellfound.com/role/l/frontend-engineer/india');
});
