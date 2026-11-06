/**
 * Employer ATS (applicant tracking system) readers: Greenhouse, Lever, Ashby,
 * SmartRecruiters, Workday. These are the public, unauthenticated JSON
 * endpoints the companies' own career pages call — no login, no scraping.
 *
 * Every posting record has the same shape:
 *   { id, title, company, location, url, applyUrl, text, postedAt, ats, token,
 *     country, remote }
 *
 * Board fetchers take a directory entry { name, ats, token, site?, host? } and
 * return the board's open postings (already narrowed to India where the API
 * can filter server-side). fetchPosting(ref) re-reads ONE posting by id: it is
 * the "is this job still open?" check — the APIs only serve open postings — and
 * returns the full description (plus Greenhouse's application questions).
 */
const FETCH_TIMEOUT_MS = 15_000;

async function getJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json', ...(init.headers || {}) },
  });
  if (res.status === 404 || res.status === 410) {
    const err = new Error(`${res.status} ${url}`);
    err.closed = true; // posting / board no longer exists
    throw err;
  }
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const stripHtml = (s) =>
  String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<(br|\/p|\/li|\/h\d|\/div)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#x?[0-9a-f]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();

const toIso = (v) => {
  if (v == null || v === '') return '';
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
};

/** Workday "Posted 3 Days Ago" / "Posted Today" / "Posted 30+ Days Ago" → ISO (approx). */
function workdayPostedOn(text, now = new Date()) {
  const t = String(text || '').toLowerCase();
  if (/today/.test(t)) return now.toISOString();
  if (/yesterday/.test(t)) return new Date(now - 86_400_000).toISOString();
  const m = t.match(/(\d+)\+?\s*days?/);
  if (m) return new Date(now - Number(m[1]) * 86_400_000).toISOString();
  return '';
}

// ---------------------------------------------------------------- Greenhouse
const ghApi = (token) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}`;

function ghRecord(j, { name, token }) {
  return {
    id: String(j.id),
    title: j.title || '',
    company: j.company_name || name || token,
    location: j.location?.name || '',
    url: j.absolute_url || `https://job-boards.greenhouse.io/${token}/jobs/${j.id}`,
    applyUrl: j.absolute_url || `https://job-boards.greenhouse.io/${token}/jobs/${j.id}`,
    text: stripHtml(j.content || '').slice(0, 6000),
    postedAt: toIso(j.first_published || j.updated_at),
    ats: 'greenhouse',
    token,
  };
}

async function greenhouse(c) {
  // content=false keeps the payload small; descriptions are fetched per posting
  // only for the few that pass the location/title pre-filter (fetchPosting).
  const data = await getJson(`${ghApi(c.token)}/jobs?content=${c.withContent ? 'true' : 'false'}`);
  return (data.jobs || []).map((j) => ghRecord(j, c));
}

async function greenhousePosting({ token, id, name }) {
  const j = await getJson(`${ghApi(token)}/jobs/${encodeURIComponent(id)}?questions=true`);
  const rec = ghRecord(j, { name, token });
  rec.questions = [
    ...(j.questions || []),
    ...(j.location_questions || []),
    ...((j.compliance || []).flatMap((c) => c.questions || [])),
    ...((j.demographic_questions?.questions) || []),
  ].map((q) => ({
    label: q.label || '',
    required: !!q.required,
    fields: (q.fields || []).map((f) => ({ name: f.name, type: f.type, values: (f.values || []).map((v) => v.label) })),
  }));
  return rec;
}

// --------------------------------------------------------------------- Lever
const leverApi = (c) => `https://${c.region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co'}/v0/postings/${encodeURIComponent(c.token)}`;

function leverRecord(j, c) {
  return {
    id: String(j.id),
    title: j.text || '',
    company: c.name || c.token,
    location: [j.categories?.location, ...(j.categories?.allLocations || [])].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' / '),
    url: j.hostedUrl,
    applyUrl: j.applyUrl || `${j.hostedUrl}/apply`,
    text: [j.descriptionPlain || stripHtml(j.description), ...(j.lists || []).map((l) => `${l.text}\n${stripHtml(l.content)}`), j.additionalPlain || '']
      .join('\n')
      .slice(0, 6000),
    postedAt: toIso(j.createdAt),
    ats: 'lever',
    token: c.token,
    country: j.country || '',
    remote: /remote/i.test(j.workplaceType || ''),
  };
}

async function lever(c) {
  const data = await getJson(`${leverApi(c)}?mode=json`);
  return (Array.isArray(data) ? data : []).map((j) => leverRecord(j, c));
}

async function leverPosting(ref) {
  return leverRecord(await getJson(`${leverApi(ref)}/${encodeURIComponent(ref.id)}`), ref);
}

// --------------------------------------------------------------------- Ashby
function ashbyRecord(j, c) {
  return {
    id: String(j.id),
    title: j.title || '',
    company: c.name || c.token,
    location: [j.location, ...(j.secondaryLocations || []).map((l) => l.location)].filter(Boolean).join(' / '),
    url: j.jobUrl,
    applyUrl: j.applyUrl || `${j.jobUrl}/application`,
    text: String(j.descriptionPlain || stripHtml(j.descriptionHtml)).slice(0, 6000),
    postedAt: toIso(j.publishedAt),
    ats: 'ashby',
    token: c.token,
    country: j.address?.postalAddress?.addressCountry || '',
    remote: !!j.isRemote,
  };
}

async function ashby(c) {
  const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(c.token)}`);
  return (data.jobs || []).filter((j) => j.isListed !== false).map((j) => ashbyRecord(j, c));
}

async function ashbyPosting(ref) {
  const jobs = await ashby(ref);
  const hit = jobs.find((j) => j.id === ref.id);
  if (!hit) {
    const err = new Error(`ashby posting ${ref.id} no longer listed`);
    err.closed = true;
    throw err;
  }
  return hit;
}

// ----------------------------------------------------------- SmartRecruiters
const srApi = (token) => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings`;

function srRecord(j, c) {
  const loc = j.location || {};
  const sections = j.jobAd?.sections || {};
  const text = ['jobDescription', 'qualifications', 'additionalInformation']
    .map((k) => stripHtml(sections[k]?.text || ''))
    .join('\n');
  return {
    id: String(j.id),
    title: j.name || '',
    company: j.company?.name || c.name || c.token,
    location: [loc.city, loc.region, loc.country === 'in' ? 'India' : loc.country, loc.remote ? 'Remote' : ''].filter(Boolean).join(', '),
    url: j.postingUrl || `https://jobs.smartrecruiters.com/${c.token}/${j.id}`,
    applyUrl: j.applyUrl || `https://jobs.smartrecruiters.com/${c.token}/${j.id}`,
    text: text.slice(0, 6000),
    postedAt: toIso(j.releasedDate),
    ats: 'smartrecruiters',
    token: c.token,
    country: loc.country || '',
    remote: !!loc.remote,
  };
}

async function smartrecruiters(c) {
  // Server-side country filter: only Indian postings are downloaded.
  const out = [];
  for (let offset = 0; offset < 400; offset += 100) {
    const data = await getJson(`${srApi(c.token)}?country=in&limit=100&offset=${offset}`);
    out.push(...(data.content || []).map((j) => srRecord(j, c)));
    if (!data.content || data.content.length < 100) break;
  }
  return out;
}

async function smartrecruitersPosting(ref) {
  return srRecord(await getJson(`${srApi(ref.token)}/${encodeURIComponent(ref.id)}`), ref);
}

// ------------------------------------------------------------------- Workday
const wdBase = (c) => `https://${c.host}/wday/cxs/${encodeURIComponent(c.token)}/${encodeURIComponent(c.site)}`;
const wdPublic = (c, externalPath) => `https://${c.host}/${c.site}${externalPath}`;

/** Workday can search server-side; India + our keywords keeps the download tiny. */
const WORKDAY_SEARCHES = ['react native', 'react', 'frontend', 'full stack'];

async function workday(c) {
  const seen = new Map();
  for (const searchText of c.searches || WORKDAY_SEARCHES) {
    const data = await getJson(`${wdBase(c)}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: `${searchText} india` }),
    });
    for (const p of data.jobPostings || []) {
      if (!p.externalPath || seen.has(p.externalPath)) continue;
      seen.set(p.externalPath, {
        id: p.externalPath,
        title: p.title || '',
        company: c.name || c.token,
        location: p.locationsText || '',
        url: wdPublic(c, p.externalPath),
        applyUrl: `${wdPublic(c, p.externalPath)}/apply`,
        text: '',
        postedAt: workdayPostedOn(p.postedOn),
        ats: 'workday',
        token: c.token,
        site: c.site,
        host: c.host,
      });
    }
  }
  return [...seen.values()];
}

async function workdayPosting(ref) {
  let data;
  try {
    data = await getJson(`${wdBase(ref)}${ref.id}`);
  } catch (err) {
    // Google often indexes /job/<slug>_<REQ> without the location segment the
    // API needs; look the requisition up by id to get its real path.
    const req = (String(ref.id).match(/_([A-Za-z0-9-]+)$/) || [])[1];
    if (err.closed || !req) throw err;
    const found = await getJson(`${wdBase(ref)}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: 5, offset: 0, searchText: req }),
    });
    const hit = (found.jobPostings || []).find((p) => String(p.externalPath || '').endsWith(`_${req}`));
    if (!hit) {
      const e = new Error(`workday requisition ${req} no longer listed`);
      e.closed = true;
      throw e;
    }
    ref = { ...ref, id: hit.externalPath };
    data = await getJson(`${wdBase(ref)}${ref.id}`);
  }
  const info = data.jobPostingInfo || {};
  if (info.canApply === false) {
    const err = new Error('workday posting no longer accepts applications');
    err.closed = true;
    throw err;
  }
  return {
    id: ref.id,
    title: info.title || '',
    company: data.hiringOrganization?.name || ref.name || ref.token,
    location: [info.location, ...(info.additionalLocations || [])].filter(Boolean).join(' / '),
    url: info.externalUrl || wdPublic(ref, ref.id),
    applyUrl: `${info.externalUrl || wdPublic(ref, ref.id)}/apply`,
    text: stripHtml(info.jobDescription).slice(0, 6000),
    postedAt: toIso(info.startDate) || workdayPostedOn(info.postedOn),
    ats: 'workday',
    token: ref.token,
    site: ref.site,
    host: ref.host,
    country: info.country?.descriptor || '',
    remote: /remote/i.test(info.remoteType || ''),
  };
}

const FETCHERS = { greenhouse, lever, ashby, smartrecruiters, workday };
const POSTING_FETCHERS = {
  greenhouse: greenhousePosting,
  lever: leverPosting,
  ashby: ashbyPosting,
  smartrecruiters: smartrecruitersPosting,
  workday: workdayPosting,
};

/** Re-read one posting from its ATS: proves it is open and returns the full JD. */
async function fetchPosting(ref) {
  const fn = POSTING_FETCHERS[ref.ats];
  if (!fn || !ref.id) throw new Error(`no posting reader for ${ref.ats}`);
  return fn(ref);
}

/**
 * Identify the ATS behind a URL. Returns { ats, token, ...extras, jobId? } or null.
 *   greenhouse      boards.greenhouse.io/<t>/jobs/<id>, job-boards(.eu).greenhouse.io/<t>/jobs/<id>,
 *                   boards.greenhouse.io/embed/job_app?for=<t>&token=<id>
 *   lever           jobs(.eu).lever.co/<t>/<uuid>[/apply]
 *   ashby           jobs.ashbyhq.com/<t>/<uuid>[/application]
 *   smartrecruiters jobs.smartrecruiters.com/<Co>/<id>-slug, careers.smartrecruiters.com/<Co>
 *   workday         <tenant>.wd<N>.myworkdayjobs.com/[<locale>/]<site>/job/<loc>/<slug>_<req>
 */
function parseAtsUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));

  if (/(^|\.)greenhouse\.io$/.test(host)) {
    if (parts[0] === 'embed') {
      const token = u.searchParams.get('for');
      const jobId = u.searchParams.get('token');
      return token ? { ats: 'greenhouse', token, ...(jobId ? { jobId } : {}) } : null;
    }
    if (!parts[0]) return null;
    const i = parts.indexOf('jobs');
    const jobId = i >= 0 && /^\d+$/.test(parts[i + 1] || '') ? parts[i + 1] : u.searchParams.get('gh_jid') || '';
    return { ats: 'greenhouse', token: parts[0], ...(jobId ? { jobId } : {}) };
  }
  if (/(^|\.)lever\.co$/.test(host) && /^jobs\./.test(host)) {
    if (!parts[0]) return null;
    const jobId = /^[0-9a-f-]{36}$/i.test(parts[1] || '') ? parts[1] : '';
    return { ats: 'lever', token: parts[0], ...(host.includes('.eu.') ? { region: 'eu' } : {}), ...(jobId ? { jobId } : {}) };
  }
  if (host === 'jobs.ashbyhq.com') {
    if (!parts[0]) return null;
    const jobId = /^[0-9a-f-]{36}$/i.test(parts[1] || '') ? parts[1] : '';
    return { ats: 'ashby', token: parts[0], ...(jobId ? { jobId } : {}) };
  }
  if (/(^|\.)smartrecruiters\.com$/.test(host) && /^(jobs|careers)\./.test(host)) {
    if (!parts[0] || parts[0] === 'oneclick-ui') return null;
    const m = (parts[1] || '').match(/^(\d{6,})/);
    return { ats: 'smartrecruiters', token: parts[0], ...(m ? { jobId: m[1] } : {}) };
  }
  const wd = host.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/);
  if (wd) {
    const rest = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] || '') ? parts.slice(1) : parts;
    if (!rest[0]) return null;
    const jobIdx = rest.indexOf('job');
    const jobId = jobIdx >= 0 && rest[jobIdx + 1] ? `/${rest.slice(jobIdx, jobIdx + 3).filter((p) => p !== 'apply').join('/')}` : '';
    return { ats: 'workday', token: wd[1], site: rest[0], host, ...(jobId ? { jobId } : {}) };
  }
  return null;
}

/**
 * One canonical URL per ATS posting, so the same job reached through Google,
 * LinkedIn's "apply on company site", Naukri's redirect or the company's own
 * careers page dedups to a single key. Returns '' for non-ATS URLs.
 */
function canonicalAtsUrl(url) {
  const p = parseAtsUrl(url);
  if (!p || !p.jobId) return '';
  switch (p.ats) {
    case 'greenhouse':
      return `https://job-boards.greenhouse.io/${p.token.toLowerCase()}/jobs/${p.jobId}`;
    case 'lever':
      return `https://jobs.${p.region === 'eu' ? 'eu.' : ''}lever.co/${p.token.toLowerCase()}/${p.jobId.toLowerCase()}`;
    case 'ashby':
      return `https://jobs.ashbyhq.com/${p.token.toLowerCase()}/${p.jobId.toLowerCase()}`;
    case 'smartrecruiters':
      return `https://jobs.smartrecruiters.com/${p.token.toLowerCase()}/${p.jobId}`;
    case 'workday':
      return `https://${p.host}/${p.site}${p.jobId}`;
    default:
      return '';
  }
}

/**
 * Find an employer ATS behind a custom careers page (iframe/embed/link/script).
 * Returns parseAtsUrl()-style refs, deduped.
 */
function detectAtsInHtml(html) {
  const out = new Map();
  const urls = String(html || '').match(/https?:\/\/[^\s"'<>()\\]+/g) || [];
  for (const raw of urls) {
    const p = parseAtsUrl(raw.replace(/&amp;/g, '&'));
    if (p) out.set(`${p.ats}:${p.token.toLowerCase()}:${p.jobId || ''}`, p);
  }
  // Greenhouse embed script: <script src=".../embed/job_board/js?for=acme">
  for (const m of String(html || '').matchAll(/greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([a-z0-9_-]+)/gi)) {
    out.set(`greenhouse:${m[1].toLowerCase()}:`, { ats: 'greenhouse', token: m[1] });
  }
  return [...out.values()];
}

module.exports = {
  FETCHERS,
  fetchPosting,
  parseAtsUrl,
  canonicalAtsUrl,
  detectAtsInHtml,
  stripHtml,
  workdayPostedOn,
  ATS_NAMES: Object.keys(FETCHERS),
};
