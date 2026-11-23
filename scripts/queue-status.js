#!/usr/bin/env node
/**
 * Print the state of the verification queue and the manual-action queue.
 *   npm run queues
 */
const { createVerificationQueue } = require('../src/core/verification-queue');
const { createManualActions } = require('../src/core/manual-actions');

const vq = createVerificationQueue();
const ma = createManualActions();

const vqAll = vq.list();
const counts = {};
for (const e of vqAll) counts[e.state] = (counts[e.state] || 0) + 1;
console.log(`Verification queue (${vq.file}): ${vqAll.length} entries`);
for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k}: ${v}`);
for (const e of vq.due()) console.log(`  due now: ${e.company} — ${e.title} (retry ${e.retryCount}) ${e.url}`);

const open = ma.list({ status: 'open' });
const s = ma.summary();
console.log(`\nManual actions (${ma.file}): ${s.open} open`);
for (const [kind, n] of Object.entries(s.byKind).sort()) console.log(`  ${kind}: ${n}`);
for (const e of open.slice(0, 50)) {
  console.log(`\n  ${e.company} — ${e.title}`);
  console.log(`    apply: ${e.applicationUrl}`);
  console.log(`    why:   ${e.exactBlocker}`);
  console.log(`    do:    ${e.requiredUserAction}`);
}
if (open.length > 50) console.log(`\n  … ${open.length - 50} more in ${ma.file}`);
