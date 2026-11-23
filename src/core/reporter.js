/**
 * Daily report writer — reports/YYYY-MM-DD.md
 *
 * results shape (see core/disposition.js emptyResults):
 *   { [portal]: { discovered, duplicates, outOfScope, reviewed,
 *                 applied, unconfirmed, alreadyApplied, manualApply, skipped, failed, note? } }
 * Each job entry: { title, company, url, reason?, companyUrl?, resume?, evidence? }
 *
 * Every reviewed listing appears under exactly one disposition, and the funnel
 * is reconciled (discovered → duplicates → out-of-scope → reviewed → Σ dispositions).
 */
const fs = require('fs');
const path = require('path');
const { DISPOSITIONS, BUCKETS, classify, reconcileAll, blockersFrom } = require('./disposition');

const REPORTS_DIR = path.join(__dirname, '..', '..', 'reports');
/** Long rejection lists are summarized by reason; listing thousands of lines helps nobody. */
const MAX_LISTED_PER_DISPOSITION = 40;
const REJECTION_KEYS = new Set(['rejected_location', 'rejected_experience', 'rejected_role', 'rejected_stale', 'already_applied']);

function jobLine(j) {
  const bits = [`**${j.title || 'Unknown title'}**`, j.company || 'Unknown company'];
  let line = `- ${bits.join(' — ')}`;
  if (j.url) line += ` — ${j.url}`;
  if (j.companyUrl && j.companyUrl !== j.url) line += ` · ATS: ${j.companyUrl}`;
  if (j.resume) line += ` · Resume: ${j.resume}`;
  if (j.reason) line += ` _(${j.reason})_`;
  if (j.evidence) {
    line += ` · ✔ ${j.evidence.signal}`;
    if (j.evidence.screenshot) line += ` · [screenshot](${path.relative(REPORTS_DIR, j.evidence.screenshot)})`;
  }
  return line;
}

/** Reason text with numbers collapsed, for grouping ("score 29" → "score N"). */
function reasonGroup(reason = '') {
  return String(reason || 'no reason').replace(/-?\d+(\.\d+)?/g, 'N').replace(/\(.*?\)/g, '(…)').slice(0, 70);
}

/** Group a portal's entries by disposition. */
function byDisposition(r, opts) {
  const groups = Object.fromEntries(DISPOSITIONS.map((d) => [d.key, []]));
  for (const bucket of BUCKETS) {
    for (const e of r[bucket] || []) groups[classify(bucket, e, opts)].push(e);
  }
  return groups;
}

function funnelTable(rows) {
  const head = '| Portal | Discovered | Duplicate sightings | Out of scope | **Reviewed (unique)** | ' +
    DISPOSITIONS.map((d) => d.key).join(' | ') + ' | Unaccounted |';
  const sep = '|' + '---|'.repeat(6 + DISPOSITIONS.length);
  const body = rows.map(([name, rec]) =>
    `| ${name} | ${rec.discovered} | ${rec.duplicates} | ${rec.outOfScope} | **${rec.reviewed}** | ` +
      DISPOSITIONS.map((d) => rec.counts[d.key]).join(' | ') + ` | ${rec.unaccounted} |`
  );
  return [head, sep, ...body];
}

/**
 * Google discovery and direct-employer (ATS) applications, reported apart from
 * the job portals: discovery stats, then every direct application with its
 * source, official URL, ATS, resume, time, disposition and evidence/reason.
 */
/** Per-ATS funnel of the direct channels: eligible → attempts → confirmed, hand-offs and their blockers. */
function perAtsTable(results, channels, opts) {
  const stats = {};
  const row = (ats) => (stats[ats] = stats[ats] || { eligible: 0, attempts: 0, confirmed: 0, unconfirmed: 0, handoffs: 0, failed: 0, blocked: 0, rejected: 0, blockers: {} });
  for (const p of channels) {
    const g = byDisposition(results[p], opts);
    for (const [key, list] of Object.entries(g)) {
      for (const j of list) {
        const s = row(j.ats || 'unknown');
        if (['applied_confirmed', 'would_apply', 'applied_unconfirmed', 'manual_required', 'failed_technical', 'blocked_by_site'].includes(key)) s.eligible++;
        if (key === 'applied_confirmed') (s.confirmed++, s.attempts++);
        if (key === 'would_apply') s.attempts++;
        if (key === 'applied_unconfirmed') (s.unconfirmed++, s.attempts++);
        if (key === 'manual_required') {
          s.handoffs++;
          for (const b of blockersFrom(j.reason)) s.blockers[b] = (s.blockers[b] || 0) + 1;
        }
        if (key === 'failed_technical') s.failed++;
        if (key === 'blocked_by_site') s.blocked++;
        if (key.startsWith('rejected_')) s.rejected++;
      }
    }
  }
  const names = Object.keys(stats).sort();
  if (!names.length) return [];
  const out = [
    '### By ATS',
    '',
    `| ATS | Eligible | ${opts.dryRun ? 'Would submit' : 'Submit attempts'} | Confirmed (evidence) | Unconfirmed | Hand-offs | Failed | Rejected | Why handed off |`,
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const n of names) {
    const s = stats[n];
    const why = Object.entries(s.blockers).sort((a, b) => b[1] - a[1]).map(([b, c]) => `${b} ×${c}`).join(', ');
    const failedCell = `${s.failed}${s.blocked ? ` (+${s.blocked} blocked by site, retried later)` : ''}`;
    out.push(`| ${n} | ${s.eligible} | ${s.attempts} | ${s.confirmed} | ${s.unconfirmed} | ${s.handoffs} | ${failedCell} | ${s.rejected} | ${why || '-'} |`);
  }
  out.push('', '_Eligible = passed location, experience, role and freshness checks on the live posting. Confirmed = the ATS showed its own success message (screenshot kept)._', '');
  return out;
}

function directSection(results, opts) {
  const channels = ['google', 'careers'].filter((p) => results[p]);
  if (!channels.length) return [];
  const out = ['## Direct employer channel (Google discovery + company career sites)', ''];
  const g = results.google && results.google.discovery;
  if (g) {
    out.push(
      `**Google discovery** (${g.provider}): ${g.queries} searches → ${g.results} results` +
        (g.leadsReused ? ` + ${g.leadsReused} saved leads re-checked` : '') +
        ` · ${g.postings} open employer postings verified on the ATS · ${g.closed} closed/unverifiable · ` +
        `${g.boardsAdded} new company boards added to the directory · ${g.pages} custom career pages resolved · ` +
        `${g.aggregators} aggregator results and ${g.irrelevant} irrelevant results dropped` +
        (g.leadsDropped ? ` · ${g.leadsDropped} saved leads dropped (posting closed)` : '') +
        (g.blocked ? `\n\n> ⚠ ${g.blocked}` : ''),
      ''
    );
  }
  out.push(...perAtsTable(results, channels, opts));
  const d = results.careers && results.careers.directory;
  if (d) out.push(`**Company directory growth** (public ATS APIs, no Google): ${d.probedCompanies} companies probed in ${d.requests} requests → ${d.added} new boards.`, '');
  const rows = [];
  for (const p of channels) {
    const groups = byDisposition(results[p], opts);
    for (const key of ['applied_confirmed', 'would_apply', 'applied_unconfirmed', 'manual_required', 'failed_technical', 'blocked_by_site']) {
      for (const j of groups[key]) rows.push({ p, key, ...j });
    }
  }
  if (!rows.length) {
    out.push('_No direct applications attempted._', '');
    return out;
  }
  out.push(
    '| Channel | Company | Role | ATS | Discovered via | Resume | Disposition | Evidence / reason |',
    '|---|---|---|---|---|---|---|---|'
  );
  const cell = (v) => String(v || '').replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 160);
  for (const r of rows) {
    const proof = r.evidence ? `${r.evidence.signal} @ ${r.evidence.at}${r.evidence.screenshot ? ` (${path.basename(r.evidence.screenshot)})` : ''}` : r.reason;
    out.push(`| ${r.p} | ${cell(r.company)} | [${cell(r.title)}](${r.companyUrl || r.url}) | ${r.ats || ''} | ${cell(r.source)} | ${path.basename(r.resume || '')} | ${r.key} | ${cell(proof)} |`);
  }
  out.push('');
  return out;
}

function write(date, results, { dryRun = false, suffix = '' } = {}) {
  const opts = { dryRun };
  const portals = Object.keys(results);
  const { total, perPortal } = reconcileAll(results, opts);
  const c = total.counts;
  const confirmed = dryRun ? c.would_apply : c.applied_confirmed;

  const lines = [
    `# Job Application Report — ${date}${dryRun ? ' (DRY RUN)' : ''}`,
    '',
    '## Outcome',
    '',
    dryRun
      ? `- **Would apply:** ${c.would_apply}`
      : `- **Confirmed applications (with evidence):** ${c.applied_confirmed}`,
    `- **Submitted but unconfirmed (blocked from resubmission):** ${c.applied_unconfirmed}`,
    `- **Prepared — awaiting your approval:** ${c.awaiting_approval}${c.awaiting_approval ? ' → `npm run review` (or `npm run approvals`)' : ''}`,
    `- **Needs you:** ${c.manual_required}`,
    ...(c.needs_enrichment ? [`- **Insufficient evidence (re-checked next run, not rejected):** ${c.needs_enrichment}`] : []),
    `- **Technical failures:** ${c.failed_technical}`,
    ...(c.blocked_by_site ? [`- **Blocked by the site (rate-limited / circuit open; retried next run, not a code fault):** ${c.blocked_by_site}`] : []),
    '',
    '## Funnel (reconciled)',
    '',
    `Discovered ${total.discovered} → −${total.duplicates} duplicate sightings → −${total.outOfScope} out of discovery scope → ` +
      `**${total.reviewed} unique listings reviewed** = ${total.accounted} with a final disposition` +
      (total.unaccounted || total.discoveryGap
        ? ` ⚠ **${total.unaccounted} unaccounted, ${total.discoveryGap} discovery gap**`
        : ' ✅ (0 unaccounted)'),
    '',
    '| Final disposition | Count |',
    '|---|---|',
    ...DISPOSITIONS.map((d) => `| ${d.label} | ${c[d.key]} |`),
    `| **Total** | **${total.accounted}** |`,
    '',
    '### Per portal',
    '',
    ...funnelTable([...portals.map((p) => [p, perPortal[p]]), ['**TOTAL**', total]]),
    '',
    ...directSection(results, opts),
    '## Per-portal detail',
    '',
  ];

  for (const p of portals) {
    const r = results[p];
    const rec = perPortal[p];
    lines.push(`### ${p}`, '');
    if (r.note) lines.push(`> ${r.note}`, '');
    lines.push(
      `Discovered ${rec.discovered} · duplicates ${rec.duplicates} · out of scope ${rec.outOfScope} · reviewed ${rec.reviewed}` +
        (rec.unaccounted ? ` · ⚠ unaccounted ${rec.unaccounted}` : ''),
      ''
    );
    const groups = byDisposition(r, opts);
    for (const d of DISPOSITIONS) {
      const list = groups[d.key];
      if (!list.length) continue;
      lines.push(`#### ${d.label} (${list.length})`, '');
      if (REJECTION_KEYS.has(d.key) && list.length > 10) {
        const counts = {};
        for (const e of list) counts[reasonGroup(e.reason)] = (counts[reasonGroup(e.reason)] || 0) + 1;
        for (const [reason, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) lines.push(`- ${n} × ${reason}`);
        lines.push('');
        continue;
      }
      lines.push(...list.slice(0, MAX_LISTED_PER_DISPOSITION).map(jobLine));
      if (list.length > MAX_LISTED_PER_DISPOSITION) lines.push(`- … ${list.length - MAX_LISTED_PER_DISPOSITION} more`);
      lines.push('');
    }
  }

  const followups = require('./followups').createFollowupStore().list();
  if (followups.length) {
    lines.push('## Unresolved manual follow-ups', '',
      `${followups.length} carried-forward item(s) need a fresh posting and eligibility check. They are not approvals and will not be submitted automatically. Run \`npm run followups\` to review them.`, '');
  }

  // End summary — kept for continuity with older reports.
  lines.push('## Summary', '');
  lines.push(`- **Applied:** ${confirmed}`);
  lines.push(`- **Unconfirmed:** ${c.applied_unconfirmed}`);
  lines.push(`- **Manual Apply:** ${c.manual_required}`);
  lines.push(`- **Failed:** ${c.failed_technical}`);
  lines.push('');
  const manual = portals.flatMap((p) => byDisposition(results[p], opts).manual_required.map((j) => ({ p, ...j })));
  if (manual.length) {
    lines.push('### Manual Apply list', '');
    for (const j of manual) {
      lines.push(
        `- [${j.p}] **${j.title || 'Unknown'}** @ ${j.company || 'Unknown'} | URL: ${j.companyUrl || j.url || ''}` +
          `${j.reason ? ` | Why: ${j.reason}` : ''}${j.resume ? ` | Resume: ${j.resume}` : ''}`
      );
    }
    lines.push('');
  }

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const file = path.join(REPORTS_DIR, `${date}${dryRun ? '-dry-run' : ''}${suffix ? `-${suffix}` : ''}.md`);
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

function read(date) {
  const file = path.join(REPORTS_DIR, `${date}.md`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

module.exports = { write, read, REPORTS_DIR, byDisposition };
