/**
 * Google discovery → employer postings.
 *
 * Search results are only leads. Each result URL is resolved to one of:
 *   posting    an employer ATS job (Greenhouse/Lever/Ashby/SmartRecruiters/Workday)
 *              with a job id — re-read from the ATS API later to prove it is open
 *   board      an employer ATS board without a job id — added to the company
 *              directory so the careers channel reads it every run
 *   page       a custom employer careers page; its HTML is fetched once to find an
 *              embedded ATS, or a schema.org JobPosting (title/location/dates)
 *   aggregator job boards / reposting sites — the portal bots cover these
 *   irrelevant anything else (blogs, articles, social posts)
 */
const { parseAtsUrl, detectAtsInHtml, stripHtml } = require('./ats');

/** Role × location × ATS searches from the brief, plus the open-web variants. */
const ROLE_PHRASES = [
  '"React Native"',
  '"React Native" Expo',
  '"React Developer"',
  '"Frontend Engineer" React',
  '"Full Stack" React "Node.js"',
  '"Mobile Software Engineer" "React Native"',
];

const DEFAULT_QUERIES = [
  'site:jobs.lever.co "React Native" India',
  'site:jobs.lever.co "Frontend Engineer" India',
  'site:boards.greenhouse.io "React" India',
  'site:job-boards.greenhouse.io "React Native" India',
  'site:jobs.ashbyhq.com "Frontend Engineer" India',
  'site:jobs.ashbyhq.com "React Native" India',
  'site:myworkdayjobs.com "React Native" India',
  'site:myworkdayjobs.com "React" Hyderabad',
  'site:jobs.smartrecruiters.com "React Native" India',
  'inurl:careers "React Native" "Hyderabad"',
  '"React Native Developer" "Bangalore" "apply"',
  '"React Native" "Expo" "India" careers',
  '"Full Stack Developer" "React" "Node.js" Hyderabad careers',
  '"Mobile Software Engineer" "React Native" India careers',
];

/** Third-party job boards and reposters: never treated as the employer. */
const AGGREGATOR_HOSTS = [
  'naukri.com', 'linkedin.com', 'indeed.com', 'glassdoor.com', 'glassdoor.co.in', 'foundit.in', 'monsterindia.com',
  'instahyre.com', 'wellfound.com', 'angel.co', 'cutshort.io', 'iimjobs.com', 'hirist.tech', 'hirist.com', 'shine.com',
  'timesjobs.com', 'apna.co', 'talent.com', 'simplyhired.com', 'simplyhired.co.in', 'ziprecruiter.com', 'jooble.org',
  'internshala.com', 'jobgether.com', 'builtin.com', 'remoterocketship.com', 'weworkremotely.com', 'remoteok.com',
  'himalayas.app', 'jobicy.com', 'workingnomads.com', 'ycombinator.com', 'workatastartup.com', 'japan-dev.com',
  'freshersworld.com', 'unstop.com', 'superset.com', 'quikr.com', 'placementindia.com', 'expertia.ai', 'hirect.in',
  'uplers.com', 'turing.com', 'toptal.com', 'arc.dev', 'crossover.com', 'lensa.com', 'jobrapido.com', 'careerjet.co.in',
];
/** Aggregators that run their own ATS boards (their "jobs" are reposts). */
const AGGREGATOR_ATS_TOKENS = new Set(['jobgether', 'crossover', 'turing', 'uplers', 'toptal', 'arc', 'remotebase', 'micro1', 'mercor']);
const NON_JOB_HOSTS = ['youtube.com', 'reddit.com', 'quora.com', 'medium.com', 'github.com', 'stackoverflow.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'wikipedia.org'];

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};
const hostIn = (host, list) => list.some((h) => host === h || host.endsWith(`.${h}`));

/** Google titles for ATS pages are usually "Company - Role" or "Role - Company". */
function companyFromResultTitle(title, ats) {
  const parts = String(title || '').split(/\s+[-–|@]\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return '';
  // Lever / Ashby: "Company - Role"; Greenhouse: "Job Application for Role at Company"
  const at = String(title).match(/\bat\s+([^|–-]+?)\s*$/i);
  if (ats === 'greenhouse' && at) return at[1].trim();
  return parts[0];
}

/** Classify one search result (no network). */
function classifyResult(result) {
  const host = hostOf(result.url);
  if (!host) return { kind: 'irrelevant', reason: 'bad url' };
  const ats = parseAtsUrl(result.url);
  if (ats) {
    if (AGGREGATOR_ATS_TOKENS.has(String(ats.token).toLowerCase())) return { kind: 'aggregator', reason: `reposting board on ${ats.ats} (${ats.token})` };
    const name = companyFromResultTitle(result.title, ats.ats);
    return ats.jobId ? { kind: 'posting', ref: { ...ats, id: ats.jobId }, name } : { kind: 'board', ref: ats, name };
  }
  if (hostIn(host, AGGREGATOR_HOSTS)) return { kind: 'aggregator', reason: host };
  if (hostIn(host, NON_JOB_HOSTS)) return { kind: 'irrelevant', reason: host };
  if (/career|jobs?\b|join|opening|vacanc|position|hiring/i.test(result.url) || /career|job|hiring|opening/i.test(result.title)) {
    return { kind: 'page', host };
  }
  return { kind: 'irrelevant', reason: 'not a careers page' };
}

/** schema.org JobPosting blocks embedded in a careers page. */
function jobPostingsFromHtml(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const nodes = [].concat(data, ...(Array.isArray(data?.['@graph']) ? [data['@graph']] : []));
    for (const n of nodes.flat()) {
      if (!n || !/JobPosting/i.test(String(n['@type']))) continue;
      const loc = [].concat(n.jobLocation || []).map((l) => {
        const a = l?.address || {};
        return [a.addressLocality, a.addressRegion, a.addressCountry?.name || a.addressCountry].filter(Boolean).join(', ');
      });
      out.push({
        title: n.title || '',
        company: n.hiringOrganization?.name || '',
        location: [...loc, n.jobLocationType === 'TELECOMMUTE' ? 'Remote' : ''].filter(Boolean).join(' / '),
        text: stripHtml(n.description || '').slice(0, 6000),
        postedAt: n.datePosted || '',
        validThrough: n.validThrough || '',
      });
    }
  }
  return out;
}

/**
 * Resolve a custom careers page: fetch it once, look for an embedded ATS or a
 * JobPosting. Returns { refs: [...parseAtsUrl], postings: [...JobPosting], finalUrl }.
 */
async function resolvePage(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36', accept: 'text/html' },
  });
  const finalUrl = res.url || url;
  // A legitimate redirect straight onto an ATS posting.
  const direct = parseAtsUrl(finalUrl);
  if (direct) return { refs: [direct], postings: [], finalUrl };
  if (!res.ok) return { refs: [], postings: [], finalUrl, error: `HTTP ${res.status}` };
  const html = (await res.text()).slice(0, 2_000_000);
  return { refs: detectAtsInHtml(html), postings: jobPostingsFromHtml(html), finalUrl };
}

module.exports = {
  AGGREGATOR_ATS_TOKENS,
  DEFAULT_QUERIES,
  ROLE_PHRASES,
  AGGREGATOR_HOSTS,
  classifyResult,
  companyFromResultTitle,
  jobPostingsFromHtml,
  resolvePage,
};
