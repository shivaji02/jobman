#!/usr/bin/env node
/**
 * Interactive portal menu: pick one or more portals by name or number and run
 * them one after another, each in its own `node src/index.js run <portal>`.
 *
 *   npm run menu
 *
 * At the prompt:
 *   linkedin              run LinkedIn (live)
 *   indeed dry            run Indeed as a dry run (nothing submitted)
 *   naukri linkedin       run Naukri, then LinkedIn
 *   3                     number from the list (same as its name)
 *   all dry               every portal, dry run
 *   q                     quit
 */
const readline = require('readline');
const path = require('path');
const { spawn } = require('child_process');

const PORTALS = ['google', 'careers', 'instahyre', 'naukri', 'linkedin', 'indeed', 'foundit', 'wellfound', 'talent', 'yourstory'];
const ENTRY = path.join(__dirname, '..', 'src', 'index.js');

function printMenu() {
  console.log('\nJobman portals:');
  PORTALS.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${p}`));
  console.log("\nType a name or number (several allowed), add 'dry' for a dry run, 'all' for every portal, 'q' to quit.");
}

/** Parse one prompt line into { portals, dry } or { error }. */
function parse(line) {
  const tokens = line.trim().toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!tokens.length) return { error: 'nothing entered' };
  if (tokens.includes('q') || tokens.includes('quit')) return { quit: true };
  const dry = tokens.includes('dry');
  const picked = [];
  for (const t of tokens) {
    if (t === 'dry') continue;
    if (t === 'all') {
      picked.push(...PORTALS);
      continue;
    }
    const byNumber = /^\d+$/.test(t) ? PORTALS[Number(t) - 1] : null;
    const name = byNumber || (PORTALS.includes(t) ? t : null);
    if (!name) return { error: `unknown portal "${t}"` };
    picked.push(name);
  }
  if (!picked.length) return { error: "pick at least one portal (e.g. 'linkedin dry')" };
  return { portals: [...new Set(picked)], dry };
}

/** Run one portal in its own process with the terminal attached. Resolves to its exit code. */
function runPortal(portal, dry) {
  const args = [ENTRY, 'run', portal];
  if (dry) args.push('--dry-run');
  console.log(`\n▶ ${portal}${dry ? ' (dry run)' : ''}`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(`could not start ${portal}: ${err.message}`);
      resolve(1);
    });
  });
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Ctrl+C at the prompt exits the menu; during a run the child already receives the signal.
  rl.on('SIGINT', () => {
    console.log('\nbye');
    rl.close();
    process.exit(130);
  });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  printMenu();
  for (;;) {
    const answer = await ask('\nportal> ');
    const parsed = parse(answer);
    if (parsed.quit) break;
    if (parsed.error) {
      console.log(`  ${parsed.error}`);
      continue;
    }
    for (const portal of parsed.portals) {
      await runPortal(portal, parsed.dry);
    }
    console.log('\nDone. Pick another portal, or q to quit.');
  }
  rl.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { parse, PORTALS };
