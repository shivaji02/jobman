/**
 * Daily report writer — reports/YYYY-MM-DD.md
 *
 * results shape: { [portal]: { reviewed, applied: [...], manualApply?: [...], skipped: [...], failed: [...], note? } }
 * Each job entry: { title, company, url, reason?, companyUrl?, resume? }
 */
const fs = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, '..', '..', 'reports');

function jobLine(j) {
  const bits = [`**${j.title || 'Unknown title'}**`, j.company || 'Unknown company'];
  let line = `- ${bits.join(' — ')}`;
  if (j.url) line += ` — ${j.url}`;
  if (j.companyUrl && j.companyUrl !== j.url) line += ` · ATS: ${j.companyUrl}`;
  if (j.resume) line += ` · Resume: ${j.resume}`;
  if (j.reason) line += ` _(${j.reason})_`;
  return line;
}

function write(date, results, { dryRun = false } = {}) {
  const portals = Object.keys(results);
  const totals = { reviewed: 0, applied: 0, manualApply: 0, skipped: 0, failed: 0 };
  for (const p of portals) {
    const r = results[p];
    totals.reviewed += r.reviewed || 0;
    totals.applied += (r.applied || []).length;
    totals.manualApply += (r.manualApply || []).length;
    totals.skipped += (r.skipped || []).length;
    totals.failed += (r.failed || []).length;
  }

  const verb = dryRun ? 'Would apply (dry run)' : 'Applied';
  const lines = [
    `# Job Application Report — ${date}${dryRun ? ' (DRY RUN)' : ''}`,
    '',
    '## Totals',
    '',
    `| Reviewed | ${verb} | Manual Apply | Skipped | Failed |`,
    '|---|---|---|---|---|',
    `| ${totals.reviewed} | ${totals.applied} | ${totals.manualApply} | ${totals.skipped} | ${totals.failed} |`,
    '',
    '## Per-portal breakdown',
    '',
  ];

  for (const p of portals) {
    const r = results[p];
    lines.push(`### ${p}`);
    lines.push('');
    if (r.note) lines.push(`> ${r.note}`, '');
    lines.push(
      `Reviewed: ${r.reviewed || 0} · ${verb}: ${(r.applied || []).length} · ` +
        `Manual Apply: ${(r.manualApply || []).length} · ` +
        `Skipped: ${(r.skipped || []).length} · Failed: ${(r.failed || []).length}`,
      ''
    );
    if ((r.applied || []).length) {
      lines.push(`#### ${verb}`, '', ...r.applied.map(jobLine), '');
    }
    if ((r.manualApply || []).length) {
      lines.push('#### Manual Apply', '', ...r.manualApply.map(jobLine), '');
    }
    if ((r.skipped || []).length) {
      lines.push('#### Skipped', '', ...r.skipped.map(jobLine), '');
    }
    if ((r.failed || []).length) {
      lines.push('#### Failed', '', ...r.failed.map(jobLine), '');
    }
  }

  // End summary — Applied count, Manual Apply list, Failed count
  lines.push('## Summary', '');
  lines.push(`- **Applied:** ${totals.applied}`);
  lines.push(`- **Manual Apply:** ${totals.manualApply}`);
  lines.push(`- **Failed:** ${totals.failed}`);
  lines.push('');
  if (totals.manualApply) {
    lines.push('### Manual Apply list', '');
    for (const p of portals) {
      for (const j of results[p].manualApply || []) {
        const url = j.companyUrl || j.url || '';
        const resume = j.resume || '';
        lines.push(
          `- **${j.title || 'Unknown'}** @ ${j.company || 'Unknown'} | URL: ${url} | Resume: ${resume}`
        );
      }
    }
    lines.push('');
  }

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const file = path.join(REPORTS_DIR, `${date}${dryRun ? '-dry-run' : ''}.md`);
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

function read(date) {
  const file = path.join(REPORTS_DIR, `${date}.md`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

module.exports = { write, read, REPORTS_DIR };
