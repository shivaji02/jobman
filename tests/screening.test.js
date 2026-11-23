/**
 * Screening answers come only from the profile — never invented.
 * Questions below are real ones from data/applied_jobs_log.csv.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { answerFor, planAnswers, lakhsFrom, localPhone } = require('../src/core/screening');

const profile = {
  name: 'Shivaji Mandapati',
  email: 'me@example.com',
  phone: '+91-8978577031',
  experience_years: 2.7,
  notice_period_days: 0,
  expected_ctc: '15-20 LPA',
  current_ctc: '',
  willing_to_relocate: true,
  available_immediate: true,
  serving_notice: false,
};

test('LinkedIn / GitHub URLs come from linkedin_url / github_url (candidate.json shape)', () => {
  const p = { ...profile, linkedin_url: 'https://linkedin.com/in/x', github_url: 'https://github.com/x' };
  assert.equal(answerFor('LinkedIn Profile URL', { type: 'text' }, p), 'https://linkedin.com/in/x');
  assert.equal(answerFor('GitHub', { type: 'text' }, p), 'https://github.com/x');
  assert.equal(answerFor('LinkedIn Profile URL', { type: 'text' }, profile), null);
});

test('earliest start date is answered for an immediate joiner (LinkedIn 2026-11-22 stall)', () => {
  assert.equal(answerFor('Earliest start date? *', { type: 'text' }, profile), 'Immediately');
  assert.match(answerFor('Earliest start date', { type: 'date' }, profile), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(answerFor('Earliest start date', { type: 'text' }, { ...profile, available_immediate: false, notice_period_days: 30 }), null);
});

test('current location only from profile.current_location', () => {
  assert.equal(answerFor('Current location', { type: 'text' }, profile), null);
  assert.equal(answerFor('Current location', { type: 'text' }, { ...profile, current_location: 'Hyderabad, Telangana' }), 'Hyderabad, Telangana');
});

test('custom_answers (user-written) answer matching questions', () => {
  const p = { ...profile, custom_answers: [{ match: 'reason for (job )?change', answer: 'Looking for product work' }] };
  assert.equal(answerFor('Reason for job change?', { type: 'textarea' }, p), 'Looking for product work');
  assert.equal(answerFor('Reason for job change?', { type: 'textarea' }, profile), null);
});

test('phone number is filled from profile (34 blocked applications)', () => {
  assert.equal(answerFor('Mobile phone number*', { type: 'tel' }, profile), '8978577031');
  assert.equal(localPhone('+91 89785 77031'), '8978577031');
});

test('skill-years questions are NEVER answered with total experience', () => {
  assert.equal(answerFor('How many years of work experience do you have with Kubernetes?', { type: 'number' }, profile), null);
  assert.equal(answerFor('How many years of work experience do you have with PostgreSQL?', { type: 'number' }, profile), null);
});

test('skill-years questions use profile.skill_years when the user provides them', () => {
  const p = { ...profile, skill_years: { 'React Native': 2.5, react: 2, PostgreSQL: 1 } };
  assert.equal(answerFor('How many years of work experience do you have with React Native?', { type: 'number' }, p), '2');
  assert.equal(answerFor('How many years of work experience do you have with React.js?', { type: 'number' }, p), '2');
  assert.equal(answerFor('How many years of work experience do you have with Postgres?', { type: 'number' }, p), '1');
  assert.equal(answerFor('How many years of work experience do you have with Kubernetes?', { type: 'number' }, p), null);
});

test('total experience questions use experience_years (whole years, never rounded up)', () => {
  assert.equal(answerFor('How many years of Engineering experience do you currently have?', { type: 'number' }, profile), '2');
  assert.equal(answerFor('Total years of experience', { type: 'select', options: ['0-1 years', '1-3 years', '3-5 years'] }, profile), '1-3 years');
});

test('current CTC is left for the user when the profile has none', () => {
  assert.equal(answerFor('What is your current CTC in LPA?', { type: 'number' }, profile), null);
  assert.equal(answerFor('Current ctc', { type: 'text' }, profile), null);
  assert.equal(answerFor('What is your current CTC in LPA?', { type: 'number' }, { ...profile, current_ctc: '9.5 LPA' }), '9.5');
});

test('expected CTC comes from profile, numeric fields get lakhs', () => {
  assert.equal(answerFor('What is your expected CTC in LPA?', { type: 'number' }, profile), '15');
  assert.equal(answerFor('What is your ETC?', { type: 'text' }, profile), '15-20 LPA');
  assert.equal(lakhsFrom('15-20 LPA'), 15);
});

test('notice period variants', () => {
  assert.equal(answerFor('How many days of notice period do you have?', { type: 'number' }, profile), '0');
  assert.equal(answerFor('Notice Period(in days)(90 days is preferred)', { type: 'text' }, profile), '0');
  assert.equal(answerFor('What is your notice period?', { type: 'select', options: ['Immediate', '15 days', '30 days', '60+ days'] }, profile), 'Immediate');
  assert.equal(answerFor('Are you currently serving notice?', { type: 'radio', options: ['Yes', 'No'] }, profile), 'No');
});

test('yes/no relocation and immediate joining', () => {
  assert.equal(answerFor('Are you willing to relocate to Hyderabad?', { type: 'radio', options: ['Yes', 'No'] }, profile), 'Yes');
  assert.equal(answerFor('Can you join immediately?', { type: 'radio', options: ['Yes', 'No'] }, profile), 'Yes');
});

test('unknown questions are not guessed', () => {
  assert.equal(answerFor('This role is based in the Hyderabad office. Are you currently based in Hyderabad?', { type: 'radio', options: ['Yes', 'No'] }, profile), null);
  assert.equal(answerFor('Do you hold an AWS certification?', { type: 'radio', options: ['Yes', 'No'] }, profile), null);
});

test('planAnswers reports required questions it cannot answer', () => {
  const { answers, missing } = planAnswers(
    [
      { id: 'a', question: 'Mobile phone number*', type: 'tel', required: true },
      { id: 'b', question: 'What is your current CTC?', type: 'text', required: true },
      { id: 'c', question: 'Cover letter', type: 'textarea', required: false },
    ],
    profile
  );
  assert.deepEqual(answers, { a: '8978577031' });
  assert.deepEqual(missing, ['What is your current CTC?']);
});

test('Naukri questionnaire: interview availability and unlisted skill-years go to the user', () => {
  const { missing } = planAnswers(
    [
      { id: '1', question: 'How many years of experience do you have in React.Js?', type: 'text', required: true },
      { id: '2', question: 'Are you available to take an Interview on Saturday (Virtual Round)?', type: 'radio', options: ['Yes', 'No'], required: true },
      { id: '3', question: 'What is your notice period?', type: 'text', required: true },
    ],
    profile
  );
  assert.deepEqual(missing, [
    'How many years of experience do you have in React.Js?',
    'Are you available to take an Interview on Saturday (Virtual Round)?',
  ]);
});

test('notice period radio with "Available now" (real Naukri options)', () => {
  const options = ['Available now', '1 week', '2 weeks', '3 weeks', '1 month', '1.5 month', '2 months', '3 months'];
  assert.equal(answerFor('What is your Notice Period?', { type: 'radio', options }, profile), 'Available now');
});

test('frontend / fullstack / HTML5 skill years and last working day (Naukri 2026-11-23 stalls)', () => {
  const p = {
    ...profile,
    last_working_day: '2026-11-03',
    skill_years: { 'Fullstack Development': 3, 'Frontend Development': 3, HTML5: 3, CSS: 3, React: 3 },
  };
  assert.equal(answerFor('How many years of experience do you have in Fullstack Development?', { type: 'text' }, p), '3');
  assert.equal(answerFor('How many years of experience do you have in Frontend development?', { type: 'text' }, p), '3');
  assert.equal(answerFor('How many years of experience do you have in HTML5?', { type: 'text' }, p), '3');
  assert.equal(answerFor('How many years of professional experience do you have in frontend development?', { type: 'number' }, p), '3');
  assert.equal(answerFor('Mention Last Working Day', { type: 'text' }, p), '03 Nov 2026');
  assert.equal(answerFor('Last working date', { type: 'date' }, p), '2026-11-03');
  assert.equal(answerFor('Mention Last Working Day', { type: 'text' }, profile), null);
});
