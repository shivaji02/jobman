/**
 * Regression tests for the repeated-dashboard bug: every tick used to clear the
 * normal screen and print the full frame again, so the terminal filled with
 * copies. These tests drive the renderer and the dashboard against a fake
 * TTY stream and check what would reach the terminal.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createScreen, fitWidth, visibleWidth, stripAnsi } = require('../src/core/terminal');
const { createDashboard } = require('../src/core/dashboard');

function fakeStream({ isTTY = true, columns = 100, rows = 30 } = {}) {
  const out = [];
  const listeners = {};
  return {
    isTTY,
    columns,
    rows,
    out,
    write(s) { out.push(String(s)); return true; },
    on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
    removeListener(evt, fn) { listeners[evt] = (listeners[evt] || []).filter((f) => f !== fn); },
    emit(evt) { (listeners[evt] || []).forEach((f) => f()); },
    listenerCount(evt) { return (listeners[evt] || []).length; },
    get text() { return out.join(''); },
    reset() { out.length = 0; },
  };
}

const count = (text, needle) => text.split(needle).length - 1;

test('non-interactive streams are not treated as a dashboard terminal', () => {
  const s = fakeStream({ isTTY: false });
  const screen = createScreen({ stream: s });
  assert.equal(screen.interactive, false);
  screen.enter();
  assert.equal(screen.paint(['a', 'b']), false);
  assert.equal(s.text, '', 'a non-TTY must receive no escape sequences');
});

test('JOBMAN_NO_DASHBOARD=true forces the non-interactive path', () => {
  const prev = process.env.JOBMAN_NO_DASHBOARD;
  process.env.JOBMAN_NO_DASHBOARD = 'true';
  try {
    assert.equal(createScreen({ stream: fakeStream({ isTTY: true }) }).interactive, false);
  } finally {
    if (prev === undefined) delete process.env.JOBMAN_NO_DASHBOARD;
    else process.env.JOBMAN_NO_DASHBOARD = prev;
  }
});

test('enter uses the alternate screen once and leave restores the original screen', () => {
  const s = fakeStream();
  const screen = createScreen({ stream: s });
  screen.enter();
  screen.enter(); // second enter is a no-op
  assert.equal(count(s.text, '\x1b[?1049h'), 1);
  screen.leave();
  screen.leave(); // idempotent
  assert.equal(count(s.text, '\x1b[?1049l'), 1);
  assert.ok(s.text.includes('\x1b[?25h'), 'cursor must be shown again');
  assert.equal(s.listenerCount('resize'), 0, 'resize listener removed on leave');
});

test('repeated identical frames write nothing (no per-tick redraw)', () => {
  const s = fakeStream();
  const screen = createScreen({ stream: s });
  screen.enter();
  screen.paint(['line one', 'line two']);
  s.reset();
  for (let i = 0; i < 20; i++) screen.paint(['line one', 'line two']);
  assert.equal(s.text, '');
});

test('only changed rows are rewritten, and the full screen is never cleared per frame', () => {
  const s = fakeStream();
  const screen = createScreen({ stream: s });
  screen.enter();
  screen.paint(['header', 'counts 1', 'footer']);
  s.reset();
  screen.paint(['header', 'counts 2', 'footer']);
  assert.ok(s.text.includes('\x1b[2;1H'), 'row 2 is repositioned and rewritten');
  assert.ok(!s.text.includes('\x1b[1;1H'), 'unchanged row 1 is not rewritten');
  assert.ok(!s.text.includes('\x1b[2J'), 'steady-state frames never clear the screen');
});

test('a terminal resize triggers one full repaint at the new size', () => {
  const s = fakeStream({ columns: 100, rows: 30 });
  let resized = 0;
  const screen = createScreen({ stream: s });
  screen.enter(() => { resized++; });
  screen.paint(['a', 'b']);
  s.reset();
  s.columns = 60;
  s.emit('resize');
  assert.equal(resized, 1, 'resize handler is invoked');
  screen.paint(['a', 'b']);
  assert.ok(s.text.includes('\x1b[2J'), 'size change clears once');
  assert.ok(s.text.includes('\x1b[1;1Ha'), 'every row is repainted after resize');
});

test('lines are truncated to the terminal width and extra rows are dropped', () => {
  const s = fakeStream({ columns: 40, rows: 8 });
  const screen = createScreen({ stream: s });
  screen.enter();
  const long = 'x'.repeat(200);
  const lines = Array.from({ length: 30 }, (_, i) => (i === 0 ? long : `row ${i}`));
  screen.paint(lines);
  assert.ok(!s.text.includes(`\x1b[9;1H`), 'nothing is written below the last row');
  assert.ok(s.text.includes('x'.repeat(40)), 'first row keeps 40 visible cells');
  assert.ok(!s.text.includes('x'.repeat(41)), 'first row never exceeds 40 cells');
});

test('fitWidth keeps ANSI styling and counts only visible cells', () => {
  const styled = '\x1b[32m' + 'a'.repeat(10) + '\x1b[0m';
  assert.equal(visibleWidth(styled), 10);
  assert.equal(visibleWidth(fitWidth(styled, 4)), 4);
  assert.equal(stripAnsi(fitWidth(styled, 4)), 'aaaa');
  assert.equal(fitWidth('short', 80), 'short');
});

test('a paint requested during a paint is coalesced into one follow-up frame', () => {
  const s = fakeStream();
  const screen = createScreen({ stream: s });
  screen.enter();
  let nested = false;
  const origWrite = s.write.bind(s);
  s.write = (text) => {
    origWrite(text);
    if (!nested) {
      nested = true;
      screen.paint(['final frame']); // re-entrant request while drawing
    }
    return true;
  };
  screen.paint(['first frame']);
  assert.ok(s.text.includes('final frame'), 'latest re-entrant frame is painted');
});

test('dashboard: one session, many ticks, no repeated screens, one final summary', async () => {
  const s = fakeStream({ columns: 120, rows: 40 });
  const store = {
    stats: { seen: 0, confirmed: 0, eligible: 0, screened: 0, alreadyApplied: 0, needsUser: 0, failed: 0, claimConflicts: 0, perPortal: {} },
    applySlots: { active: 0, limit: 2, waiting: 0 },
    shuttingDown: false,
    appsPerMinute: () => 0,
  };
  const scheduler = {
    limits: () => ({ discovery: 2, apply: 2 }),
    activePortals: () => 1,
    queued: () => 0,
    retries: () => 0,
    tabs: () => 0,
    portalRows: () => [{ name: 'careers', state: 'running', attempts: 1, note: '' }],
  };
  const dash = createDashboard({ store, scheduler, dryRun: true, stream: s, intervalMs: 5 });
  const origLog = console.log;
  try {
    dash.start();
    for (let i = 0; i < 20; i++) console.log(`[careers] line ${i}`);
    await new Promise((r) => setTimeout(r, 80)); // several interval ticks
    dash.stop();
  } finally {
    console.log = origLog;
  }
  assert.equal(count(s.text, '\x1b[?1049h'), 1, 'one alternate screen for the session');
  assert.equal(count(s.text, '\x1b[?1049l'), 1, 'original screen restored once');
  assert.ok(count(s.text, '\x1b[2J') <= 2, `full clears must not repeat per tick (saw ${count(s.text, '\x1b[2J')})`);
  // The panel is painted in place; the single final summary is printed after the original screen is restored.
  const afterRestore = s.text.slice(s.text.indexOf('\x1b[?1049l') + '\x1b[?1049l'.length);
  assert.equal(count(afterRestore, 'JOBMAN parallel'), 1, 'exactly one final summary after restore');
  assert.ok(s.text.includes('DRY RUN'), 'dry run is labelled');
});

test('dashboard log section shows the newest 3–15 entries that fit', () => {
  const s = fakeStream({ columns: 160, rows: 60 });
  const store = {
    stats: { seen: 0, confirmed: 0, perPortal: {} },
    applySlots: { active: 0, limit: 1, waiting: 0 },
    shuttingDown: false,
    appsPerMinute: () => 0,
  };
  const scheduler = { limits: () => ({ discovery: 1, apply: 1 }), activePortals: () => 0, queued: () => 0, retries: () => 0, tabs: () => 0, portalRows: () => [] };
  const dash = createDashboard({ store, scheduler, stream: s, intervalMs: 100000 });
  dash.start();
  try {
    for (let i = 0; i < 40; i++) dash.push(`entry ${i}`);
    const frame = dash.render().map(stripAnsi);
    const shown = frame.filter((l) => /^entry \d+$/.test(l));
    assert.ok(shown.length >= 3 && shown.length <= 15, `log entries shown: ${shown.length}`);
    assert.equal(shown[shown.length - 1], 'entry 39', 'newest entry is last');
  } finally {
    dash.stop();
  }
});

test('dashboard on a non-TTY writes no escape sequences and one compact status line on stop', () => {
  const s = fakeStream({ isTTY: false });
  const store = { stats: { seen: 3, confirmed: 1, perPortal: {} }, applySlots: { active: 0, limit: 1, waiting: 0 }, shuttingDown: false };
  const scheduler = { limits: () => ({ discovery: 1, apply: 1 }), activePortals: () => 0, queued: () => 0, retries: () => 0, tabs: () => 0, portalRows: () => [] };
  const logged = [];
  const origLog = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    const dash = createDashboard({ store, scheduler, stream: s, intervalMs: 100000 });
    dash.start();
    dash.stop();
  } finally {
    console.log = origLog;
  }
  assert.equal(s.text, '', 'no escape sequences or panel on a non-TTY');
  const statusLines = logged.filter((l) => l.startsWith('[status]'));
  assert.ok(statusLines.length >= 1 && statusLines.length <= 2, `compact status only, got ${statusLines.length}`);
  assert.ok(statusLines.every((l) => !l.includes('JOBMAN parallel')), 'no full dashboard on a non-TTY');
});

test('stop is idempotent and restores console methods', () => {
  const s = fakeStream();
  const store = { stats: { seen: 0, confirmed: 0, perPortal: {} }, applySlots: { active: 0, limit: 1, waiting: 0 }, shuttingDown: false };
  const scheduler = { limits: () => ({ discovery: 1, apply: 1 }), activePortals: () => 0, queued: () => 0, retries: () => 0, tabs: () => 0, portalRows: () => [] };
  const before = console.log;
  const dash = createDashboard({ store, scheduler, stream: s, intervalMs: 100000 });
  dash.start();
  dash.stop();
  dash.stop();
  assert.equal(console.log, before, 'console.log restored after stop');
  assert.equal(count(s.text, '\x1b[?1049l'), 1);
});
