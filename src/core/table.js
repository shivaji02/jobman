/** Tiny box-drawing table renderer for the terminal feed. Pure — see tests/table.test.js. */

function clip(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * headers: string[]; rows: string[][]; widths: optional max width per column
 * (defaults to 40). Returns a multi-line string.
 */
function renderTable(headers, rows, widths = []) {
  const max = headers.map((_, i) => widths[i] || 40);
  const cells = rows.map((r) => r.map((c, i) => clip(c, max[i])));
  const cols = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => (r[i] || '').length)));
  const line = (l, m, r) => l + cols.map((w) => '─'.repeat(w + 2)).join(m) + r;
  const row = (r) => '│' + cols.map((w, i) => ` ${(r[i] || '').padEnd(w)} `).join('│') + '│';
  return [line('┌', '┬', '┐'), row(headers), line('├', '┼', '┤'), ...cells.map(row), line('└', '┴', '┘')].join('\n');
}

module.exports = { renderTable, clip };
