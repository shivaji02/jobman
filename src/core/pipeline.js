/**
 * Application pipeline — runs *alongside* discovery, not after it.
 *
 *   discovery (portal bots)            cards → card-level screen (core/evaluate)
 *        │ offer(): eligible-on-card or inconclusive-card listings
 *        ▼
 *   enrich      bounded pool  — fetch the full description (core/enrich, cached)
 *   evaluate    synchronous   — final decision on the best evidence available
 *   prepare     bounded pool  — resume, apply channel, profile gaps → approval queue
 *   approval    per job       — you approve by id (core/approval); polled live
 *   submit      global application slots + one in flight per portal, stall timeout
 *   verify      inside each portal's apply routine (success text / Applied state +
 *               screenshot); no evidence → "unconfirmed", never resubmitted
 *
 * Every offered listing ends in exactly one bucket of its portal's results, which
 * the runner merges into the report, so the funnel still reconciles. Duplicate
 * submissions are prevented three ways: the CSV log (prior runs), the job store's
 * atomic claims + write-ahead journal (this run, all workers), and the pipeline's
 * own key/fingerprint index (the same job offered by two portals).
 */
const { Semaphore, sleep } = require('./concurrency');
const { normalizeJobUrl, jobFingerprint } = require('./dedup');
const { evaluateJob, unresolved, evidenceSnippets } = require('./evaluate');
const { evidenceNote } = require('./evidence');
const fs = require('fs');
const path = require('path');
const { parseExperienceRange, experienceFromText } = require('./filter');
const { createVerificationQueue } = require('./verification-queue');
const { createManualActions } = require('./manual-actions');
const { autoApplyGate, autoApplyEnabled, DIRECT_SUBMIT_PORTALS } = require('./auto-apply');

/** Side-effect files (data/*.json) are written only in real runs, never by tests or dry runs. */
const realRunSideEffects = (dryRun) => !dryRun && !process.env.NODE_TEST_CONTEXT;

const BUCKET_FOR = {
  eligible: 'awaitingApproval',
  rejected: 'skipped',
  needs_enrichment: 'insufficient',
};

const CHANNEL = {
  linkedin: 'LinkedIn Easy Apply',
  naukri: 'Naukri apply (may open employer site)',
  talent: 'Talent.com quick apply / redirect',
  wellfound: 'Wellfound apply',
  indeed: 'Indeed apply',
  foundit: 'Foundit Apply Now',
  instahyre: 'Instahyre apply',
  careers: 'employer ATS form',
  google: 'employer ATS form',
  yourstory: 'YourStory careers',
};

function stageMetrics(name, limit) {
  return { name, limit, n: 0, waitMs: [], runMs: [], busyMs: 0, active: 0, peak: 0, firstStart: null, lastEnd: null };
}

function pct(list, p) {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function summarizeStage(m, wallMs) {
  const span = wallMs || (m.firstStart != null && m.lastEnd != null ? m.lastEnd - m.firstStart : 0);
  return {
    name: m.name,
    count: m.n,
    limit: m.limit,
    peak: m.peak,
    waitP50: pct(m.waitMs, 50),
    waitP95: pct(m.waitMs, 95),
    runP50: pct(m.runMs, 50),
    runP95: pct(m.runMs, 95),
    busyMs: m.busyMs,
    elapsedMs: span,
    throughputPerMin: span > 0 ? m.n / (span / 60_000) : 0,
    utilization: span && m.limit ? Math.min(1, m.busyMs / (span * m.limit)) : 0,
  };
}

function createPipeline({
  enricher = null,
  approvals = null,
  store = null,
  log,
  dryRun = false,
  profile = {},
  adapters = {},
  browser = null,
  approvedJobs = new Set(),
  limits = {},
  submitTimeoutMs = Number(process.env.JOBMAN_SUBMIT_TIMEOUT_MS) || 240_000,
  selectResume = (title, text) => require('../bots/wellfound').selectResume(title, text),
  logger = require('./logger'),
  now = () => Date.now(),
  diagnosticsFile = null,
  autoApply = autoApplyEnabled(),
  verificationQueue = realRunSideEffects(dryRun) && process.env.JOBMAN_VERIFICATION_QUEUE !== '0' ? createVerificationQueue() : null,
  manualActions = realRunSideEffects(dryRun) ? createManualActions() : null,
} = {}) {
  const lim = { enrich: limits.enrich ?? (Number(process.env.JOBMAN_ENRICH_WORKERS) || 6), prepare: limits.prepare ?? 2 };
  const sems = { enrich: new Semaphore(lim.enrich, { name: 'enrich' }), prepare: new Semaphore(lim.prepare, { name: 'prepare' }) };
  const portalLocks = new Map(); // portal → Semaphore(1): one submission in flight per portal
  const metrics = { enrich: stageMetrics('enrich', lim.enrich), evaluate: stageMetrics('evaluate', 1), prepare: stageMetrics('prepare', lim.prepare), submit: stageMetrics('submit', store?.applySlots?.limit || 1) };
  const records = new Map(); // key → record
  const byFp = new Map(); // fingerprint → key
  const out = {}; // portal → buckets
  const carryOver = []; // approved in an earlier run, not rediscovered this run
  const inFlight = new Set();
  const counters = { offered: 0, offeredUncertain: 0, offeredEligible: 0, crossPortalDupes: 0, enrichedOk: 0, enrichFailed: 0, eligible: 0, eligiblePrior: 0, eligibleCardOnly: 0, rejectedAfterEnrich: 0, insufficient: 0, awaitingApproval: 0, approved: 0, autoApproved: 0, autoBlocked: 0, verificationQueued: 0, manualQueued: 0, attempted: 0, verified: 0, unconfirmed: 0, submitFailed: 0, stalled: 0, rescued: 0 };
  const perPortal = {};
  let pollTimer = null;
  let closed = false;

  const P = (portal) => (perPortal[portal] = perPortal[portal] || { offered: 0, enriched: 0, eligible: 0, rejected: 0, insufficient: 0, awaiting: 0, attempted: 0, verified: 0 });
  const bucketsOf = (portal) => (out[portal] = out[portal] || { applied: [], unconfirmed: [], alreadyApplied: [], manualApply: [], skipped: [], failed: [], awaitingApproval: [], insufficient: [] });

  function track(stage, fn) {
    const m = metrics[stage];
    const t0 = now();
    m.n++;
    m.active++;
    m.peak = Math.max(m.peak, m.active);
    if (m.firstStart == null) m.firstStart = t0;
    return Promise.resolve()
      .then(fn)
      .finally(() => {
        const ms = now() - t0;
        m.active--;
        m.runMs.push(ms);
        m.busyMs += ms;
        m.lastEnd = now();
      });
  }

  async function inStage(stage, sem, fn) {
    const queued = now();
    const release = await sem.acquire();
    metrics[stage].waitMs.push(now() - queued);
    try {
      return await track(stage, fn);
    } finally {
      release();
    }
  }

  /** Lean copy for reports: no description blobs. */
  function entryOf(rec, extra = {}) {
    const j = rec.job;
    const e = { title: j.title, company: j.company, url: j.url, location: j.location };
    if (rec.resume) e.resume = rec.resume;
    if (rec.approvalId) e.approvalId = rec.approvalId;
    if (rec.verdict) e.evidenceLevel = rec.verdict.evidence;
    return { ...e, ...extra };
  }

  function finalize(rec, bucket, extra = {}) {
    if (rec.final) return;
    writeDiagnostic(rec, bucket, extra);
    rec.final = { bucket, at: now() };
    rec.stage = 'done';
    bucketsOf(rec.portal)[bucket].push(entryOf(rec, extra));
  }

  function writeDiagnostic(rec, bucket, extra) {
    if (!diagnosticsFile) return;
    const text = rec.fullText || rec.description || rec.partialDescription || '';
    const descriptionEvidence = [text, ...(rec.priorEvidenceSnippets || [])].filter(Boolean).join('\n');
    const cardBlob = `${rec.job.title || ''} ${rec.cardText || ''} ${rec.partialDescription || ''}`;
    const technologies = (blob) => [
      ['React Native', /react\s*native/i], ['React', /\breact(?:\.js|js)?\b/i],
      ['JavaScript', /\bjavascript\b|\bes6\b/i], ['TypeScript', /\btypescript\b/i],
      ['Node.js', /\bnode(?:\.js|js)?\b/i], ['Python', /\bpython\b/i], ['Java', /\bjava\b/i],
      ['Expo', /\bexpo\b/i], ['Angular', /\bangular\b/i], ['Vue', /\bvue(?:\.js|js)?\b/i],
      ['Flutter', /\bflutter\b/i], ['.NET', /\.net\b|dotnet|c#/i],
    ].filter(([, re]) => re.test(blob)).map(([name]) => name);
    const experience = parseExperienceRange(rec.experienceText) || experienceFromText(text) || experienceFromText(rec.partialDescription) || null;
    const record = {
      at: new Date(now()).toISOString(), portal: rec.portal,
      title: rec.job.title || '', employer: rec.job.company || '', location: rec.job.location || '',
      url: rec.job.url || rec.key, stage: rec.stage, disposition: bucket,
      availableDescriptionLength: rec.existingApproval && !text ? (rec.priorDescriptionLength ?? null) : (text.length || rec.partialDescription?.length || rec.cardText.length),
      cardTextLength: rec.cardText.length,
      partialDescriptionLength: rec.partialDescription?.length || 0,
      fullDescriptionFetched: !!rec.enrichment?.ok,
      fullDescriptionLength: rec.fullText?.length || rec.description?.length || rec.priorDescriptionLength || null,
      fullDescriptionSufficient: rec.existingApproval ? rec.verdict?.evidence === 'full' : (rec.fullText?.length || rec.description?.length || 0) >= 400,
      enrichment: rec.enrichment || null,
      technologies: [...new Set([...technologies(cardBlob), ...technologies(descriptionEvidence)])],
      technologiesOnCard: technologies(cardBlob),
      technologiesInDescription: technologies(descriptionEvidence),
      experienceRequirement: experience, experienceText: rec.experienceText || '',
      cardScore: rec.cardVerdict?.score ?? null,
      eligibilityScore: rec.verdict?.score ?? null,
      decision: rec.verdict?.decision || bucket,
      evidence: rec.verdict?.evidence || null,
      exactReason: extra.reason || rec.verdict?.reason || bucket,
      approvalId: rec.approvalId || null,
    };
    try {
      fs.mkdirSync(path.dirname(diagnosticsFile), { recursive: true });
      fs.appendFileSync(diagnosticsFile, `${JSON.stringify(record)}\n`);
    } catch (err) {
      logger.warn(`[pipeline] candidate diagnostics could not be written: ${err.message}`);
    }
  }

  function csv(rec, status, notes) {
    if (dryRun || !log) return;
    log.append({ site: rec.site, job_title: rec.job.title, company: rec.job.company, job_url: rec.key, status, notes });
  }

  /** Keep a job whose posting/description could not be verified for a later run. Never throws. */
  function queueVerification(rec, reason, classification = 'transient') {
    if (!verificationQueue) return;
    try {
      verificationQueue.enqueue({
        company: rec.job.company, title: rec.job.title, url: rec.job.url, applyUrl: rec.job.applyUrl || '',
        requisitionId: rec.job.requisitionId || '', source: rec.portal,
      }, { reason, classification });
      counters.verificationQueued++;
    } catch (err) {
      logger.warn(`[pipeline] verification queue write failed: ${err.message}`);
    }
  }

  /** Put a relevant opportunity that needs a person into the manual-action queue. Never throws. */
  function queueManual(rec, reason, extra = {}) {
    if (!manualActions) return;
    try {
      manualActions.upsert({
        url: rec.job.url, company: rec.job.company, title: rec.job.title, portal: rec.portal,
        resume: rec.resume || '', requisitionId: rec.job.requisitionId || '',
        matchingReason: rec.verdict?.reason || '', exactReason: reason,
        applicationUrl: extra.companyUrl || rec.job.applyUrl || rec.job.url,
      });
      counters.manualQueued++;
    } catch (err) {
      logger.warn(`[pipeline] manual-action write failed: ${err.message}`);
    }
  }

  // ------------------------------------------------------------------ offer

  /**
   * Hand a listing to the pipeline. Never blocks the portal bot.
   *   opts.verdict   card-level evaluateJob() result (computed here when absent)
   *   opts.text      card snippet; opts.description: full description if the bot already has it
   */
  function offer(portal, job, opts = {}) {
    const key = normalizeJobUrl(job.url) || job.url;
    const site = opts.site || portal;
    counters.offered++;
    P(portal).offered++;
    const fp = jobFingerprint(job.company, job.title);
    const prior = records.get(key) || (fp && byFp.get(fp) ? records.get(byFp.get(fp)) : null);
    const rec = {
      key,
      portal,
      site,
      job: { title: job.title, company: job.company, url: job.url, location: opts.location || job.location || '', ...((opts.detailUrl || job.detailUrl) ? { detailUrl: opts.detailUrl || job.detailUrl } : {}) },
      cardText: [opts.text, job.description, opts.description && opts.description.length < 400 ? opts.description : ''].filter(Boolean).join(' ').slice(0, 2000),
      partialDescription: opts.description && opts.description.length < 400 ? opts.description : '',
      description: opts.description && opts.description.length >= 400 ? opts.description : '',
      experienceText: opts.experienceText || '',
      applyContext: opts.applyContext || null,
      offeredAt: now(),
      stage: 'queued',
    };
    if (prior && prior !== rec) {
      counters.crossPortalDupes++;
      // Not recorded in `records`: this listing's disposition is final right away.
      finalize(rec, 'alreadyApplied', { reason: `same ${prior.key === key ? 'job' : 'role'} already in the pipeline via ${prior.portal}` });
      return;
    }
    records.set(key, rec);
    if (fp) byFp.set(fp, key);
    rec.verdict = opts.verdict || evaluateJob({ title: job.title, description: rec.description || rec.cardText, experienceText: rec.experienceText, source: rec.description ? 'full' : 'card' });
    rec.cardVerdict = rec.verdict;
    if (rec.verdict.decision === 'needs_enrichment') counters.offeredUncertain++;
    else counters.offeredEligible++;

    const existing = approvals?.get(key);
    if (existing?.status === 'declined') {
      finalize(rec, 'skipped', { reason: `declined by you on ${String(existing.decidedAt || '').slice(0, 10)}` });
      return;
    }
    if (existing?.status === 'pending' && !autoApply) {
      // Incremental: already prepared in an earlier run; keep it in the queue, don't redo the work.
      rec.approvalId = existing.id;
      rec.resume = existing.resume;
      rec.existingApproval = true;
      rec.priorEvidenceSnippets = existing.snippets || [];
      rec.priorDescriptionLength = existing.fullDescriptionLength ?? null;
      rec.verdict = { decision: 'eligible', score: existing.score ?? null, evidence: existing.evidence || 'unknown', reason: existing.why || 'previously prepared approval' };
      rec.enrichment = { ok: existing.evidence === 'full', via: 'approval-record', cached: true };
      rec.stage = 'awaiting_approval';
      rec.preparedAt = Date.parse(existing.preparedAt) || now();
      counters.eligiblePrior++;
      counters.awaitingApproval++;
      P(portal).awaiting++;
      approvals.upsertPrepared({ url: job.url });
      return; // finalized as awaitingApproval at drain unless approved meanwhile
    }
    // Auto mode re-evaluates previously prepared jobs instead of permanently
    // leaving them in the old approval gate. No cached approval is trusted.
    if (existing?.status === 'pending') {
      rec.existingApproval = true;
      rec.approvalId = existing.id;
    }
    const p = run(rec);
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
  }

  // ------------------------------------------------------------------ stages

  async function run(rec) {
    try {
      // ---- enrich ----
      let full = rec.description;
      let posted = null;
      let whyNot = '';
      if (!full && enricher) {
        rec.stage = 'enriching';
        const r = await inStage('enrich', sems.enrich, () => enricher.enrich({ url: rec.job.detailUrl || rec.job.url }));
        if (r.ok) {
          full = r.text;
          posted = r.postedDaysAgo;
          counters.enrichedOk++;
          P(rec.portal).enriched++;
        } else {
          whyNot = r.blocked || r.error || 'unavailable';
          counters.enrichFailed++;
          // The description could not be read: keep the job for re-verification.
          // This is never a rejection; the evaluator decides only on evidence.
          queueVerification(rec, `full description not read: ${whyNot}`, r.blocked ? 'blocked' : 'transient');
        }
        rec.enrichment = { ok: !!r.ok, via: r.via || null, cached: !!r.cached, error: r.error || null, blocked: r.blocked || null };
      } else if (!full) {
        whyNot = 'enrichment disabled';
        rec.enrichment = { ok: false, error: whyNot };
      } else {
        rec.enrichment = { ok: true, via: 'provided-by-discovery', cached: false };
      }
      rec.fullText = full || '';

      // ---- evaluate ----
      rec.stage = 'evaluating';
      const verdict = await track('evaluate', () =>
        full
          ? evaluateJob({ title: rec.job.title, description: full, experienceText: rec.experienceText, source: 'full', postedDaysAgo: posted ?? undefined })
          : unresolved(rec.verdict, whyNot)
      );
      rec.verdict = verdict;
      if (verdict.decision === 'rejected') {
        counters.rejectedAfterEnrich++;
        P(rec.portal).rejected++;
        csv(rec, 'skipped', verdict.reason);
        finalize(rec, 'skipped', { reason: verdict.reason });
        return;
      }
      if (verdict.decision === 'needs_enrichment') {
        counters.insufficient++;
        P(rec.portal).insufficient++;
        // Deliberately no CSV row: the job is re-screened next run.
        queueVerification(rec, `insufficient evidence: ${verdict.reason}`);
        finalize(rec, 'insufficient', { reason: verdict.reason });
        return;
      }
      // Auto-apply needs the posting read live in this run; a cached description
      // can never pass the gate (2026-11-23: 141/178 reads were cache hits, so
      // queued jobs stayed pending forever). Re-read only jobs that are eligible.
      if (autoApply && rec.enrichment?.cached && enricher) {
        rec.stage = 'enriching';
        const r = await inStage('enrich', sems.enrich, () => enricher.enrich({ url: rec.job.detailUrl || rec.job.url, fresh: true }));
        if (r.ok && r.text) {
          rec.fullText = r.text;
          rec.enrichment = { ok: true, via: r.via || null, cached: false, error: null, blocked: null };
          const fresh = evaluateJob({ title: rec.job.title, description: r.text, experienceText: rec.experienceText, source: 'full', postedDaysAgo: r.postedDaysAgo ?? undefined });
          if (fresh.decision === 'rejected') {
            counters.rejectedAfterEnrich++;
            P(rec.portal).rejected++;
            csv(rec, 'skipped', fresh.reason);
            finalize(rec, 'skipped', { reason: fresh.reason });
            return;
          }
          if (fresh.decision === 'eligible') rec.verdict = fresh;
        }
        // On failure the cached verdict stands; the gate keeps the job for review.
      }

      counters.eligible++;
      P(rec.portal).eligible++;
      if (rec.verdict.evidence === 'card') counters.eligibleCardOnly++;

      // ---- prepare ----
      rec.stage = 'preparing';
      await inStage('prepare', sems.prepare, async () => prepare(rec));

      // ---- autonomous approval (JOBMAN_AUTO_APPLY=1) ----
      if (autoApply) {
        const auto = await autoDecide(rec);
        if (auto === 'dry-run') {
          await submit(rec); // dry run: reports "would submit"; writes no state
          return;
        }
      }

      // ---- approval / submit ----
      const st = approvals?.get(rec.key)?.status;
      if (st === 'approved' || approvedJobs.has(rec.key)) {
        await submit(rec);
        return;
      }
      rec.stage = 'awaiting_approval';
      counters.awaitingApproval++;
      P(rec.portal).awaiting++;
    } catch (err) {
      logger.warn(`[pipeline] ${rec.portal} "${rec.job.title}": ${err.message}`);
      finalize(rec, 'failed', { reason: `pipeline error: ${err.message}` });
    }
  }

  /**
   * JOBMAN_AUTO_APPLY=1: decide without an individual approval, but only when the
   * gate (core/auto-apply) finds no blockers. Returns 'approved' | 'dry-run' | 'blocked'.
   * Blocked jobs stay pending for review; relevant ones needing a person go to the
   * manual-action queue. Nothing is invented: unknown answers are left to the adapter.
   */
  async function autoDecide(rec) {
    const entry = approvals?.get(rec.key);
    const priorApplied = !!(log?.priorDisposition && log.priorDisposition(rec.key, rec.job));
    const gate = autoApplyGate({
      url: rec.job.url, portal: rec.portal, title: rec.job.title, company: rec.job.company,
      location: rec.job.location, verdict: rec.verdict, enrichment: rec.enrichment,
      fullText: rec.fullText, resume: rec.resume, flags: entry?.flags || [], priorApplied,
      supportedPortal: !!adapters[rec.portal] && DIRECT_SUBMIT_PORTALS.has(rec.portal),
    });
    if (!gate.eligible) {
      counters.autoBlocked++;
      rec.autoBlockers = gate.blockers;
      const needsPerson = rec.verdict?.decision === 'eligible' && gate.blockers.some((b) => /no supported submit route|resume/.test(b));
      if (needsPerson) queueManual(rec, gate.blockers.join('; '));
      return 'blocked';
    }
    if (dryRun) {
      counters.autoApproved++;
      return 'dry-run';
    }
    if (approvals) {
      const r = approvals.autoApprove(rec.key, { note: `auto-apply gate passed (${Object.entries(gate.checks).filter(([, v]) => v === true).map(([k]) => k).join(', ')})` });
      if (!r.changed && approvals.get(rec.key)?.status !== 'approved') {
        counters.autoBlocked++;
        rec.autoBlockers = [r.reason || 'not pending'];
        return 'blocked';
      }
    } else {
      approvedJobs.add(rec.key);
    }
    counters.autoApproved++;
    return 'approved';
  }

  function prepare(rec) {
    const text = rec.fullText || rec.cardText;
    rec.resume = selectResume(rec.job.title, text);
    const flags = [];
    if (!profile.current_ctc) flags.push('current CTC not in profile — a form asking for it is handed to you');
    if (rec.verdict.evidence === 'card') flags.push('full description could not be read — decided on the listing card');
    const bal = require('./filter').stackBalance(text);
    if (bal.dominant === 'other') flags.push(`description is mainly ${bal.top.join(' / ')} (${bal.competing} mentions vs ${bal.js} React/Node/TS) — check fit before approving`);
    if (!adapters[rec.portal]) flags.push(`submitted by the ${rec.portal} bot the next time it lists this job (no direct-URL apply for this portal)`);
    rec.preparedAt = now();
    const entry = {
      url: rec.job.url,
      ...(rec.job.detailUrl ? { detailUrl: rec.job.detailUrl } : {}),
      portal: rec.portal,
      site: rec.site,
      title: rec.job.title,
      company: rec.job.company,
      location: rec.job.location,
      score: rec.verdict.score,
      experienceRequirement: parseExperienceRange(rec.experienceText) || experienceFromText(text) || null,
      experienceText: rec.experienceText || '',
      technologyMatch: [...new Set(evidenceSnippets(text).flatMap((s) => (s.match(/React Native|React|JavaScript|TypeScript|Node(?:\.js)?|Python|Java|Expo/gi) || [])))],
      evidence: rec.verdict.evidence,
      fullDescriptionLength: rec.fullText?.length || rec.description?.length || null,
      why: rec.verdict.reason,
      snippets: evidenceSnippets(text),
      resume: rec.resume,
      channel: CHANNEL[rec.portal] || rec.portal,
      flags,
      applicationRequirements: [...flags],
      ...(rec.applyContext ? { applyContext: rec.applyContext } : {}),
      ...(rec.job.applyUrl ? { applyUrl: rec.job.applyUrl } : {}),
      ...(rec.job.ats ? { ats: rec.job.ats } : {}),
      dryRun: dryRun || undefined,
    };
    if (approvals && !dryRun) rec.approvalId = approvals.upsertPrepared(entry).id;
    else if (approvals) rec.approvalId = approvals.get(rec.key)?.id || null;
  }

  async function submit(rec, { carry = false } = {}) {
    const adapter = adapters[rec.portal];
    counters.approved++;
    if (!adapter) {
      rec.stage = 'approved_inline';
      approvedJobs.add(rec.key);
      if (!carry) finalize(rec, 'awaitingApproval', { reason: `approved (id ${rec.approvalId || '?'}) — the ${rec.portal} bot submits it when it next lists this job` });
      return;
    }
    if (dryRun) {
      if (!carry) finalize(rec, 'applied', { reason: `would submit — approved (id ${rec.approvalId || '?'}) via ${CHANNEL[rec.portal] || rec.portal}` });
      else carryOver.push(entryOf(rec, { outcome: 'would submit (dry run)' }));
      return;
    }
    rec.stage = 'queued_submit';
    const lock = portalLocks.get(rec.portal) || portalLocks.set(rec.portal, new Semaphore(1, { name: `submit:${rec.portal}` })).get(rec.portal);
    const queued = now();
    const releasePortal = await lock.acquire();
    let view = null;
    try {
      view = store ? store.view(rec.portal, { site: rec.site }) : null;
      const claim = view ? await view.claimForApply(rec.key, rec.job) : { ok: !log?.priorDisposition || !log.priorDisposition(rec.key, rec.job) };
      metrics.submit.waitMs.push(now() - queued);
      if (!claim.ok) {
        const reason = claim.reason || 'already handled';
        return place(rec, carry, 'alreadyApplied', { reason }, { status: 'already', reason });
      }
      if (approvals && rec.approvalId && !approvals.markSubmitting(rec.key)) {
        return place(rec, carry, 'alreadyApplied', { reason: 'approval is no longer in approved state; no submission attempted' }, { status: 'already', reason: 'approval state changed before submission' });
      }
      rec.stage = 'submitting';
      counters.attempted++;
      P(rec.portal).attempted++;
      const job = { ...rec.job, text: rec.fullText || rec.cardText, resume: rec.resume, ...(rec.applyContext || {}) };
      let outcome;
      for (let attempt = 1; attempt <= 2; attempt++) {
        outcome = await track('submit', () => withTimeout(adapter({ browser, profile, job }), submitTimeoutMs));
        // Retry once, and only when nothing can have been submitted (CLAUDE.md: retry failed once).
        if (outcome.status !== 'failed' || outcome.submitted || attempt === 2) break;
        if (outcome.skipPortal || outcome.skipAsScreening || /login required|not found|captcha/i.test(outcome.reason || '')) break;
        logger.warn(`[pipeline] ${rec.portal} "${rec.job.title}": attempt 1 failed before submit (${outcome.reason}) — retrying once`);
        await closeQuietly(outcome.page);
        await sleep(2000);
      }
      record(rec, view, outcome, carry);
    } catch (err) {
      const reason = `submission error: ${err.message}`;
      if (view) view.append({ site: rec.site, job_title: rec.job.title, company: rec.job.company, job_url: rec.key, status: 'failed', notes: reason });
      queueManual(rec, reason);
      place(rec, carry, 'failed', { reason }, { status: 'failed', reason });
    } finally {
      view?.close();
      releasePortal();
      await sleep(dryRun ? 0 : 2000 + Math.random() * 1000); // rate-limit gap between applications (CLAUDE.md: 2–3 s)
    }
  }

  function place(rec, carry, bucket, extra, outcome) {
    approvals?.recordOutcome(rec.key, { ...outcome, at: new Date(now()).toISOString() });
    if (carry) carryOver.push(entryOf(rec, { ...extra, outcome: bucket }));
    else finalize(rec, bucket, extra);
  }

  function record(rec, view, outcome, carry) {
    const row = (status, notes) => (view ? view.append({ site: rec.site, job_title: rec.job.title, company: rec.job.company, job_url: rec.key, status, notes }) : csv(rec, status, notes));
    const tag = `approved submission (id ${rec.approvalId || '?'}; resume=${rec.resume || '-'})`;
    switch (outcome.status) {
      case 'applied':
        if (outcome.evidence) {
          counters.verified++;
          P(rec.portal).verified++;
          row('applied', `${tag} | ${evidenceNote(outcome.evidence)}`);
          closeQuietly(outcome.page);
          return place(rec, carry, 'applied', { evidence: outcome.evidence, reason: tag }, { status: 'applied', evidence: outcome.evidence.signal });
        }
      // falls through: "applied" without evidence is not verified
      case 'unconfirmed':
      case 'stalled': {
        counters.unconfirmed++;
        if (outcome.status === 'stalled') counters.stalled++;
        const reason = outcome.reason || 'submitted; no confirmation seen';
        row('unconfirmed', `${tag} | ${reason}`);
        queueManual(rec, `submission uncertain — verify on the portal before any retry: ${reason}`);
        return place(rec, carry, 'unconfirmed', { reason }, { status: 'unconfirmed', reason });
      }
      case 'already-applied':
        row('applied', 'already applied on the portal');
        closeQuietly(outcome.page);
        return place(rec, carry, 'alreadyApplied', { reason: `already applied on ${rec.portal}` }, { status: 'already' });
      case 'manual-apply': {
        const reason = outcome.reason || 'needs you';
        row('manual-apply', `${reason}${outcome.companyUrl ? ` | URL: ${outcome.companyUrl}` : ''}`);
        queueManual(rec, reason, { companyUrl: outcome.companyUrl });
        return place(rec, carry, 'manualApply', { reason, companyUrl: outcome.companyUrl || rec.job.url }, { status: 'manual', reason });
      }
      case 'rejected':
      case 'expired': {
        const reason = outcome.reason || (outcome.status === 'expired' ? 'posting closed' : 'rejected on the live posting');
        row('skipped', reason);
        closeQuietly(outcome.page);
        return place(rec, carry, 'skipped', { reason }, { status: 'skipped', reason });
      }
      default: {
        counters.submitFailed++;
        const reason = outcome.reason || 'apply failed';
        row('failed', reason);
        queueManual(rec, reason);
        return place(rec, carry, 'failed', { reason }, { status: 'failed', reason });
      }
    }
  }

  /** A stalled form must not hold a slot forever. The tab stays open; the state is unknown → unconfirmed. */
  function withTimeout(promise, ms) {
    let t;
    return Promise.race([
      promise.catch((err) => ({ status: 'failed', reason: err.message })),
      new Promise((resolve) => {
        t = setTimeout(() => resolve({ status: 'stalled', reason: `apply form did not finish within ${Math.round(ms / 1000)} s — tab left open, submission state unknown (never resubmitted)` }), ms);
        t.unref?.();
      }),
    ]).finally(() => clearTimeout(t));
  }

  async function closeQuietly(page) {
    try {
      if (page && !page.isClosed?.()) await page.close();
    } catch {
      // ignore
    }
  }

  // ------------------------------------------------------------------ approvals polling

  /** Pick up approvals made from another terminal while the run is going. */
  function pollApprovals() {
    if (!approvals || closed) return;
    let approved;
    try {
      approved = approvals.list({ status: 'approved' });
    } catch (err) {
      logger.debug(`[pipeline] approvals not readable: ${err.message}`);
      return;
    }
    for (const a of approved) {
      approvedJobs.add(a.key);
      const rec = records.get(a.key);
      if (rec && rec.stage === 'awaiting_approval' && !rec.final) {
        counters.awaitingApproval--;
        P(rec.portal).awaiting--;
        rec.stage = 'approved';
        const p = submit(rec).catch((err) => finalize(rec, 'failed', { reason: err.message }));
        inFlight.add(p);
        p.finally(() => inFlight.delete(p));
      } else if (!rec && !carried.has(a.key) && adapters[a.portal]) {
        carried.add(a.key);
        const c = { key: a.key, portal: a.portal, site: a.site || a.portal, job: { ...a, title: a.title, company: a.company, url: a.url, location: a.location, ...(a.detailUrl ? { detailUrl: a.detailUrl } : {}) }, resume: a.resume, approvalId: a.id, applyContext: a.applyContext || null, verdict: { evidence: a.evidence }, fullText: '', cardText: '' };
        const p = submit(c, { carry: true }).catch((err) => carryOver.push(entryOf(c, { outcome: 'failed', reason: err.message })));
        inFlight.add(p);
        p.finally(() => inFlight.delete(p));
      }
    }
  }
  const carried = new Set();

  function startPolling(intervalMs = 10_000) {
    pollApprovals();
    pollTimer = setInterval(pollApprovals, intervalMs);
    pollTimer.unref?.();
  }

  /** Wait until every offered job has a final state (approval itself is not waited for). */
  async function drain() {
    while (inFlight.size) await Promise.allSettled([...inFlight]);
    enricher?.flush?.();
  }

  /** Stop polling; jobs still waiting for approval get their final bucket for the report. */
  function close() {
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    for (const rec of records.values()) {
      if (rec.final) continue;
      if (rec.stage === 'awaiting_approval') finalize(rec, 'awaitingApproval', { reason: `prepared — approve with: npm run approve -- ${rec.approvalId || '<id>'}` });
      else finalize(rec, 'failed', { reason: `pipeline stopped in stage ${rec.stage}` });
    }
  }

  function resultsFor(portal) {
    return bucketsOf(portal);
  }

  function snapshot() {
    const stages = {};
    for (const r of records.values()) if (!r.final) stages[r.stage] = (stages[r.stage] || 0) + 1;
    return { counters: { ...counters }, stages, perPortal: JSON.parse(JSON.stringify(perPortal)), inFlight: inFlight.size };
  }

  function metricsSummary(wallMs) {
    return {
      stages: Object.fromEntries(Object.entries(metrics).map(([k, m]) => [k, summarizeStage(m, wallMs)])),
      counters: { ...counters },
      perPortal: JSON.parse(JSON.stringify(perPortal)),
      enricher: enricher?.stats ? { ...enricher.stats, blockedHosts: Object.fromEntries(enricher.blockedHosts || []) } : null,
      approvalWaitMs: [...records.values()].filter((r) => r.preparedAt).map((r) => now() - r.preparedAt),
    };
  }

  return { offer, drain, close, startPolling, pollApprovals, resultsFor, results: out, carryOver, snapshot, metricsSummary, approvedJobs, records };
}

/** Merge pipeline buckets into the portal results the bots returned. */
function mergePipelineResults(results, pipeline) {
  if (!pipeline) return results;
  for (const [portal, buckets] of Object.entries(pipeline.results)) {
    const r = results[portal];
    if (!r) continue;
    for (const [b, list] of Object.entries(buckets)) r[b] = [...(r[b] || []), ...list];
  }
  return results;
}

module.exports = { createPipeline, mergePipelineResults, summarizeStage, BUCKET_FOR, CHANNEL };
