/**
 * Manual-action queue — relevant opportunities that Jobman must not submit on its own.
 *
 * File: data/manual-actions.json. Entries are keyed by normalized official URL, so a
 * job already queued is updated (new blocker, last attempt) rather than duplicated.
 *
 * Blocker kinds: captcha | auth | missing_info | unsupported_form | resume_upload |
 *                verification_failed | submission_uncertain | other
 */
const path = require('path');
const { normalizeJobUrl } = require('./dedup');
const { readJsonState, writeJsonState } = require('./state-io');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'data', 'manual-actions.json');
const KINDS = Object.freeze({
  CAPTCHA: 'captcha',
  AUTH: 'auth',
  MISSING_INFO: 'missing_info',
  UNSUPPORTED_FORM: 'unsupported_form',
  RESUME_UPLOAD: 'resume_upload',
  VERIFICATION_FAILED: 'verification_failed',
  SUBMISSION_UNCERTAIN: 'submission_uncertain',
  OTHER: 'other',
});

/** Map a pipeline outcome/reason to a blocker kind. */
function kindFromReason(reason = '') {
  const r = String(reason);
  if (/captcha/i.test(r)) return KINDS.CAPTCHA;
  if (/login|sign ?in|authentication|auth/i.test(r)) return KINDS.AUTH;
  if (/resume.*(upload|fail|missing)|upload.*fail/i.test(r)) return KINDS.RESUME_UPLOAD;
  if (/unsupported|no direct|no supported submit route|manual form|not supported|external form|employer site/i.test(r)) return KINDS.UNSUPPORTED_FORM;
  if (/unanswered|required (field|question)|missing|needs? (your )?(input|answer)|not in (your )?profile|CTC|notice period/i.test(r)) return KINDS.MISSING_INFO;
  if (/did not finish|uncertain|no confirmation|unconfirmed/i.test(r)) return KINDS.SUBMISSION_UNCERTAIN;
  if (/verif|could not be read|unavailable/i.test(r)) return KINDS.VERIFICATION_FAILED;
  return KINDS.OTHER;
}

function createManualActions({ file = DEFAULT_FILE, now = () => Date.now() } = {}) {
  const load = () => {
    const data = readJsonState(file, () => ({ version: 1, items: {}, events: [] }));
    data.items = data.items || {};
    data.events = data.events || [];
    return data;
  };
  const iso = (ms) => new Date(ms).toISOString();

  /**
   * Add or update an action. Required: url, title or company. Missing fields are
   * kept as ''. Never removes a previously recorded resolution.
   */
  function upsert(item) {
    const key = normalizeJobUrl(item.url) || item.url;
    if (!key) throw new Error('manual action needs a URL');
    const data = load();
    const at = iso(now());
    const prev = data.items[key];
    const reason = item.exactReason || item.reason || '';
    const entry = {
      key,
      company: item.company || prev?.company || '',
      title: item.title || prev?.title || '',
      officialUrl: item.officialUrl || item.url || prev?.officialUrl || '',
      applicationUrl: item.applicationUrl || item.applyUrl || item.companyUrl || prev?.applicationUrl || item.url || '',
      requisitionId: item.requisitionId || prev?.requisitionId || '',
      resume: item.resume || prev?.resume || '',
      matchingReason: item.matchingReason || prev?.matchingReason || '',
      exactBlocker: reason || prev?.exactBlocker || '',
      blockerKind: item.blockerKind || kindFromReason(reason),
      requiredUserAction: item.requiredUserAction || requiredActionFor(item.blockerKind || kindFromReason(reason)),
      portal: item.portal || prev?.portal || '',
      firstQueuedAt: prev?.firstQueuedAt || at,
      lastAttempt: at,
      status: prev?.status === 'resolved' ? 'resolved' : 'open',
      resolvedAt: prev?.resolvedAt || null,
    };
    data.items[key] = entry;
    data.events.push({ type: prev ? 'updated' : 'queued', at, key, blockerKind: entry.blockerKind, reason });
    writeJsonState(file, data);
    return entry;
  }

  function resolve(url, note = '') {
    const key = normalizeJobUrl(url) || url;
    const data = load();
    const e = data.items[key];
    if (!e) return null;
    e.status = 'resolved';
    e.resolvedAt = iso(now());
    e.resolutionNote = note;
    data.events.push({ type: 'resolved', at: e.resolvedAt, key, note });
    writeJsonState(file, data);
    return e;
  }

  function list({ status = 'open' } = {}) {
    return Object.values(load().items).filter((e) => !status || e.status === status);
  }

  /** Counts by blocker kind for the daily report. */
  function summary() {
    const open = list({ status: 'open' });
    const byKind = {};
    for (const e of open) byKind[e.blockerKind] = (byKind[e.blockerKind] || 0) + 1;
    return { open: open.length, byKind };
  }

  return { file, upsert, resolve, list, summary, load };
}

function requiredActionFor(kind) {
  switch (kind) {
    case KINDS.CAPTCHA: return 'Open the application URL and complete the CAPTCHA yourself, then submit.';
    case KINDS.AUTH: return 'Sign in to the portal yourself, then apply from the application URL.';
    case KINDS.MISSING_INFO: return 'Answer the open questions yourself (do not guess), then submit.';
    case KINDS.UNSUPPORTED_FORM: return 'Apply on the employer site from the application URL.';
    case KINDS.RESUME_UPLOAD: return 'Upload the listed resume PDF manually on the application form.';
    case KINDS.VERIFICATION_FAILED: return 'Open the official posting and confirm it is still open and matches, then apply.';
    case KINDS.SUBMISSION_UNCERTAIN: return 'Check the portal for an existing application before any retry (it may have been submitted).';
    default: return 'Review the posting and apply manually if it still fits.';
  }
}

module.exports = { createManualActions, kindFromReason, requiredActionFor, KINDS, DEFAULT_FILE };
