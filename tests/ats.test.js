/**
 * Google discovery + direct employer (ATS) channel — pure parts.
 * Live behaviour is covered by the 2026-11-05 validation run (docs/2026-11-05-pipeline-audit.md).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseAtsUrl, canonicalAtsUrl, detectAtsInHtml, workdayPostedOn, stripHtml } = require('../src/core/ats');
const { classifyResult, jobPostingsFromHtml } = require('../src/core/discovery');
const { normalizeJobUrl, createLog } = require('../src/core/dedup');
const { experienceFromText } = require('../src/core/filter');
const { screenPosting, postingAgeDays } = require('../src/core/direct');
const { answerQuestion, planForm } = require('../src/ats/answers');
const { createDirectory } = require('../src/core/companies');
const { companyFromTitle } = require('../src/bots/google');
const { classify } = require('../src/core/disposition');

test('parseAtsUrl: every supported ATS, with job ids', () => {
  assert.deepEqual(parseAtsUrl('https://job-boards.eu.greenhouse.io/cognite/jobs/5021327101'), { ats: 'greenhouse', token: 'cognite', jobId: '5021327101' });
  assert.deepEqual(parseAtsUrl('https://boards.greenhouse.io/embed/job_app?for=acme&token=123'), { ats: 'greenhouse', token: 'acme', jobId: '123' });
  assert.deepEqual(parseAtsUrl('https://jobs.lever.co/neuron7/a5b7f297-c371-41a0-bdb4-a7931aec745c/apply'), { ats: 'lever', token: 'neuron7', jobId: 'a5b7f297-c371-41a0-bdb4-a7931aec745c' });
  assert.equal(parseAtsUrl('https://jobs.eu.lever.co/acme/a5b7f297-c371-41a0-bdb4-a7931aec745c').region, 'eu');
  assert.deepEqual(parseAtsUrl('https://jobs.ashbyhq.com/aiprise/ade1484a-8158-4a7f-8991-69ce294ca11d/application'), { ats: 'ashby', token: 'aiprise', jobId: 'ade1484a-8158-4a7f-8991-69ce294ca11d' });
  assert.deepEqual(parseAtsUrl('https://jobs.smartrecruiters.com/PHONEPELIMITED/1000000000005260-software-engineer-react-native'), { ats: 'smartrecruiters', token: 'PHONEPELIMITED', jobId: '1000000000005260' });
  assert.deepEqual(parseAtsUrl('https://abcfinancial.wd5.myworkdayjobs.com/en-US/ABCFinancialServices/job/Hyderabad-Office-India/Software-Developer-II--Front-End-_REQ-1592/apply'), {
    ats: 'workday', token: 'abcfinancial', site: 'ABCFinancialServices', host: 'abcfinancial.wd5.myworkdayjobs.com', jobId: '/job/Hyderabad-Office-India/Software-Developer-II--Front-End-_REQ-1592',
  });
  assert.equal(parseAtsUrl('https://www.naukri.com/job-listings-x-123'), null);
});

test('one canonical key per ATS posting however it was reached (cross-channel dedup)', () => {
  const lever = 'https://jobs.lever.co/neuron7/a5b7f297-c371-41a0-bdb4-a7931aec745c';
  for (const u of [`${lever}/apply?lever-source=LinkedIn`, `${lever}?utm_source=google`, lever.replace('neuron7', 'Neuron7')]) {
    assert.equal(normalizeJobUrl(u), lever);
  }
  assert.equal(normalizeJobUrl('https://boards.greenhouse.io/capco/jobs/8288671?gh_src=abc'), 'https://job-boards.greenhouse.io/capco/jobs/8288671');
  assert.equal(normalizeJobUrl('https://boards.greenhouse.io/embed/job_app?for=capco&token=8288671'), 'https://job-boards.greenhouse.io/capco/jobs/8288671');
  assert.equal(normalizeJobUrl('https://jobs.ashbyhq.com/aiprise/ade1484a-8158-4a7f-8991-69ce294ca11d/application'), 'https://jobs.ashbyhq.com/aiprise/ade1484a-8158-4a7f-8991-69ce294ca11d');
  assert.equal(canonicalAtsUrl('https://jobs.lever.co/cred'), ''); // board, not a posting
});

test('an application logged from one channel blocks the same ATS job on every other', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jobman-ats-')), 'log.csv');
  const log = createLog(file);
  log.append({ site: 'Google', job_title: 'Frontend Engineer', company: 'AiPrise', job_url: 'https://jobs.ashbyhq.com/aiprise/ade1484a-8158-4a7f-8991-69ce294ca11d/application', status: 'applied', notes: 'evidence: x' });
  assert.equal(log.priorDisposition('https://jobs.ashbyhq.com/AiPrise/ade1484a-8158-4a7f-8991-69ce294ca11d?src=careers').kind, 'already');
  // and the LinkedIn copy of the same role (company + title fingerprint)
  assert.equal(log.priorDisposition('https://www.linkedin.com/jobs/view/999', { company: 'AiPrise', title: 'Frontend Engineer' }).kind, 'already');
});

test('detectAtsInHtml finds embedded employer ATS on custom careers pages', () => {
  const html = `<iframe src="https://boards.greenhouse.io/embed/job_app?for=acme&amp;token=42"></iframe>
    <script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>
    <a href="https://jobs.lever.co/beta/a5b7f297-c371-41a0-bdb4-a7931aec745c">Apply</a>`;
  const refs = detectAtsInHtml(html);
  assert.ok(refs.find((r) => r.ats === 'greenhouse' && r.jobId === '42'));
  assert.ok(refs.find((r) => r.ats === 'lever' && r.token === 'beta'));
});

test('classifyResult separates employer postings from aggregators and noise', () => {
  assert.equal(classifyResult({ url: 'https://jobs.lever.co/jobgether/b24769f8-7af6-4898-baf3-6cf12eb44fcf', title: 'Jobgether - X' }).kind, 'aggregator');
  assert.equal(classifyResult({ url: 'https://www.naukri.com/job-listings-1', title: '' }).kind, 'aggregator');
  assert.equal(classifyResult({ url: 'https://www.facebook.com/groups/x', title: 'hiring' }).kind, 'irrelevant');
  assert.equal(classifyResult({ url: 'https://jobs.lever.co/cred', title: 'CRED jobs' }).kind, 'board');
  assert.equal(classifyResult({ url: 'https://careers-inc.nttdata.com/job/Bangalore-X/1446639700/', title: 'Job Details' }).kind, 'page');
  const p = classifyResult({ url: 'https://jobs.ashbyhq.com/aiprise/ade1484a-8158-4a7f-8991-69ce294ca11d', title: 'Software Engineer II @ AiPrise' });
  assert.equal(p.kind, 'posting');
  assert.equal(p.ref.id, 'ade1484a-8158-4a7f-8991-69ce294ca11d');
});

test('company names from search titles', () => {
  assert.equal(companyFromTitle('Frontend Developer - Payments Fintech @ Merge Money Ltd.', 'Frontend Developer - Payments Fintech'), 'Merge Money Ltd.');
  assert.equal(companyFromTitle('Job Application for React Developer at Capco', 'React Developer'), 'Capco');
  assert.equal(companyFromTitle('Neuron 7 - Senior Frontend Engineer', 'Senior Frontend Engineer'), 'Neuron 7');
});

test('schema.org JobPosting on employer pages', () => {
  const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"React Native Developer","datePosted":"2026-11-01","validThrough":"2026-12-01",
    "hiringOrganization":{"name":"Acme"},"jobLocation":{"address":{"addressLocality":"Hyderabad","addressCountry":"IN"}},"description":"<p>2-4 years</p>"}</script>`;
  const [jp] = jobPostingsFromHtml(html);
  assert.equal(jp.company, 'Acme');
  assert.match(jp.location, /Hyderabad/);
  assert.equal(jp.text, '2-4 years');
});

test('freshness + experience from the real job description', () => {
  assert.deepEqual(experienceFromText('seeking a React Native developer with 5 to 8 years of experience'), { min: 5, max: 8 });
  assert.equal(experienceFromText('3+ years of professional experience').min, 3);
  assert.deepEqual(experienceFromText('Experience: 2-4 years'), { min: 2, max: 4 });
  assert.equal(experienceFromText('4 to 7&#xa0;years of professional experience').min, 4);
  assert.equal(experienceFromText('Great culture, no requirement'), null);
  assert.equal(workdayPostedOn('Posted 3 Days Ago', new Date('2026-11-05T00:00:00Z')).slice(0, 10), '2026-11-02');
  assert.equal(postingAgeDays('2026-10-01T00:00:00Z', new Date('2026-11-05T00:00:00Z')), 35);
  assert.equal(stripHtml('<p>a&#xa0;b</p>'), 'a b');
});

test('screenPosting applies location, experience, role and freshness rules', () => {
  const now = new Date('2026-11-05T00:00:00Z');
  const base = { title: 'Software Engineer II, Frontend', company: 'AiPrise', location: 'Bengaluru', text: 'React, TypeScript. 1-3 years of experience.', postedAt: '2026-10-20T00:00:00Z' };
  assert.equal(screenPosting(base, { now }), '');
  assert.match(screenPosting({ ...base, postedAt: '2026-08-01T00:00:00Z' }, { now }), /^stale/);
  assert.match(screenPosting({ ...base, location: 'Mumbai' }, { now }), /Mumbai/);
  assert.match(screenPosting({ ...base, location: 'Remote - USA' }, { now }), /south India|remote/i);
  assert.match(screenPosting({ ...base, text: 'React. 5 to 8 years of experience.' }, { now }), /experience 5\+/);
  assert.match(screenPosting({ ...base, title: 'Senior Frontend Engineer' }, { now }), /score/);
  // "India" location is accepted when the description names a southern city
  assert.equal(screenPosting({ ...base, location: 'India', text: `${base.text} Office in Hyderabad.` }, { now }), '');
  assert.equal(classify('skipped', { reason: 'stale: posted 40 days ago (max 30)' }), 'rejected_stale');
  assert.equal(classify('skipped', { reason: 'posting closed: no longer listed by the employer ATS' }), 'rejected_stale');
});

const profile = {
  name: 'Shivaji Mandapati', email: 'me@example.com', phone: '+91-8978577031', experience_years: 2.7,
  notice_period_days: 0, expected_ctc: '15-20 LPA', current_ctc: '', current_company: 'Neosoft Technologies',
  willing_to_relocate: true, available_immediate: true, serving_notice: false, skill_years: {},
};

test('form answers: identity fields from the profile, verbatim', () => {
  const job = { resume: '/r/rn.pdf' };
  assert.equal(answerQuestion({ label: 'First Name*', kind: 'text' }, profile).value, 'Shivaji');
  assert.equal(answerQuestion({ label: 'Last Name*', kind: 'text' }, profile).value, 'Mandapati');
  assert.equal(answerQuestion({ label: 'Full name ✱', kind: 'text' }, profile).value, 'Shivaji Mandapati');
  assert.equal(answerQuestion({ label: 'Email', kind: 'email' }, profile).value, 'me@example.com');
  assert.equal(answerQuestion({ label: 'Contact Number', kind: 'tel' }, profile).value, '+91 8978577031');
  assert.equal(answerQuestion({ label: 'Resume', kind: 'file' }, profile, job).value, '/r/rn.pdf');
  assert.equal(answerQuestion({ label: 'Current company ✱', kind: 'text' }, profile).value, 'Neosoft Technologies');
  assert.equal(answerQuestion({ label: 'What is you current or last payroll company name?*', kind: 'text' }, profile).value, 'Neosoft Technologies');
  assert.equal(answerQuestion({ label: 'Country*', kind: 'combobox', options: ['Indonesia', 'India', 'Iran'] }, profile).value, 'India');
});

test('form answers: never invented — missing facts, essays, consent, demographics', () => {
  const ask = (label, kind = 'text', options = []) => answerQuestion({ label, kind, options, required: true }, profile);
  assert.equal(ask('LinkedIn URL ✱', 'url').value, null);
  assert.equal(ask('Current location ✱').value, null);
  assert.equal(ask('What is your current annual compensation (INR LPA)?').value, null);
  assert.equal(ask('What made you apply to this role at Merge?', 'textarea').value, null);
  assert.equal(ask('How many years of hands-on experience do you have with React.js and Next.js development?').value, null);
  assert.equal(ask('I agree to the privacy policy', 'checkbox').value, null);
  assert.equal(ask('Gender?*', 'combobox', ['Male', 'Female']).value, null);
  assert.equal(ask('Gender', 'select', ['Male', 'Female', 'Decline to self-identify']).value, 'Decline to self-identify');
  // a "phone screen" yes/no is not a phone-number field
  assert.equal(ask('Are you OK with a phone screen?', 'yesno', ['Yes', 'No']).value, null);
});

test('form answers: user-written custom answers and consents are used as given', () => {
  const p = { ...profile, linkedin_url: 'https://linkedin.com/in/me', consents: { privacy_and_terms: true }, custom_answers: [{ match: 'reason for (job )?change', answer: 'Looking for product work' }] };
  assert.equal(answerQuestion({ label: 'LinkedIn Profile Link*', kind: 'text' }, p).value, 'https://linkedin.com/in/me');
  assert.equal(answerQuestion({ label: 'What is the reason for job change?*', kind: 'text' }, p).value, 'Looking for product work');
  assert.equal(answerQuestion({ label: 'I agree to the privacy policy', kind: 'checkbox' }, p).value, true);
});

test('planForm: screening via core/screening; required gaps listed, optional gaps left blank', () => {
  const qs = [
    { label: 'Name', kind: 'text', required: true },
    { label: 'Email', kind: 'email', required: true },
    { label: 'Resume', kind: 'file', required: true },
    { label: 'What is your current notice period?', kind: 'text', required: true },
    { label: 'What is your expected annual compensation (INR LPA)?', kind: 'text', required: true },
    { label: 'LinkedIn', kind: 'url', required: true },
    { label: 'Twitter URL', kind: 'text', required: false },
  ];
  const plan = planForm(qs, profile, { resume: '/r/fe.pdf' });
  assert.equal(plan.fills.length, 5);
  assert.match(plan.fills.find((f) => /notice/.test(f.q.label)).value, /^(0|Immediate)$/);
  assert.equal(plan.fills.find((f) => /expected/.test(f.q.label)).value, '15'); // "(INR LPA)" asks for a number
  assert.equal(plan.missing.length, 1);
  assert.match(plan.missing[0], /^LinkedIn/);
  assert.deepEqual(plan.skipped, ['Twitter URL']);
});

test('company directory persists boards, names and stats', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobman-dir-'));
  const file = path.join(dir, 'companies.json');
  const seed = path.join(dir, 'seed.json');
  fs.writeFileSync(seed, JSON.stringify({ companies: [{ name: 'CRED', ats: 'lever', token: 'cred' }] }));
  const d = createDirectory(file, { seedFile: seed, legacyFile: path.join(dir, 'none.json') });
  assert.equal(d.list().length, 1);
  const { isNew } = d.upsert({ ats: 'ashby', token: 'aiprise' }, { source: 'google', name: 'AiPrise' });
  assert.equal(isNew, true);
  assert.equal(d.upsert({ ats: 'ashby', token: 'AiPrise' }, { source: 'google' }).isNew, false);
  d.markChecked({ ats: 'ashby', token: 'aiprise' }, { openings: 12, indiaOpenings: 3 });
  d.save();
  const again = createDirectory(file, { seedFile: seed, legacyFile: path.join(dir, 'none.json') });
  const e = again.get({ ats: 'ashby', token: 'aiprise' });
  assert.equal(e.name, 'AiPrise');
  assert.equal(e.indiaOpenings, 3);
  assert.deepEqual(e.sources, ['google']);
});

test('identity rules never answer choice questions that merely contain the word', () => {
  // Real SmartRecruiters question (PhonePe, 2026-11-05) once got the phone number.
  const a = answerQuestion({ label: 'Were you previously employed at PhonePe? (as a Full-Time / contract / intern)', kind: 'combobox', options: ['Yes', 'No'], required: true }, profile);
  assert.equal(a.value, null);
  assert.equal(answerQuestion({ label: 'Phone number', kind: 'tel' }, profile).value, '+91 8978577031');
  assert.equal(answerQuestion({ label: 'Mobile Number*', kind: 'text' }, profile).value, '+91 8978577031');
  assert.equal(answerQuestion({ label: 'Years of mobile app experience', kind: 'text' }, profile).value, null);
  assert.equal(answerQuestion({ label: 'Confirm your email*', kind: 'email' }, profile).value, 'me@example.com');
  assert.equal(answerQuestion({ label: 'City*', kind: 'combobox', options: [] }, { ...profile, current_location: 'Hyderabad' }).value, 'Hyderabad');
});

test('blockersFrom groups hand-off reasons for the per-ATS report', () => {
  const { blockersFrom } = require('../src/core/disposition');
  assert.deepEqual(
    blockersFrom('needs your answer: City* (current_location not in profile); Current Fixed Compensation * (not in profile); I allow X to process my data (consent box — set consents.privacy_and_terms in candidate.json to allow); Gender (demographic question)'),
    ['current_location', 'current CTC', 'consent box', 'demographic question']
  );
  assert.deepEqual(blockersFrom('Workday (x.wd5.myworkdayjobs.com): no signed-in candidate session — sign in once'), ['Workday: no signed-in session']);
});

test('directory growth: slug guesses skip placeholders and aggregators', () => {
  const { slugCandidates } = require('../src/core/directoryGrowth');
  assert.deepEqual(slugCandidates('Couchbase Inc'), ['couchbase', 'couchbaseinc']);
  assert.deepEqual(slugCandidates('Confidential Company'), []);
  assert.deepEqual(slugCandidates('CareerXperts Consulting'), []);
  assert.equal(slugCandidates('rigbot.com')[0], 'rigbot');
});

test('saved Google leads: merged, rotated, expired — and never trusted without a live re-read', () => {
  const { mergeLeads, nextQueries, saveLeads, loadLeads } = require('../src/bots/google');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jobman-leads-')), 'leads.json');
  const st = { cursor: 13, leads: [] };
  mergeLeads(st, [{ url: 'https://jobs.lever.co/a/1', title: 't', query: 'q' }], new Date().toISOString());
  mergeLeads(st, [{ url: 'https://jobs.lever.co/a/1', title: 't', query: 'q' }, { url: 'https://jobs.lever.co/a/2', title: 't', query: 'q' }]);
  st.leads.push({ url: 'https://old', lastSeen: '2026-01-01T00:00:00Z' });
  saveLeads(st, file);
  const back = loadLeads(file);
  assert.deepEqual(back.leads.map((l) => l.url).sort(), ['https://jobs.lever.co/a/1', 'https://jobs.lever.co/a/2']); // >14 days dropped
  assert.equal(back.leads.every((l) => !('open' in l)), true); // a lead stores no "open" verdict to reuse
  const qs = nextQueries({ cursor: 13 }, 3, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n']);
  assert.deepEqual(qs, ['n', 'a', 'b']);
});

test('directory growth: board names must really match the company', () => {
  const { namesMatch } = require('../src/core/directoryGrowth');
  assert.equal(namesMatch('AQR India', 'India'), false); // seen 2026-11-05
  assert.equal(namesMatch('Couchbase, Inc.', 'Couchbase Inc'), true);
  assert.equal(namesMatch('SWIGGY', 'Swiggy'), true);
});
