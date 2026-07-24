/**
 * Retry helpers for transient network/browser failures.
 * UI errors (button not found, external ATS) are not retried.
 */

function isTransientError(err) {
  const msg = (err && err.message) || String(err || '');
  return /timeout|timed out|net::|Navigation|Target closed|Protocol error|detached|Node is detached|Browser closed|Session closed|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(
    msg
  );
}

function isUiError(err) {
  const msg = (err && err.message) || String(err || '');
  return /not found|no Easy Apply|external ATS|login required|CAPTCHA|cannot be answered|unanswered required|Apply button/i.test(
    msg
  );
}

/**
 * Retry `fn` on transient errors only.
 * @param {() => Promise<T>} fn
 * @param {{ maxAttempts?: number, backoffMs?: number, label?: string, onRetry?: Function }} [opts]
 * @returns {Promise<T>}
 */
async function withRetry(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 2;
  const backoffMs = opts.backoffMs ?? 500;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (isUiError(err) || attempt === maxAttempts || !isTransientError(err)) {
        throw err;
      }
      const delay = backoffMs * attempt;
      if (typeof opts.onRetry === 'function') {
        opts.onRetry(err, attempt, delay);
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

module.exports = { withRetry, isTransientError, isUiError };
