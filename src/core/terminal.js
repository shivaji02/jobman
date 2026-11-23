/**
 * Single-screen terminal renderer (plain ANSI, no dependencies).
 *
 * Why the old dashboard filled the terminal: it redrew with `ESC[H ESC[2J` + the
 * whole frame on the normal screen every second. Clearing the normal buffer
 * pushes each frame into the scrollback, so every tick left another full copy
 * behind, and the full redraw flickered.
 *
 * This renderer:
 *   - enters the alternate screen buffer once (no scrollback is produced) and
 *     restores the original screen on exit;
 *   - positions the cursor per row and rewrites only rows whose text changed
 *     (no whole-screen clear per frame, so no flicker);
 *   - fits every row to the current width and the frame to the current height,
 *     and does a full repaint only when the terminal is resized;
 *   - never paints re-entrantly: a request that arrives during a paint is
 *     coalesced into the next one.
 *
 * Non-interactive streams (pipes, cron, CI) get `interactive: false` and the
 * caller prints compact lines instead.
 */

const ESC = '\x1b[';
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

const stripAnsi = (s) => String(s).replace(ANSI_RE, '');

/** Visible width (code points; wide glyphs are approximated as one cell). */
function visibleWidth(s) {
  return Array.from(stripAnsi(s)).length;
}

/** Truncate to `cols` visible cells while keeping ANSI styling intact. */
function fitWidth(s, cols) {
  const str = String(s);
  if (cols <= 0) return '';
  if (visibleWidth(str) <= cols) return str;
  let out = '';
  let vis = 0;
  let i = 0;
  const re = /\x1b\[[0-9;?]*[A-Za-z]/y;
  while (i < str.length && vis < cols) {
    re.lastIndex = i;
    const m = re.exec(str);
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    out += ch;
    vis++;
    i += ch.length;
  }
  return out + `${ESC}0m`;
}

/**
 * Create a screen bound to a writable stream.
 *   stream       anything with write(), isTTY, columns, rows, on()/removeListener()
 *   interactive  defaults to stream.isTTY (and JOBMAN_NO_DASHBOARD !== 'true')
 */
function createScreen({ stream = process.stdout, interactive } = {}) {
  const isInteractive = interactive ?? (!!stream.isTTY && process.env.JOBMAN_NO_DASHBOARD !== 'true');
  let entered = false;
  let prev = [];
  let lastSize = { cols: 0, rows: 0 };
  let painting = false;
  let pending = null;
  let onResize = null;
  let exitHook = null;

  const size = () => ({
    cols: Math.max(20, stream.columns || 120),
    rows: Math.max(8, stream.rows || 40),
  });

  /** Rows available for content (panel + log) at the current height. */
  function rowsAvailable() {
    return size().rows;
  }

  function write(text) {
    if (text) stream.write(text);
  }

  function enter(resizeHandler) {
    if (!isInteractive || entered) return;
    entered = true;
    write(`${ESC}?1049h${ESC}?25l${ESC}2J${ESC}H`); // alternate screen, hide cursor, clear once
    prev = [];
    lastSize = { cols: 0, rows: 0 };
    onResize = resizeHandler || null;
    if (typeof stream.on === 'function' && onResize) stream.on('resize', handleResize);
    exitHook = () => leave();
    process.once('exit', exitHook);
  }

  function leave() {
    if (!entered) return;
    entered = false;
    if (typeof stream.removeListener === 'function') stream.removeListener('resize', handleResize);
    onResize = null;
    if (exitHook) process.removeListener('exit', exitHook);
    exitHook = null;
    write(`${ESC}0m${ESC}?25h${ESC}?1049l`); // reset styles, show cursor, back to the original screen
  }

  function handleResize() {
    prev = []; // force a full repaint at the new size
    if (onResize) onResize();
  }

  /**
   * Paint the given rows. Rows beyond the terminal height are dropped; rows that
   * did not change since the last paint are not rewritten.
   */
  function paint(lines) {
    if (!entered) return false;
    if (painting) {
      pending = lines; // a paint is already in progress: keep only the latest frame
      return false;
    }
    painting = true;
    try {
      let next = lines;
      do {
        pending = null;
        draw(next);
        next = pending;
      } while (next);
    } finally {
      painting = false;
    }
    return true;
  }

  function draw(lines) {
    const { cols, rows } = size();
    const fitted = lines.slice(0, rows).map((l) => fitWidth(l, cols));
    let out = '';
    if (cols !== lastSize.cols || rows !== lastSize.rows) {
      out += `${ESC}2J`; // terminal size changed: clear and repaint everything
      prev = [];
      lastSize = { cols, rows };
    }
    const n = Math.max(fitted.length, prev.length, 0);
    for (let i = 0; i < n && i < rows; i++) {
      const line = fitted[i] ?? '';
      if (prev[i] === line) continue;
      out += `${ESC}${i + 1};1H${line}${ESC}0m${ESC}K`; // move, write, erase the rest of the row
    }
    prev = fitted;
    write(out);
  }

  return {
    interactive: isInteractive,
    isEntered: () => entered,
    size,
    rowsAvailable,
    enter,
    leave,
    paint,
    invalidate: () => { prev = []; },
  };
}

module.exports = { createScreen, fitWidth, visibleWidth, stripAnsi };
