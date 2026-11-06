/**
 * End-of-run terminal summary: per-portal counts, then separate tables for
 * applied, open-for-you (manual apply), failed, and skipped-by-reason.
 */
const { renderTable, clip } = require('./table');
const { reconcileAll } = require('./disposition');

function skipBucket(reason = '') {
  const r = reason.toLowerCase();
  if (/mumbai/.test(r)) return 'Mumbai excluded';
  if (/pune only/.test(r)) return 'Pune (not a listed company)';
  if (/outside south|remote-only/.test(r)) return 'Outside South India';
  if (/experience/.test(r)) return 'Experience out of range';
  if (/score|threshold/.test(r)) return 'Not a matching role';
  if (/already applied|already (logged|manual|unconfirmed)|same role already/.test(r)) return 'Already applied';
  return clip(reason || 'Other', 40);
}

function formatRunSummary(results, { dryRun = false } = {}) {
  const out = [];
  const portals = Object.entries(results || {});
  const verb = dryRun ? 'Would apply' : 'Applied';
  const title = (t) => `\n${t}`;
  const { total, perPortal } = reconcileAll(results || {}, { dryRun });

  const row = (name, rec) => [
    name,
    rec.discovered,
    rec.reviewed,
    dryRun ? rec.counts.would_apply : rec.counts.applied_confirmed,
    rec.counts.applied_unconfirmed,
    rec.counts.already_applied,
    rec.counts.manual_required,
    rec.counts.failed_technical,
    rec.counts.rejected_location + rec.counts.rejected_experience + rec.counts.rejected_role + rec.counts.rejected_stale + rec.counts.deferred_cap,
    rec.unaccounted,
  ];
  const rows = portals.map(([name, r]) => row(name + (r.note ? ' ⚠' : ''), perPortal[name]));
  rows.push(row('TOTAL', total));

  out.push(title('═══ RUN SUMMARY ' + (dryRun ? '(DRY RUN) ' : '') + '═══'));
  out.push(
    renderTable(
      ['Portal', 'Discovered', 'Unique', dryRun ? 'Would apply' : 'Confirmed', 'Unconfirmed', 'Already', 'Needs you', 'Failed', 'Rejected', 'Gap'],
      rows
    )
  );
  out.push(
    `  funnel: ${total.discovered} discovered − ${total.duplicates} duplicate sightings − ${total.outOfScope} out of scope = ` +
      `${total.reviewed} unique = ${total.accounted} dispositioned` + (total.unaccounted ? ` ⚠ ${total.unaccounted} UNACCOUNTED` : ' ✓')
  );
  const notes = portals.filter(([, r]) => r.note).map(([n, r]) => `  ⚠ ${n}: ${r.note}`);
  if (notes.length) out.push(notes.join('\n'));

  const flat = (key) => portals.flatMap(([portal, r]) => (r[key] || []).map((j) => ({ portal, ...j })));

  const applied = flat('applied');
  out.push(title(`✅ ${verb.toUpperCase()} (${applied.length})`));
  out.push(applied.length ? renderTable(['#', 'Portal', 'Role', 'Company', 'Evidence'], applied.map((j, i) => [i + 1, j.portal, j.title, j.company, j.evidence ? j.evidence.signal : dryRun ? '-' : 'NONE']), [4, 10, 40, 26, 40]) : '  (none)');

  const manual = flat('manualApply');
  out.push(title(`🔗 OPEN FOR YOU — finish manually (${manual.length}; tabs left open)`));
  out.push(manual.length ? renderTable(['#', 'Portal', 'Role', 'Company', 'Open this URL'], manual.map((j, i) => [i + 1, j.portal, j.title, j.company, j.companyUrl || j.url]), [4, 10, 38, 24, 300]) : '  (none)');

  const unconfirmed = [...flat('unconfirmed'), ...flat('failed').filter((j) => /not confirmed|no .*confirmation/i.test(j.reason || ''))];
  if (unconfirmed.length) {
    out.push(title(`❓ SUBMITTED, NOT CONFIRMED — check portal, never auto-resubmitted (${unconfirmed.length})`));
    out.push(renderTable(['#', 'Portal', 'Role', 'Company', 'URL'], unconfirmed.map((j, i) => [i + 1, j.portal, j.title, j.company, j.url]), [4, 10, 34, 22, 80]));
  }

  const failed = flat('failed').filter((j) => !/not confirmed|no .*confirmation/i.test(j.reason || ''));
  out.push(title(`❌ FAILED — inspect tab (${failed.length})`));
  out.push(failed.length ? renderTable(['#', 'Portal', 'Role', 'Company', 'Why'], failed.map((j, i) => [i + 1, j.portal, j.title, j.company, j.reason]), [4, 10, 34, 22, 60]) : '  (none)');

  const buckets = {};
  for (const j of flat('skipped')) {
    const b = skipBucket(j.reason);
    buckets[b] = (buckets[b] || 0) + 1;
  }
  const brows = Object.entries(buckets).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]);
  out.push(title('⏭  SKIPPED (why)'));
  out.push(brows.length ? renderTable(['Reason', 'Count'], brows, [44, 6]) : '  (none)');

  const open = manual.length + failed.length;
  out.push(`\nℹ  ${open} tab(s) left open. Close each when done; Ctrl+C to shut the browser.\n`);
  return out.join('\n');
}

module.exports = { formatRunSummary, skipBucket };
