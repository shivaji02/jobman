const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFollowupStore } = require('../src/core/followups');

test('manual follow-ups persist until explicitly resolved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobman-followups-'));
  const file = path.join(dir, 'followups.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, items: [{ url: 'https://example.com/1', status: 'needs_reconfirmation' }] }));
  const store = createFollowupStore({ file });
  assert.equal(store.list().length, 1);
  assert.equal(store.resolve('https://example.com/missing'), false);
  assert.equal(store.resolve('https://example.com/1', 'posting closed'), true);
  assert.equal(store.list().length, 0);
  assert.equal(store.list({ status: 'resolved' })[0].resolution, 'posting closed');
});
