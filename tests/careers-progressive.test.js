/**
 * Regression tests for the Careers channel stall (2026-11-17): the channel read
 * every board before handling any posting, so one slow board held 0 jobs
 * processed for 30+ minutes. These drive the real three-stage pipeline with
 * injected readers and no network or browser.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { streamCareers, withTimeout, WorkQueue } = require('../src/bots/careers');
const { classify } = require('../src/core/disposition');

const board = (token) => ({ name: token.toUpperCase(), ats: 'greenhouse', token });
const candidatesOf = (c, jobs) => jobs.map((job) => ({ c, job }));

test('a board that hangs times out while the other boards keep flowing', { timeout: 10_000 }, async () => {
  const handled = [];
  const stats = await streamCareers({
    companies: [board('slow'), board('f1'), board('f2')],
    boardConcurrency: 3,
    boardTimeoutMs: 50,
    postingTimeoutMs: 1000,
    readBoard: (c) => (c.token === 'slow' ? new Promise(() => {}) : Promise.resolve([{ url: `${c.token}/1` }])),
    screenBoard: candidatesOf,
    enrich: async ({ job }) => job,
    handle: async (posting) => { handled.push(posting.url); },
  });
  assert.deepEqual(handled.sort(), ['f1/1', 'f2/1']);
  assert.equal(stats.boardsTimedOut, 1);
  assert.equal(stats.handled, 2);
});

test('postings are handled as each board finishes, not after every board is read', { timeout: 10_000 }, async () => {
  // Board "b" cannot finish until board "a"'s posting has been handled. Under the old
  // read-everything-first behaviour this deadlocks, so board "b" would time out.
  let releaseB;
  const gateB = new Promise((resolve) => { releaseB = resolve; });
  const order = [];
  const stats = await streamCareers({
    companies: [board('a'), board('b')],
    boardConcurrency: 2,
    boardTimeoutMs: 5000,
    postingTimeoutMs: 5000,
    readBoard: async (c) => {
      if (c.token === 'b') await gateB;
      return [{ url: c.token }];
    },
    screenBoard: candidatesOf,
    enrich: async ({ job }) => job,
    handle: async (posting) => {
      order.push(posting.url);
      if (posting.url === 'a') releaseB();
    },
  });
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(stats.boardsTimedOut, 0);
});

test('a posting whose description hangs is handled as unavailable, never dropped', { timeout: 10_000 }, async () => {
  const got = [];
  const stats = await streamCareers({
    companies: [board('x')],
    postingTimeoutMs: 30,
    readBoard: async () => [{ url: 'x/1', title: 'React Native Engineer' }],
    screenBoard: candidatesOf,
    enrich: () => new Promise(() => {}),
    handle: async (posting) => { got.push(posting); },
  });
  assert.equal(got.length, 1);
  assert.equal(got[0].detailFetchFailed, true);
  assert.equal(stats.descriptionTimeouts, 1);
});

test('an error while handling one posting does not stop the channel', { timeout: 10_000 }, async () => {
  const handled = [];
  const stats = await streamCareers({
    companies: [board('x')],
    readBoard: async () => [{ url: 'x/1' }, { url: 'x/2' }],
    screenBoard: candidatesOf,
    enrich: async ({ job }) => job,
    handle: async (posting) => {
      if (posting.url === 'x/1') throw new Error('boom');
      handled.push(posting.url);
    },
  });
  assert.deepEqual(handled, ['x/2']);
  assert.equal(stats.handleErrors, 1);
});

test('a stop request prevents new postings from being handled', { timeout: 10_000 }, async () => {
  let stop = false;
  const handled = [];
  const stats = await streamCareers({
    companies: [board('a'), board('b'), board('c')],
    boardConcurrency: 1,
    readBoard: async (c) => [{ url: `${c.token}/1` }],
    screenBoard: candidatesOf,
    enrich: async ({ job }) => job,
    isStopping: () => stop,
    handle: async (posting) => {
      handled.push(posting.url);
      stop = true;
    },
  });
  assert.equal(handled.length, 1, `expected one posting before the stop, saw ${handled}`);
  assert.equal(stats.stopped, true);
});

test('withTimeout rejects with timedOut and the late value is ignored', async () => {
  await assert.rejects(withTimeout(new Promise((r) => setTimeout(() => r('late'), 200)), 20, 'x'), (err) => err.timedOut === true);
});

test('WorkQueue delivers in order and reports done only after close and drain', async () => {
  const q = new WorkQueue();
  q.push(1);
  q.push(2);
  assert.deepEqual(await q.pull(), { value: 1, done: false });
  q.close();
  assert.deepEqual(await q.pull(), { value: 2, done: false });
  assert.deepEqual(await q.pull(), { done: true });
});

test('circuit-open and rate-limited failures are blocked_by_site, not technical faults', () => {
  assert.equal(classify('failed', { reason: 'could not verify posting (circuit open for x.wd5.myworkdayjobs.com until 2026-11-17T16:01)' }), 'blocked_by_site');
  assert.equal(classify('failed', { reason: 'HTTP 429 Too Many Requests' }), 'blocked_by_site');
  assert.equal(classify('failed', { reason: 'Navigation timeout' }), 'failed_technical');
});
