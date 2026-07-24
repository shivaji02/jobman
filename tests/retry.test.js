const test = require('node:test');
const assert = require('node:assert/strict');
const { withRetry, isTransientError, isUiError } = require('../src/core/retry');

test('isTransientError detects timeouts and network errors', () => {
  assert.equal(isTransientError(new Error('Navigation timeout of 45000 ms exceeded')), true);
  assert.equal(isTransientError(new Error('net::ERR_CONNECTION_RESET')), true);
  assert.equal(isTransientError(new Error('button not found')), false);
});

test('isUiError detects missing UI / ATS skips', () => {
  assert.equal(isUiError(new Error('no Easy Apply — external ATS, skipped')), true);
  assert.equal(isUiError(new Error('Apply button not found')), true);
  assert.equal(isUiError(new Error('Navigation timeout')), false);
});

test('withRetry succeeds on first attempt', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry retries transient errors then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error('net::ERR_FAILED');
      return 'recovered';
    },
    { maxAttempts: 2, backoffMs: 1 }
  );
  assert.equal(result, 'recovered');
  assert.equal(calls, 2);
});

test('withRetry does not retry UI errors', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw new Error('Apply button not found');
        },
        { maxAttempts: 3, backoffMs: 1 }
      ),
    /Apply button not found/
  );
  assert.equal(calls, 1);
});
