/**
 * Verification queue — opportunities whose posting could not be verified (or whose
 * description could not be read) are kept, not lost, and retried on later runs.
 *
 * File: data/verification-queue.json  (see state-io for atomic, never-overwrite writes)
 *
 * States:
 *   NEEDS_VERIFICATION      queued; retried when nextRetryAt has passed
 *   VERIFIED_ACTIVE         the posting was re-read and is open (removed from due work)
 *   PERMANENTLY_UNAVAILABLE the posting is closed / gone (404, 410, "no longer listed")
 *   MANUAL_ACTION           attempts exhausted or blocked; moved to data/manual-actions.json
 *
 * A queued job is never classified as an active eligible opening. Duplicates are
 * merged by normalized official URL, and by company + requisition id when present.
 */
const path = require('path');
const { normalizeJobUrl } = require('./dedup');
const { readJsonState, writeJsonState } = require('./state-io');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'data', 'verification-queue.json');
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 15 * 60_000;
const MAX_DELAY_MS = 6 * 60 * 60_000;

const STATES = Object.freeze({
  NEEDS_VERIFICATION: 'NEEDS_VERIFICATION',
  VERIFIED_ACTIVE: 'VERIFIED_ACTIVE',
  PERMANENTLY_UNAVAILABLE: 'PERMANENTLY_UNAVAILABLE',
  MANUAL_ACTION: 'MANUAL_ACTION',
});

/**
 * Classify a verification failure.
 *   closed     → PERMANENTLY_UNAVAILABLE
 *   blocked    → MANUAL_ACTION (CAPTCHA, login wall, forbidden by the employer)
 *   transient  → NEEDS_VERIFICATION with backoff (429, 5xx, network, timeout, circuit open)
 *   unknown    → transient, but counted toward the attempt limit
 */
function classifyVerificationError(err) {
  if (!err) return { classification: 'unknown', reason: 'no error' };
  const msg = String(err.message || err);
  if (err.closed) return { classification: 'closed', reason: msg };
  if (/captcha|log ?in required|sign ?in|authentication|forbidden|\b403\b/i.test(msg)) return { classification: 'blocked', reason: msg };
  if (err.rateLimited || err.circuitOpen || err.retryable || (err.status && err.status >= 500) || err.status === 429) return { classification: 'transient', reason: msg };
  if (/ECONN|ETIMEDOUT|timeout|network|socket|fetch failed|aborted/i.test(msg)) return { classification: 'transient', reason: msg };
  return { classification: 'unknown', reason: msg };
}

/** Exponential backoff with a cap: 15m, 30m, 60m, … up to 6h. */
function nextDelayMs(attempts) {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
}

function keyOf(item) {
  return normalizeJobUrl(item.url) || item.url || '';
}

function reqKeyOf(item) {
  if (!item.requisitionId || !item.company) return '';
  return `${String(item.company).trim().toLowerCase()}|${String(item.requisitionId).trim().toLowerCase()}`;
}

function createVerificationQueue({ file = DEFAULT_FILE, now = () => Date.now(), maxAttempts = MAX_ATTEMPTS } = {}) {
  const load = () => {
    const data = readJsonState(file, () => ({ version: 1, items: {}, events: [] }));
    data.items = data.items || {};
    data.events = data.events || [];
    return data;
  };
  const iso = (ms) => new Date(ms).toISOString();

  function findExisting(data, item) {
    const k = keyOf(item);
    if (k && data.items[k]) return data.items[k];
    const rk = reqKeyOf(item);
    if (rk) return Object.values(data.items).find((e) => reqKeyOf(e) === rk) || null;
    return null;
  }

  /**
   * Queue a job that could not be verified. Duplicates merge into the existing entry
   * (keeps first-discovered time and attempt history, fills in missing fields).
   */
  function enqueue(item, { reason = '', classification = 'transient' } = {}) {
    const data = load();
    const at = now();
    const existing = findExisting(data, item);
    if (existing) {
      for (const f of ['company', 'title', 'url', 'requisitionId', 'source', 'applyUrl']) {
        if (!existing[f] && item[f]) existing[f] = item[f];
      }
      existing.lastSeenAt = iso(at);
      if (existing.state === STATES.PERMANENTLY_UNAVAILABLE || existing.state === STATES.MANUAL_ACTION) {
        // already decided; keep the decision, record that it was seen again
      } else if (existing.state !== STATES.VERIFIED_ACTIVE && !existing.nextRetryAt) {
        existing.nextRetryAt = iso(at);
      }
      writeJsonState(file, data);
      return { entry: existing, created: false };
    }
    const key = keyOf(item) || `${item.company || 'unknown'}|${item.title || 'unknown'}|${at}`;
    const entry = {
      key,
      company: item.company || '',
      title: item.title || '',
      url: item.url || '',
      requisitionId: item.requisitionId || '',
      source: item.source || '',
      applyUrl: item.applyUrl || '',
      firstDiscoveredAt: iso(at),
      lastAttemptAt: null,
      failureClassification: classification,
      retryCount: 0,
      nextRetryAt: iso(at),
      state: STATES.NEEDS_VERIFICATION,
      lastError: reason,
    };
    data.items[key] = entry;
    data.events.push({ type: 'enqueued', at: iso(at), key, reason });
    writeJsonState(file, data);
    return { entry, created: true };
  }

  /** Record one attempt. result: { ok: true } | { ok: false, error } | { ok: false, classification, reason } */
  function recordAttempt(key, result) {
    const data = load();
    const entry = data.items[key];
    if (!entry) throw new Error(`verification queue has no entry for ${key}`);
    const at = now();
    entry.lastAttemptAt = iso(at);
    if (result.ok) {
      entry.state = STATES.VERIFIED_ACTIVE;
      entry.verifiedAt = iso(at);
      entry.lastError = '';
      entry.nextRetryAt = null;
      data.events.push({ type: 'verified_active', at: iso(at), key });
      writeJsonState(file, data);
      return entry;
    }
    const c = result.error ? classifyVerificationError(result.error) : { classification: result.classification || 'unknown', reason: result.reason || '' };
    entry.failureClassification = c.classification;
    entry.lastError = c.reason;
    entry.retryCount += 1;
    if (c.classification === 'closed') {
      entry.state = STATES.PERMANENTLY_UNAVAILABLE;
      entry.nextRetryAt = null;
    } else if (c.classification === 'blocked' || entry.retryCount >= maxAttempts) {
      entry.state = STATES.MANUAL_ACTION;
      entry.nextRetryAt = null;
      entry.manualReason = c.classification === 'blocked' ? c.reason : `verification still unavailable after ${entry.retryCount} attempts: ${c.reason}`;
    } else {
      entry.state = STATES.NEEDS_VERIFICATION;
      entry.nextRetryAt = iso(at + nextDelayMs(entry.retryCount));
    }
    data.events.push({ type: 'attempt', at: iso(at), key, state: entry.state, classification: c.classification, reason: c.reason });
    writeJsonState(file, data);
    return entry;
  }

  /** Entries that are due for another verification attempt now. */
  function due(atMs = now()) {
    return Object.values(load().items).filter((e) => e.state === STATES.NEEDS_VERIFICATION && (!e.nextRetryAt || Date.parse(e.nextRetryAt) <= atMs));
  }

  function list(state) {
    const items = Object.values(load().items);
    return state ? items.filter((e) => e.state === state) : items;
  }

  /** Move an entry to a new state without an attempt (e.g. moved into manual-actions). */
  function setState(key, state, note = '') {
    const data = load();
    if (!data.items[key]) return null;
    data.items[key].state = state;
    if (note) data.items[key].manualReason = note;
    data.events.push({ type: 'state', at: iso(now()), key, state, note });
    writeJsonState(file, data);
    return data.items[key];
  }

  return { file, enqueue, recordAttempt, due, list, setState, load };
}

module.exports = { createVerificationQueue, classifyVerificationError, nextDelayMs, STATES, MAX_ATTEMPTS, DEFAULT_FILE };
