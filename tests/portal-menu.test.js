const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse, PORTALS } = require('../scripts/portal-menu');

test('a portal name runs live', () => {
  assert.deepEqual(parse('linkedin'), { portals: ['linkedin'], dry: false });
});

test("'dry' switches to a dry run for every portal in the line", () => {
  assert.deepEqual(parse('indeed dry'), { portals: ['indeed'], dry: true });
  assert.deepEqual(parse('dry naukri linkedin'), { portals: ['naukri', 'linkedin'], dry: true });
});

test('numbers select the portal at that position in the list', () => {
  assert.deepEqual(parse('1'), { portals: ['google'], dry: false });
  assert.equal(parse('5').portals[0], PORTALS[4]);
});

test("'all' selects every portal once, in list order", () => {
  const r = parse('all dry');
  assert.deepEqual(r.portals, PORTALS);
  assert.equal(r.dry, true);
});

test('duplicates are removed and separators accepted', () => {
  // "4" is naukri in the list, so the name and the number select the same portal once.
  assert.deepEqual(parse('naukri, naukri 4').portals, ['naukri']);
});

test('q quits; unknown names and empty input are reported, not run', () => {
  assert.deepEqual(parse('q'), { quit: true });
  assert.match(parse('foo').error, /unknown portal/);
  assert.match(parse('   ').error, /nothing entered/);
  assert.match(parse('dry').error, /pick at least one/);
});
