const test = require('node:test');
const assert = require('node:assert/strict');
const { alreadyPlaced } = require('../src/core/direct');

const dedupWith = (kind) => ({
  priorDisposition: () => (kind ? { kind, reason: 'x' } : null),
});

test('alreadyPlaced is true only for placed (already) jobs', () => {
  assert.equal(alreadyPlaced(dedupWith('already'), 'https://x.test/job/1', { title: 'React Native Dev', company: 'Acme' }), true);
  assert.equal(alreadyPlaced(dedupWith('exhausted'), 'https://x.test/job/1'), false);
  assert.equal(alreadyPlaced(dedupWith(null), 'https://x.test/job/1'), false);
  assert.equal(alreadyPlaced(null, 'https://x.test/job/1'), false);
});
