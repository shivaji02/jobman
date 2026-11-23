const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { getJson, parseRetryAfter, HTTP_CONFIG, hostState } = require('../src/core/ats');

const realFetch = global.fetch;
const realRandom = Math.random;

function response(status, body = {}, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

function scriptedFetch(responses) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return calls;
}

beforeEach(() => {
  process.env.JOBMAN_HTTP_MIN_SPACING_MS = '0';
  process.env.JOBMAN_HTTP_MAX_RETRIES = '3';
  Math.random = () => 0; // deterministic jitter (delay = half the exponential step)
  hostState.clear();
});

afterEach(() => {
  global.fetch = realFetch;
  Math.random = realRandom;
  delete process.env.JOBMAN_HTTP_MIN_SPACING_MS;
  delete process.env.JOBMAN_HTTP_MAX_RETRIES;
  hostState.clear();
});

test('parseRetryAfter accepts seconds, HTTP dates and rejects junk', () => {
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('not-a-date'), null);
  const now = Date.parse('2026-11-17T00:00:00Z');
  assert.equal(parseRetryAfter('Tue, 17 Nov 2026 00:00:05 GMT', now), 5000);
  // capped at maxBackoffMs
  assert.equal(parseRetryAfter('9999'), HTTP_CONFIG.maxBackoffMs);
});

test('429 is retried and succeeds on a later attempt (Workday regression)', async () => {
  const calls = scriptedFetch([
    response(429, {}, { 'retry-after': '0' }),
    response(429, {}, { 'retry-after': '0' }),
    response(200, { jobPostings: [] }),
  ]);
  const data = await getJson('https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/site/jobs', { method: 'POST' });
  assert.deepEqual(data, { jobPostings: [] });
  assert.equal(calls.length, 3);
});

test('429 gives up after the bounded retry count and is classified as rate-limited', async () => {
  // Raise the breaker threshold so this test exercises the retry limit alone.
  const realThreshold = HTTP_CONFIG.breakerThreshold;
  HTTP_CONFIG.breakerThreshold = 100;
  try {
    const calls = scriptedFetch([response(429), response(429), response(429), response(429)]);
    await assert.rejects(getJson('https://api.example.test/x'), (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.rateLimited, true);
      assert.equal(err.retryable, true);
      return true;
    });
    assert.equal(calls.length, 4); // 1 attempt + 3 retries
  } finally {
    HTTP_CONFIG.breakerThreshold = realThreshold;
  }
});

test('the breaker stops retries early once a host is blocked enough times', async () => {
  const calls = scriptedFetch([response(429), response(429), response(429), response(429)]);
  await assert.rejects(getJson('https://api.example.test/early'), (err) => err.circuitOpen === true);
  assert.equal(calls.length, HTTP_CONFIG.breakerThreshold);
});

test('Retry-After header is honored before retrying', async () => {
  const sleeps = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => {
    if (ms >= 0 && ms !== 15_000) sleeps.push(ms);
    return realSetTimeout(fn, 0);
  };
  try {
    scriptedFetch([response(429, {}, { 'retry-after': '7' }), response(200, {})]);
    await getJson('https://api.example.test/retry-after');
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.ok(sleeps.includes(7000), `expected a 7000ms wait, saw ${sleeps}`);
});

test('404/410 are still classified as closed postings and not retried', async () => {
  const calls = scriptedFetch([response(404)]);
  await assert.rejects(getJson('https://api.example.test/gone'), (err) => err.closed === true);
  assert.equal(calls.length, 1);
});

test('5xx is retried, and non-transient 4xx is not', async () => {
  let calls = scriptedFetch([response(503), response(200, { ok: 1 })]);
  assert.deepEqual(await getJson('https://api.example.test/5xx'), { ok: 1 });
  assert.equal(calls.length, 2);

  calls = scriptedFetch([response(400)]);
  await assert.rejects(getJson('https://api.example.test/bad'), (err) => err.retryable === false);
  assert.equal(calls.length, 1);
});

test('network errors are retried then reported as retryable', async () => {
  const calls = scriptedFetch([new Error('ECONNRESET'), new Error('ECONNRESET'), new Error('ECONNRESET'), new Error('ECONNRESET')]);
  await assert.rejects(getJson('https://api.example.test/net'), (err) => err.retryable === true);
  assert.equal(calls.length, 4);
});

test('circuit breaker opens after repeated blocks and fails fast without calling fetch', async () => {
  // Three separate calls each returning 429 with no retries left, then one more call.
  process.env.JOBMAN_HTTP_MAX_RETRIES = '0';
  for (let i = 0; i < HTTP_CONFIG.breakerThreshold; i++) {
    scriptedFetch([response(429)]);
    await assert.rejects(getJson('https://blocked.example.test/x'));
  }
  const calls = scriptedFetch([response(200, {})]);
  await assert.rejects(getJson('https://blocked.example.test/y'), (err) => err.circuitOpen === true);
  assert.equal(calls.length, 0, 'fetch must not be called while the circuit is open');
});

test('circuit breaker is per host: other hosts keep working', async () => {
  process.env.JOBMAN_HTTP_MAX_RETRIES = '0';
  for (let i = 0; i < HTTP_CONFIG.breakerThreshold; i++) {
    scriptedFetch([response(429)]);
    await assert.rejects(getJson('https://blocked.example.test/x'));
  }
  scriptedFetch([response(200, { fine: true })]);
  assert.deepEqual(await getJson('https://healthy.example.test/x'), { fine: true });
});

test('requests to one host are spaced by the minimum interval', async () => {
  process.env.JOBMAN_HTTP_MIN_SPACING_MS = '60';
  const stamps = [];
  global.fetch = async () => {
    stamps.push(Date.now());
    return response(200, {});
  };
  await Promise.all([getJson('https://paced.example.test/a'), getJson('https://paced.example.test/b'), getJson('https://paced.example.test/c')]);
  for (let i = 1; i < stamps.length; i++) {
    assert.ok(stamps[i] - stamps[i - 1] >= 55, `gap ${stamps[i] - stamps[i - 1]}ms too small`);
  }
});
