/**
 * Reproductions of the 2026-11-09 portal failures, driven through the real bot
 * code with a scripted fake Puppeteer page (no browser, no network):
 *
 *   LinkedIn  "Cannot read properties of null (reading 'scrollHeight')" → whole portal crashed,
 *             retry restarted all 49 searches
 *   Foundit   "Attempted to use detached Frame '…'" twice → 3 attempts, 15m12s
 *   Indeed    "Just a moment..." interstitial → three 15 s empty searches, then skipped
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLog } = require('../src/core/dedup');
const { SkipPortalError } = require('../src/core/browser');

process.env.JOBMAN_FOUNDIT_GAP_MS = '0'; // no politeness gap against a fake site
const linkedin = require('../src/bots/linkedin');
Object.assign(linkedin.TIMING, { scrollPassMs: 1, navigatingMs: 1 });
const foundit = require('../src/bots/foundit');
const indeed = require('../src/bots/indeed');

const tmpLog = () => {
  const l = createLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')), 'log.csv'));
  l.load();
  return l;
};

/** Run a page.evaluate callback against a fake DOM, the way Chrome would. */
function runInDom(fn, args, dom) {
  const ctx = vm.createContext({ document: dom.document, window: dom.window, getComputedStyle: () => ({ overflowY: 'auto' }), setTimeout });
  ctx.__fn = fn;
  ctx.__args = args;
  return vm.runInContext(`(${fn.toString()})(...__args)`, ctx);
}

// ---------------------------------------------------------------- LinkedIn

const NAVIGATING_DOM = {
  // What the page looks like while /jobs/search/ is being replaced by /jobs/search-results/.
  document: { body: null, documentElement: null, scrollingElement: null, querySelector: () => null, querySelectorAll: () => [] },
  window: { scrollTo() {} },
};

test('LinkedIn: the Nov 9 crash reproduces with the old scroll code and not with the new one', async () => {
  // The scroll body that shipped on 2026-11-09 (verbatim logic).
  const oldScroll = (sel) => {
    const cards = document.querySelectorAll(sel);
    const last = cards[cards.length - 1];
    let pane = document.querySelector('.jobs-search-results-list');
    if (last) last.scrollIntoView({ block: 'end' });
    if (pane) pane.scrollTop = pane.scrollHeight;
    else window.scrollTo(0, document.body.scrollHeight);
    return cards.length;
  };
  assert.throws(() => runInDom(oldScroll, ['x'], NAVIGATING_DOM), /Cannot read properties of null \(reading 'scrollHeight'\)/);

  let calls = 0;
  const page = { evaluate: async (fn, ...args) => { calls++; return runInDom(fn, args, NAVIGATING_DOM); } };
  const n = await linkedin.scrollResultsList(page);
  assert.equal(n, 0);
  assert.ok(calls > 1, 'kept polling instead of throwing');
});

test('LinkedIn: navigation mid-scroll ends the scroll instead of crashing', async () => {
  const page = { evaluate: async () => { throw new Error('Execution context was destroyed, most likely because of a navigation.'); } };
  assert.equal(await linkedin.scrollResultsList(page), 0);
});

/** Scripted LinkedIn results page. `script(searchIndex, attempt)` → 'ok' | 'empty' | 'unknown' | Error */
function fakeLinkedinBrowser(script) {
  const state = { gotos: [], pagesOpened: 0, search: -1, attempt: {} };
  const makePage = () => {
    state.pagesOpened++;
    let mode = 'ok';
    let currentUrl = 'about:blank';
    return {
      async goto(url) {
        const kw = new URL(url).searchParams.get('keywords');
        const loc = new URL(url).searchParams.get('location');
        const id = `${loc}|${kw}`;
        state.attempt[id] = (state.attempt[id] || 0) + 1;
        state.gotos.push(id);
        currentUrl = url;
        const r = script(id, state.attempt[id]);
        if (r instanceof Error) throw r;
        mode = r;
        state.lastId = id;
      },
      url: () => currentUrl,
      async waitForFunction() {},
      async $() { return null; },
      async evaluate(fn) {
        const src = fn.toString();
        if (src.includes("'login'") && src.includes("'modern'")) return mode === 'ok' ? 'modern' : mode;
        if (src.includes('recaptcha')) return false;
        if (src.includes('scrollIntoView')) return mode === 'ok' ? 2 : 0;
        if (src.includes('job-card-component-ref-') && src.includes('modern: true')) {
          const id = state.lastId.replace(/\W+/g, '');
          return { modern: true, cards: [0, 1].map((k) => ({ id: String(1000 + (hash(id) % 50) * 10 + k), lines: [`Senior Role ${k}`, 'Co', 'Hyderabad'], text: 'x' })) };
        }
        if (src.includes('pagination-controls-next-button')) return false;
        return null;
      },
      async close() {},
      async bringToFront() {},
    };
  };
  return { state, newPage: async () => makePage() };
}
const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

test('LinkedIn: a broken search is retried once on a fresh tab; the portal does not crash', async () => {
  const roles = ['React Native Developer'];
  const broken = 'chennai, India|React Native Developer';
  const { state, newPage } = fakeLinkedinBrowser((id, attempt) => (id === broken && attempt === 1 ? new Error("Cannot read properties of null (reading 'scrollHeight')") : 'ok'));
  const st = {};
  const res = await linkedin.run({ profile: { target_roles: roles }, dedup: tmpLog(), dryRun: true, newPage, resume: st, fullScan: true });
  assert.equal(state.attempt[broken], 2, 'retried exactly once');
  assert.ok(state.pagesOpened >= 2, 'fresh tab after the failure');
  assert.equal(res.searchFailures, undefined);
  assert.equal(st.doneSearches.size, 8 * 6, 'every search completed'); // 6 LinkedIn roles × 8 cities
});

test('LinkedIn: a search that keeps failing is reported (bounded), not retried forever', async () => {
  const broken = 'kochi, India|React Native urgent hiring';
  const { state, newPage } = fakeLinkedinBrowser((id) => (id === broken ? 'unknown' : 'ok'));
  const res = await linkedin.run({ profile: { target_roles: ['React Native Developer'] }, dedup: tmpLog(), dryRun: true, newPage, fullScan: true });
  assert.equal(state.attempt[broken], 2);
  assert.equal(res.searchFailures.length, 1);
  assert.match(res.note, /1 search\(es\) failed after a retry/);
});

test('LinkedIn: a portal-level retry resumes after the last finished search (no reprocessing)', async () => {
  let crash = true;
  const crashAt = 'kochi, India|React Native Developer';
  const { state, newPage } = fakeLinkedinBrowser((id) => (id === crashAt && crash ? 'ok' : 'ok'));
  const st = {};
  const dedup = tmpLog();
  // First attempt dies (e.g. browser hiccup) right after the Kochi search starts.
  const realNewPage = newPage;
  let opened = 0;
  const crashingNewPage = async () => {
    const p = await realNewPage();
    const goto = p.goto;
    p.goto = async (url) => {
      await goto(url);
      if (crash && state.lastId === crashAt) {
        crash = false;
        throw new SkipPortalError('simulated stop');
      }
    };
    opened++;
    return p;
  };
  await assert.rejects(linkedin.run({ profile: { target_roles: ['React Native Developer'] }, dedup, dryRun: true, newPage: crashingNewPage, resume: st, fullScan: true }));
  const before = st.doneSearches.size;
  const reviewedBefore = st.results.reviewed;
  assert.ok(before > 0 && before < 48);
  const gotosBefore = state.gotos.length;
  const res = await linkedin.run({ profile: { target_roles: ['React Native Developer'] }, dedup, dryRun: true, newPage: crashingNewPage, resume: st, fullScan: true });
  assert.equal(state.gotos.length - gotosBefore, 48 - before, 'only the unfinished searches ran again');
  assert.equal(res, st.results, 'same results object continued');
  assert.ok(res.reviewed >= reviewedBefore);
  assert.ok(opened >= 2);
});

// ---------------------------------------------------------------- Foundit

function fakeFounditBrowser(script) {
  const state = { attempt: {}, pagesOpened: 0, detached: new Set() };
  const makePage = () => {
    const pageNo = ++state.pagesOpened;
    let id = '';
    let mode = 'cards';
    return {
      async setRequestInterception() {},
      on() {},
      async goto(url) {
        if (state.detached.has(pageNo)) throw new Error("Attempted to use detached Frame 'CEC4BEB02B5253CFAC2118DFBF62634C'.");
        const u = new URL(url);
        id = `${u.searchParams.get('locations')}|${u.searchParams.get('query')}`;
        state.attempt[id] = (state.attempt[id] || 0) + 1;
        const r = script(id, state.attempt[id]);
        if (r === 'detach') {
          state.detached.add(pageNo);
          throw new Error("Attempted to use detached Frame 'D327A501FA458A5F0C9453FB473AE970'.");
        }
        mode = r;
      },
      async waitForFunction() {
        return { jsonValue: async () => (mode === 'cards' ? 'cards' : 'quiet') };
      },
      async evaluate(fn) {
        const src = fn.toString();
        if (src.includes('.cardContainer[id]') && src.includes('experienceText')) {
          return mode === 'cards' ? [{ index: 0, id: `j${hash(id) % 1000}`, title: 'Senior React Developer', company: 'Co', experienceText: '2-4 Yrs', location: 'Hyderabad', text: 'React' }] : [];
        }
        return false;
      },
      keyboard: { press: async () => {} },
      async close() {},
    };
  };
  return { state, newPage: async () => makePage() };
}

test('Foundit: detached frames are recovered on a fresh tab; the broken search is retried once; no portal restart', async () => {
  const bad = 'chennai|react developer';
  const { state, newPage } = fakeFounditBrowser((id, attempt) => (id === bad && attempt === 1 ? 'detach' : 'cards'));
  const st = {};
  const res = await foundit.run({ dedup: tmpLog(), dryRun: true, newPage, resume: st });
  assert.equal(state.attempt[bad], 2);
  assert.ok(state.pagesOpened >= 2, 'reacquired a page');
  assert.equal(res.searchFailures, undefined);
  assert.equal(st.doneSearches.size, 8 * 7); // 7 Foundit queries × 8 cities
  const errors = res.searchLog.filter((s) => /^error/.test(s.settled));
  assert.equal(errors.length, 1, 'failure is observable in the search log');
});

test('Foundit: empty searches settle on "quiet" instead of a 15 s timeout, and timings are recorded', async () => {
  const { newPage } = fakeFounditBrowser((id) => (/kochi|coimbatore/.test(id) ? 'empty' : 'cards'));
  const res = await foundit.run({ dedup: tmpLog(), dryRun: true, newPage });
  const empties = res.searchLog.filter((s) => s.settled === 'quiet');
  assert.equal(empties.length, 14); // 2 empty cities × 7 Foundit queries
  assert.ok(res.searchLog.every((s) => Number.isFinite(s.ms)));
});

test('Foundit: the settle predicate reports quiet after the page has loaded with no cards', () => {
  const src = foundit.waitForResults.toString();
  assert.match(src, /quiet/);
  // Evaluate the in-page predicate against a loaded, card-less DOM.
  const predicate = src.match(/\(quietMs\) => \{[\s\S]*?\n      \}/)[0];
  const win = {};
  const dom = { document: { querySelector: () => null, body: { innerText: 'Showing jobs' }, readyState: 'complete' }, window: win };
  const fn = vm.runInNewContext(`(${predicate})`, {});
  const first = runInDom(fn, [0], dom);
  assert.equal(first, false);
  win.__jobmanQuietSince = Date.now() - 10;
  assert.equal(runInDom(fn, [0], dom), 'quiet');
  const noResults = { document: { querySelector: () => null, body: { innerText: 'No jobs found for your search' }, readyState: 'loading' }, window: {} };
  assert.equal(runInDom(fn, [2500], noResults), 'empty');
});

// ---------------------------------------------------------------- Indeed

function fakeIndeedPage({ clearAfterPolls = Infinity } = {}) {
  let polls = 0;
  const touched = [];
  return {
    touched,
    page: {
      async setRequestInterception() {},
      on() {},
      async goto() {},
      async title() {
        return polls >= clearAfterPolls ? 'React Native Developer Jobs' : 'Just a moment...';
      },
      url: () => 'https://in.indeed.com/jobs?q=react',
      async evaluate(fn) {
        const src = fn.toString();
        if (src.includes('innerText.slice(0, 2000)')) {
          polls++;
          return polls > clearAfterPolls ? 'jobs list' : 'Verify you are human';
        }
        return [];
      },
      async waitForSelector() {},
      async bringToFront() { touched.push('front'); },
      async click() { touched.push('click'); },
      async type() { touched.push('type'); },
      keyboard: { press: async () => touched.push('key') },
      mouse: { click: async () => touched.push('mouse') },
      async close() {},
    },
  };
}

test('Indeed: interstitial detection is immediate and specific', () => {
  assert.equal(indeed.isInterstitial({ title: 'Just a moment...' }), true);
  assert.equal(indeed.isInterstitial({ url: 'https://in.indeed.com/cdn-cgi/challenge-platform/h/b' }), true);
  assert.equal(indeed.isInterstitial({ title: 'React Native Developer Jobs, Employment | Indeed', bodyText: '24 jobs' }), false);
});

test('Indeed: verification page pauses only this portal, is never interacted with, and is reported for you', async () => {
  const { page, touched } = fakeIndeedPage();
  const t0 = Date.now();
  process.env.JOBMAN_VERIFY_WAIT_MS = '0';
  const err = await indeed
    .run({ dedup: tmpLog(), dryRun: true, newPage: async () => page })
    .then(() => null, (e) => e);
  assert.ok(err instanceof SkipPortalError);
  assert.match(err.message, /verification page.*nothing was bypassed/);
  assert.ok(Date.now() - t0 < 2000, 'stopped on the first search, not after three 15 s timeouts');
  assert.equal(err.partialResults.manualAction.portal, 'indeed');
  assert.deepEqual(touched.filter((t) => t !== 'front'), [], 'no click / type / key on the challenge');
});

test('Indeed: when you complete the verification yourself, the paused worker resumes', async () => {
  const { page } = fakeIndeedPage({ clearAfterPolls: 2 });
  const statuses = [];
  const cleared = await indeed.pauseForVerification(page, { waitMs: 2000, pollMs: 10, onStatus: (s) => statuses.push(s) });
  assert.equal(cleared, true);
  assert.ok(statuses.some((s) => /paused — verification needs you/.test(s)));
});

test('LinkedIn: a half-rendered results page (cards layout, zero parsable cards) is an error to retry, not "0 cards"', async () => {
  const page = {
    async goto() {},
    url: () => 'https://www.linkedin.com/jobs/search-results/',
    async waitForFunction() {},
    async evaluate(fn) {
      const src = fn.toString();
      if (src.includes("'login'") && src.includes("'modern'")) return 'modern';
      if (src.includes('recaptcha')) return false;
      if (src.includes('scrollIntoView')) return 0;
      if (src.includes('modern: true')) return { modern: true, cards: [] }; // re-render gap
      return false;
    },
  };
  await assert.rejects(linkedin.discoverSearch(page, { city: 'hyderabad', role: 'React Native Developer' }), /no parsable job cards/);
});

test('Foundit: an "Access Denied" CDN page pauses the portal (kept results), never counted as 0 cards', async () => {
  process.env.JOBMAN_FOUNDIT_GAP_MS = '0';
  const blockedFrom = 'chennai|mobile developer';
  let blocked = false;
  const { newPage } = fakeFounditBrowser((id) => {
    if (id === blockedFrom) blocked = true;
    return blocked ? 'blocked' : 'cards';
  });
  const st = {};
  const wrapped = async () => {
    const p = await newPage();
    const wf = p.waitForFunction;
    p.waitForFunction = async (...a) => (blocked ? { jsonValue: async () => 'blocked' } : wf(...a));
    return p;
  };
  const err = await foundit.run({ dedup: tmpLog(), dryRun: true, newPage: wrapped, resume: st }).then(() => null, (e) => e);
  assert.ok(err instanceof SkipPortalError, String(err));
  assert.match(err.message, /Access Denied.*nothing was bypassed/);
  assert.ok(st.results.discovered > 0, 'earlier searches kept');
  assert.equal(st.results.searchLog.filter((s) => s.settled === 'blocked').length, 1);
  assert.equal(st.results.searchLog.filter((s) => s.settled === 'quiet').length, 0);
});

test('enricher treats an Access Denied page as blocked', () => {
  const { looksBlocked } = require('../src/core/enrich');
  assert.match(looksBlocked({ title: 'Access Denied', text: "You don't have permission to access" }), /access denied/i);
  assert.match(looksBlocked({ title: 'foundit', text: "Access Denied You don't have permission to access" }), /access denied/i);
});

test('LinkedIn: a role that adds no new jobs in 2 consecutive cities is saturated (skipped); --full-scan runs everything', async () => {
  // Every search returns the same cards → after the first city, nothing is new.
  const mk = () => fakeLinkedinBrowser(() => 'ok');
  const fixed = (f) => {
    const { state, newPage } = f;
    return {
      state,
      newPage: async () => {
        const p = await newPage();
        const ev = p.evaluate;
        p.evaluate = async (fn, ...a) => (fn.toString().includes('modern: true') ? { modern: true, cards: [{ id: '42', lines: ['Senior X', 'Co', 'Hyderabad'], text: 'x' }] } : ev(fn, ...a));
        return p;
      },
    };
  };
  const a = fixed(mk());
  const r1 = await linkedin.run({ profile: { target_roles: ['React Native Developer'] }, dedup: tmpLog(), dryRun: true, newPage: a.newPage });
  // One card shared by every search: role 1 finds it new in Hyderabad then sees nothing new in
  // 2 more cities (3 searches); roles 2–6 see nothing new from their first city (2 each).
  assert.equal(a.state.gotos.length, 3 + 2 * 5);
  assert.equal(r1.saturatedSearches.length, 48 - 13);
  const b = fixed(mk());
  await linkedin.run({ profile: { target_roles: ['React Native Developer'] }, dedup: tmpLog(), dryRun: true, newPage: b.newPage, fullScan: true });
  assert.equal(b.state.gotos.length, 48);
});
