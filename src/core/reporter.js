/**
 * Daily report writer — reports/YYYY-MM-DD.md
 *
 * results shape: { [portal]: { reviewed, applied: [...], skipped: [...], failed: [...], note? } }
 * Each job entry: { title, company, url, reason? }
 */
const fs = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, '..', '..', 'reports');

function jobLine(j) {
  const bits = [`**${j.title || 'Unknown title'}**`, j.company || 'Unknown company'];
  let line = `- ${bits.join(' — ')}`;
  if (j.url) line += ` — ${j.url}`;
  if (j.reason) line += ` _(${j.reason})_`;
  return line;
}

function write(date, results, { dryRun = false } = {}) {
  const portals = Object.keys(results);
  const totals = { reviewed: 0, applied: 0, skipped: 0, failed: 0 };
  for (const p of portals) {
    const r = results[p];
    totals.reviewed += r.reviewed || 0;
    totals.applied += (r.applied || []).length;
    totals.skipped += (r.skipped || []).length;
    totals.failed += (r.failed || []).length;
  }

  const verb = dryRun ? 'Would apply (dry run)' : 'Applied';
  const lines = [
    `# Job Application Report — ${date}${dryRun ? ' (DRY RUN)' : ''}`,
    '',
    '## Totals',
    '',
    `| Reviewed | ${verb} | Skipped | Failed |`,
    '|---|---|---|---|',
    `| ${totals.reviewed} | ${totals.applied} | ${totals.skipped} | ${totals.failed} |`,
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
        `Skipped: ${(r.skipped || []).length} · Failed: ${(r.failed || []).length}`,
      ''
    );
    if ((r.applied || []).length) {
      lines.push(`#### ${verb}`, '', ...r.applied.map(jobLine), '');
    }
    if ((r.skipped || []).length) {
      lines.push('#### Skipped', '', ...r.skipped.map(jobLine), '');
    }
    if ((r.failed || []).length) {
      lines.push('#### Failed', '', ...r.failed.map(jobLine), '');
    }
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
