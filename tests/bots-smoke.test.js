// Smoke test: every bot module loads and exposes run(). Catches syntax errors
// in the bots without needing a browser.
const test = require('node:test');
const assert = require('node:assert/strict');

for (const name of ['instahyre', 'naukri', 'linkedin', 'yourstory', 'wellfound', 'cutshort']) {
  test(`bots/${name} loads and exports run()`, () => {
    const bot = require(`../src/bots/${name}`);
    assert.equal(typeof bot.run, 'function');
  });
}

test('bots/yourstory searchUrl encodes query', () => {
  const { searchUrl } = require('../src/bots/yourstory');
  assert.match(searchUrl('react native'), /search=react%20native/);
});

test('bots/wellfound searchUrl uses role slug path', () => {
  const { searchUrl } = require('../src/bots/wellfound');
  assert.equal(searchUrl('react native developer'), 'https://wellfound.com/role/l/react-native/india');
  assert.equal(searchUrl('frontend engineer react'), 'https://wellfound.com/role/l/frontend-engineer/india');
});

test('bots/cutshort searchUrl uses category slug pages', () => {
  const { searchUrl } = require('../src/bots/cutshort');
  assert.equal(searchUrl('react native developer'), 'https://cutshort.io/jobs/react-native-jobs');
  assert.equal(searchUrl('frontend engineer react'), 'https://cutshort.io/jobs/frontend-developer-jobs');
});
