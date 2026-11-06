/**
 * Grow the company directory without Google, through the ATSs' own public
 * job-board APIs (the same unauthenticated endpoints the companies' career
 * pages call). No scraping, no login, no CAPTCHA.
 *
 * Seeds, best first:
 *   1. ATS links already in data/applied_jobs_log.csv (external "apply on
 *      company site" links from LinkedIn/Naukri/Wellfound…): exact boards.
 *   2. Companies that posted matching roles (React / React Native / frontend /
 *      full-stack / mobile) on the portals, most frequent first.
 *   3. location.GOOD_COMPANIES (well-known employers).
 * Each company name becomes a few slug guesses ("Couchbase Inc" → couchbase,
 * couchbaseinc), probed on Greenhouse, Lever, Ashby and SmartRecruiters. A board
 * is added only if it exists AND currently lists at least one opening in India;
 * Greenhouse boards must also carry a matching company name. Misses are cached
 * for 30 days so each run probes new companies (data/ats_probe_cache.json).
 */
const fs = require('fs');
const path = require('path');
const { parseAtsUrl } = require('./ats');
const { GOOD_COMPANIES } = require('./location');
const { AGGREGATOR_ATS_TOKENS } = require('./discovery');
const logger = require('./logger');

const ROOT = path.join(__dirname, '..', '..');
const CACHE_FILE = path.join(ROOT, 'data', 'ats_probe_cache.json');
const LOG_FILE = path.join(ROOT, 'data', 'applied_jobs_log.csv');
const MISS_TTL_DAYS = 30;
const RELEVANT_TITLE_RE = /react|front[- ]?end|full[- ]?stack|mobile|javascript|typescript|node/i;
const INDIA_RE = /\b(india|hyderabad|secunderabad|bengaluru|bangalore|chennai|kochi|coimbatore|trivandrum|thiruvananthapuram|mysore|mysuru|visakhapatnam|pune|telangana|karnataka|tamil nadu|kerala|remote\s*[-–(]?\s*in(dia)?)\b/i;
const PLACEHOLDER_RE = /confidential|leading client|stealth|reputed|top (mnc|company)|our client|hiring for|mnc\b|consult(ing|ancy)|staffing|recruit|placement|manpower|hr services|talent|careerxperts|connecting 2 work/i;
const SUFFIX_RE = /\b(pvt|private|ltd|limited|inc|llc|llp|corp|corporation|co|company|technologies|technology|tech|solutions|services|software|systems|labs|india|global|group|the)\b/g;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Slug guesses for a company name, most likely first (max 3). */
function slugCandidates(name) {
  const raw = String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/\.(com|io|ai|in|co)\b/g, ' ').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw || PLACEHOLDER_RE.test(raw)) return [];
  const core = raw.replace(SUFFIX_RE, ' ').replace(/\s+/g, ' ').trim();
  const out = [];
  const add = (s) => {
    if (s && s.length >= 2 && s.length <= 40 && !out.includes(s)) out.push(s);
  };
  add(core.replace(/\s/g, ''));
  add(core.replace(/\s/g, '-'));
  add(raw.replace(/\s/g, ''));
  return out.slice(0, 3);
}

/** Rows of the log → { atsRefs, companies } seeds. */
function seedsFromLog(file = LOG_FILE) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { atsRefs: [], companies: [] };
  }
  const atsRefs = new Map();
  for (const u of text.match(/https?:\/\/[^\s",|)]+/g) || []) {
    const p = parseAtsUrl(u);
    if (p) atsRefs.set(`${p.ats}:${p.token.toLowerCase()}`, { ...p, jobId: undefined });
  }
  const counts = new Map();
  for (const line of text.split('\n').slice(1)) {
    const cols = line.split(',');
    if (cols.length < 5) continue;
    const [, , title, company] = cols;
    if (!company || !RELEVANT_TITLE_RE.test(title || '')) continue;
    const c = company.replace(/^"|"$/g, '').trim();
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const companies = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  return { atsRefs: [...atsRefs.values()].map(({ jobId, ...r }) => r), companies };
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: { accept: 'application/json' } });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

const normName = (s) => String(s || '').toLowerCase().replace(SUFFIX_RE, ' ').replace(/[^a-z0-9]/g, '');
/** "AQR India" must not match a company called "India": both cores non-empty and ≥3 chars. */
function namesMatch(a, b) {
  const x = normName(a);
  const y = normName(b);
  return x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x));
}

/** Probe one ATS for a slug. Returns { ats, token, name, openings, indiaOpenings } or null. */
async function probe(ats, slug, companyName) {
  switch (ats) {
    case 'greenhouse': {
      const board = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}`);
      if (!board || !board.name) return null;
      // Slugs collide ("slice", "zeta"); the board's own name must match.
      if (companyName && !namesMatch(board.name, companyName)) return null;
      const jobs = (await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=false`))?.jobs || [];
      return { ats, token: slug, name: board.name, openings: jobs.length, indiaOpenings: jobs.filter((j) => INDIA_RE.test(j.location?.name || '')).length };
    }
    case 'lever': {
      const jobs = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
      if (!Array.isArray(jobs) || !jobs.length) return null;
      const india = jobs.filter((j) => INDIA_RE.test([j.categories?.location, ...(j.categories?.allLocations || []), j.country === 'IN' ? 'India' : ''].join(' '))).length;
      return { ats, token: slug, name: companyName || slug, openings: jobs.length, indiaOpenings: india };
    }
    case 'ashby': {
      const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
      const jobs = data?.jobs || [];
      if (!jobs.length) return null;
      const india = jobs.filter((j) => INDIA_RE.test([j.location, ...(j.secondaryLocations || []).map((l) => l.location), j.address?.postalAddress?.addressCountry].join(' '))).length;
      return { ats, token: slug, name: companyName || slug, openings: jobs.length, indiaOpenings: india };
    }
    case 'smartrecruiters': {
      const data = await getJson(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?country=in&limit=1`);
      if (!data || !data.totalFound) return null;
      const name = data.content?.[0]?.company?.name || companyName || slug;
      if (companyName && !namesMatch(name, companyName)) return null;
      return { ats, token: slug, name, openings: data.totalFound, indiaOpenings: data.totalFound };
    }
    default:
      return null;
  }
}

const PROBE_ATS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters'];

function loadCache(file = CACHE_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Probe up to `maxCompanies` not-yet-probed companies; add boards with Indian
 * openings to `directory`. Returns { probedCompanies, requests, added: [...] }.
 */
async function growDirectory(directory, { maxCompanies = Number(process.env.JOBMAN_DIRECTORY_PROBES) || 40, concurrency = 6, cacheFile = CACHE_FILE, logFile = LOG_FILE, extraCompanies = [] } = {}) {
  const cache = loadCache(cacheFile);
  const now = Date.now();
  const fresh = (k) => cache[k] && cache[k].result === 'miss' && now - new Date(cache[k].at).getTime() < MISS_TTL_DAYS * 86_400_000;
  const known = new Set(directory.list().map((c) => `${c.ats}:${String(c.token).toLowerCase()}`));
  const added = [];
  let requests = 0;

  // 1. exact boards from ATS links in the log (one read each to check India openings)
  const { atsRefs, companies } = seedsFromLog(logFile);
  for (const ref of atsRefs) {
    const k = `${ref.ats}:${ref.token.toLowerCase()}`;
    if (known.has(k) || fresh(k)) continue;
    if (ref.ats === 'workday') {
      directory.upsert(ref, { source: 'log: ATS link', persist: false });
      known.add(k);
      added.push({ ...ref, name: ref.token, via: 'log link' });
      continue;
    }
    try {
      requests++;
      const hit = await probe(ref.ats, ref.token, null);
      cache[k] = { result: hit && hit.indiaOpenings ? 'hit' : 'miss', at: new Date().toISOString() };
      if (hit && hit.indiaOpenings) {
        directory.upsert(ref, { source: 'log: ATS link', name: hit.name, persist: false });
        known.add(k);
        added.push({ ...hit, via: 'log link' });
      }
    } catch (err) {
      logger.debug(`[directory] ${k}: ${err.message}`);
    }
  }

  // 2+3. company names → slug guesses → probe each ATS
  const brands = new Set(GOOD_COMPANIES);
  const names = [...new Set([...extraCompanies, ...companies, ...GOOD_COMPANIES])];
  const queue = [];
  for (const name of names) {
    const slugs = slugCandidates(name).filter((sl) => !AGGREGATOR_ATS_TOKENS.has(sl));
    const jobs = [];
    // Lever/Ashby return no company name, so a famous brand's slug ("linkedin") can belong
    // to someone else. Brands are only probed where the board's own name is checked.
    const atsList = brands.has(name) && !companies.includes(name) ? ['greenhouse', 'smartrecruiters'] : PROBE_ATS;
    for (const slug of slugs) for (const ats of atsList) {
      const k = `${ats}:${slug}`;
      if (!known.has(k) && !fresh(k) && !cache[k]) jobs.push({ ats, slug, k });
    }
    if (jobs.length) queue.push({ name, jobs });
    if (queue.length >= maxCompanies) break;
  }
  const work = queue.flatMap((c) => c.jobs.map((j) => ({ ...j, name: c.name })));
  let i = 0;
  const worker = async () => {
    while (i < work.length) {
      const j = work[i++];
      requests++;
      try {
        const hit = await probe(j.ats, j.slug, j.name);
        cache[j.k] = { result: hit && hit.indiaOpenings ? 'hit' : 'miss', at: new Date().toISOString() };
        if (hit && hit.indiaOpenings && !known.has(j.k)) {
          known.add(j.k);
          directory.upsert({ ats: j.ats, token: j.slug }, { source: `ats probe: ${j.name}`, name: hit.name, persist: false });
          added.push({ ...hit, via: j.name });
        }
      } catch (err) {
        logger.debug(`[directory] probe ${j.k}: ${err.message}`); // transient — not cached, retried next run
      }
      await sleep(150);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  directory.save();
  return { probedCompanies: queue.length, requests, added };
}

module.exports = { namesMatch, growDirectory, slugCandidates, seedsFromLog, probe, PLACEHOLDER_RE };
