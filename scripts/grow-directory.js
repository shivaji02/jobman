#!/usr/bin/env node
/**
 * Grow data/companies.json through the public ATS APIs (see src/core/directoryGrowth.js).
 *   npm run directory:grow -- --companies=300
 */
const directory = require('../src/core/companies');
const { growDirectory } = require('../src/core/directoryGrowth');

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;

(async () => {
  const before = directory.list().length;
  const res = await growDirectory(directory, { maxCompanies: Number(arg('companies', 200)) });
  console.log(`probed ${res.probedCompanies} companies (${res.requests} API requests)`);
  for (const a of res.added) console.log(`  + ${a.ats}:${a.token}  ${a.name}  (${a.indiaOpenings ?? '?'} India openings of ${a.openings ?? '?'}; via ${a.via})`);
  console.log(`directory: ${before} → ${directory.list().length} boards`);
})();
