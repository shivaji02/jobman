const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEnricher, extractFromHtml, httpUrlFor, looksBlocked, jobPostingFromHtml } = require('../src/core/enrich');

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const tmpCache = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jd-')), 'cache.json');
const quiet = { warn() {}, info() {}, debug() {} };
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => body });

test('LinkedIn guest posting (real page, 2026-11-10) yields the full description and criteria', () => {
  const r = extractFromHtml('https://www.linkedin.com/jobs/view/4487731106/', fx('linkedin-guest-posting.html'));
  assert.equal(r.via, 'linkedin-guest');
  assert.ok(r.text.length > 2000);
  // The card said "Full Stack Developer"; the posting is a Senior Python role.
  assert.match(r.text, /Senior Python Full Stack Engineer/);
  assert.match(r.text, /Seniority level: Entry level/);
});

test('Talent.com view page (real) yields the description', () => {
  const r = extractFromHtml('https://in.talent.com/view?id=645021083448379060', fx('talent-view.html'));
  assert.equal(r.via, 'talent-html');
  assert.match(r.text, /React\.js , Next\.js , TypeScript/);
});

test('JSON-LD JobPosting is read on any host', () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","datePosted":"2026-11-01","description":"<p>${'React Native and TypeScript. '.repeat(20)}</p>"}</script>`;
  assert.match(jobPostingFromHtml(html).text, /React Native and TypeScript/);
  assert.equal(extractFromHtml('https://jobs.example.com/1', html).via, 'json-ld');
});

test('LinkedIn view URLs are fetched through the guest endpoint', () => {
  assert.equal(httpUrlFor('https://www.linkedin.com/jobs/view/4486265519/'), 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4486265519');
});

test('verification pages are detected, never parsed', () => {
  assert.match(looksBlocked({ title: 'Just a moment...' }), /verification page/);
  assert.match(looksBlocked({ status: 406 }), /406/);
  assert.equal(looksBlocked({ title: 'Frontend Developer', text: 'React' }), '');
});

test('enricher: HTTP fetch, cache hit on second call, cache persisted across instances', async () => {
  const cacheFile = tmpCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return res(200, fx('linkedin-guest-posting.html'));
  };
  const e1 = createEnricher({ fetchImpl, cacheFile, hostGapMs: {}, logger: quiet });
  const job = { url: 'https://www.linkedin.com/jobs/view/4487731106/' };
  const a = await e1.enrich(job);
  assert.equal(a.ok, true);
  assert.equal(a.via, 'linkedin-guest');
  const b = await e1.enrich(job);
  assert.equal(b.cached, true);
  assert.equal(calls, 1);
  e1.flush();
  const e2 = createEnricher({ fetchImpl, cacheFile, hostGapMs: {}, logger: quiet });
  assert.equal((await e2.enrich(job)).cached, true);
  assert.equal(calls, 1, 'incremental run reuses the cached description');
});

test('enricher: a verification page trips the per-host circuit breaker (no further requests)', async () => {
  let gotos = 0;
  const newPage = async () => ({
    goto: async () => { gotos++; },
    waitForSelector: async () => {},
    evaluate: async () => ({ title: 'Just a moment...', text: '', body: 'Verify you are human', via: 'generic' }),
    close: async () => {},
  });
  const e = createEnricher({ newPage, useCache: false, hostGapMs: {}, logger: quiet });
  const a = await e.enrich({ url: 'https://in.indeed.com/viewjob?jk=abc' });
  assert.equal(a.ok, false);
  assert.match(a.blocked, /verification/);
  const b = await e.enrich({ url: 'https://in.indeed.com/viewjob?jk=def' });
  assert.match(b.blocked, /host paused earlier this run/);
  assert.equal(gotos, 1);
});

test('enricher: timeouts and HTTP errors fail cleanly with a reason', async () => {
  const e = createEnricher({
    fetchImpl: async () => { throw new Error('The operation was aborted due to timeout'); },
    newPage: async () => ({ goto: async () => { throw new Error('Navigation timeout of 25000 ms exceeded'); }, close: async () => {} }),
    useCache: false,
    hostGapMs: {},
    logger: quiet,
  });
  const r = await e.enrich({ url: 'https://jobs.example.com/1' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timeout');
});

test('enricher: browser-only hosts (Naukri) never use plain HTTP', async () => {
  let http = 0;
  const newPage = async () => ({
    goto: async () => {},
    waitForSelector: async () => {},
    evaluate: async () => ({ title: 'Job', text: 'React Native, TypeScript, Redux. '.repeat(20), via: 'selector' }),
    close: async () => {},
  });
  const e = createEnricher({ fetchImpl: async () => { http++; return res(200, ''); }, newPage, useCache: false, hostGapMs: {}, logger: quiet });
  const r = await e.enrich({ url: 'https://www.naukri.com/job-listings-react-native-developer-acme-hyderabad-2-to-4-years-091126000001' });
  assert.equal(r.ok, true);
  assert.equal(http, 0);
  assert.equal(r.via, 'browser-selector');
});

test('enricher: per-host pacing serialises requests to one host', async () => {
  const times = [];
  const e = createEnricher({
    fetchImpl: async () => { times.push(Date.now()); return res(200, fx('linkedin-guest-posting.html')); },
    useCache: false,
    hostGapMs: { http: 80 },
    logger: quiet,
  });
  await Promise.all([1, 2, 3].map((i) => e.enrich({ url: `https://www.linkedin.com/jobs/view/${i}/` })));
  times.sort();
  assert.ok(times[2] - times[0] >= 150, `requests should be spaced (${times.map((t) => t - times[0])})`);
});
