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

test('bots/naukri selectResume picks RN vs Full Stack by title keywords', () => {
  const { selectResume, RESUME_RN, RESUME_FS } = require('../src/bots/naukri');
  assert.equal(selectResume('React Native Developer'), RESUME_RN);
  assert.equal(selectResume('react-native engineer'), RESUME_RN);
  assert.equal(selectResume('Mobile Developer'), RESUME_RN);
  assert.equal(selectResume('iOS Native Engineer'), RESUME_RN);
  assert.equal(selectResume('Full Stack Developer (React + Node)'), RESUME_FS);
  assert.equal(selectResume('Frontend Engineer (React)'), RESUME_FS);
});

test('bots/naukri extractCompanyUrl + handleExternalATS', () => {
  const {
    extractCompanyUrl,
    handleExternalATS,
    ExternalAtsError,
    RESUME_RN,
  } = require('../src/bots/naukri');

  const err = new ExternalAtsError('https://boards.greenhouse.io/acme/jobs/1');
  assert.equal(extractCompanyUrl(err), 'https://boards.greenhouse.io/acme/jobs/1');
  assert.equal(
    extractCompanyUrl(new Error('redirected to https://jobs.lever.co/acme')),
    'https://jobs.lever.co/acme'
  );
  assert.equal(extractCompanyUrl(new Error('external ATS (apply on company site)')), '');

  const entry = handleExternalATS(
    { title: 'React Native Developer', company: 'Acme', url: 'https://www.naukri.com/job-1' },
    err
  );
  assert.equal(entry.companyUrl, 'https://boards.greenhouse.io/acme/jobs/1');
  assert.equal(entry.resume, RESUME_RN);
  assert.match(entry.reason, /manual-apply/);
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

test('bots/wellfound selectResume picks RN vs general resume', () => {
  const { selectResume, RESUME_RN, RESUME_FS } = require('../src/bots/wellfound');
  assert.equal(selectResume('React Native Developer'), RESUME_RN);
  assert.equal(selectResume('Mobile Engineer'), RESUME_RN);
  assert.equal(selectResume('Software Engineer', 'Work on native mobile experiences'), RESUME_RN);
  assert.equal(selectResume('Frontend Engineer (React)'), RESUME_FS);
});

test('bots/wellfound extractCompanyUrl + buildManualApplyEntry', () => {
  const {
    extractCompanyUrl,
    buildManualApplyEntry,
    ExternalAtsError,
    RESUME_RN,
    RESUME_FS,
  } = require('../src/bots/wellfound');

  const err = new ExternalAtsError('https://jobs.lever.co/acme/123');
  assert.equal(extractCompanyUrl(err), 'https://jobs.lever.co/acme/123');
  assert.equal(
    extractCompanyUrl(new Error('manual apply here: https://boards.greenhouse.io/acme/jobs/1')),
    'https://boards.greenhouse.io/acme/jobs/1'
  );
  assert.equal(extractCompanyUrl(new Error('no external url present')), '');

  const manual = buildManualApplyEntry(
    {
      title: 'React Native Developer',
      company: 'Acme',
      url: 'https://wellfound.com/jobs/1',
      text: 'React Native mobile app role',
    },
    'https://jobs.lever.co/acme/123'
  );
  assert.equal(manual.companyUrl, 'https://jobs.lever.co/acme/123');
  assert.equal(manual.resume, RESUME_RN);
  assert.match(manual.reason, /manual-apply/);

  const fallback = buildManualApplyEntry(
    {
      title: 'Frontend Engineer',
      company: 'Beta',
      url: 'https://wellfound.com/jobs/2',
      text: 'React frontend platform role',
    },
    ''
  );
  assert.equal(fallback.companyUrl, 'https://wellfound.com/jobs/2');
  assert.equal(fallback.resume, RESUME_FS);
});
