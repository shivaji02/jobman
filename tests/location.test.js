const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyLocation, byLocationPreference } = require('../src/core/location');

test('Hyderabad ranks best, then Bangalore, Chennai', () => {
  const h = classifyLocation('Hyderabad, Telangana');
  const b = classifyLocation('Bengaluru');
  const c = classifyLocation('Chennai');
  assert.ok(h.allowed && b.allowed && c.allowed);
  assert.ok(h.rank < b.rank && b.rank < c.rank);
});

test('Mumbai region is rejected even alongside other cities', () => {
  for (const t of ['Mumbai', 'Navi Mumbai, Maharashtra', 'Thane', 'Bangalore / Mumbai', 'Hyderabad, Mumbai']) {
    assert.equal(classifyLocation(t).allowed, false, t);
  }
});

test('non-south cities and pure remote are rejected; unknown is allowed', () => {
    assert.equal(classifyLocation('Gurgaon, Haryana').allowed, false);
  assert.equal(classifyLocation('Remote').allowed, false);
  assert.equal(classifyLocation('Remote - Hyderabad').allowed, true);
  assert.equal(classifyLocation('').allowed, true);
});

test('byLocationPreference sorts Hyderabad first', () => {
  const sorted = [{ location: 'Chennai' }, { location: '' }, { location: 'Hyderabad' }, { location: 'Bangalore' }]
    .sort(byLocationPreference).map((j) => j.location);
  assert.deepEqual(sorted, ['Hyderabad', 'Bangalore', 'Chennai', '']);
});

test('Pune is allowed only for good companies and ranks after the south', () => {
  assert.equal(classifyLocation('Pune', 'Random Staffing Pvt Ltd').allowed, false);
  const g = classifyLocation('Pune, Maharashtra', 'Atlassian');
  assert.equal(g.allowed, true);
  assert.ok(g.rank > classifyLocation('Chennai').rank);
  assert.equal(classifyLocation('Pune, Mumbai', 'Google').allowed, false);
  assert.equal(classifyLocation('Pune, Hyderabad', 'Unknown Co').city, 'Hyderabad');
});
