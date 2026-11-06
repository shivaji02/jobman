/**
 * Persistent company directory — data/companies.json.
 *
 * One entry per employer ATS board, keyed "<ats>:<token>":
 *   { name, ats, token, site?, host?, region?, careersUrl, sources[],
 *     firstSeen, lastSeen, lastChecked, openings, indiaOpenings, relevant }
 *
 * Seeded from config/careers.json (hand-curated) and grown by Google discovery
 * (new employers found through search). The careers channel re-reads every
 * board in it each run; the stats let it skip boards that never have Indian
 * openings (indiaOpenings === 0 for a while) without forgetting them.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_FILE = path.join(ROOT, 'data', 'companies.json');
const SEED_FILE = path.join(ROOT, 'config', 'careers.json');
const LEGACY_DISCOVERED = path.join(ROOT, 'data', 'careers_discovered.json');

const keyOf = (ref) => `${ref.ats}:${String(ref.token || '').toLowerCase()}`;
const today = () => new Date().toISOString().slice(0, 10);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function createDirectory(file = DEFAULT_FILE, { seedFile = SEED_FILE, legacyFile = LEGACY_DISCOVERED } = {}) {
  let data = null;

  function load() {
    data = readJson(file, { companies: {} });
    if (!data.companies || typeof data.companies !== 'object') data.companies = {};
    for (const c of readJson(seedFile, { companies: [] }).companies || []) upsert(c, { source: 'config', name: c.name, persist: false });
    for (const c of readJson(legacyFile, { companies: [] }).companies || []) upsert(c, { source: 'discovery (legacy)', persist: false });
    return data;
  }
  const ensure = () => data || load();

  function save() {
    ensure();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  /** Add or refresh a board. Returns { entry, isNew }. */
  function upsert(ref, { source = '', name = '', careersUrl = '', persist = true } = {}) {
    ensure();
    if (!ref || !ref.ats || !ref.token) return { entry: null, isNew: false };
    const key = keyOf(ref);
    const prev = data.companies[key];
    const entry = prev || {
      name: name || ref.name || ref.token,
      ats: ref.ats,
      token: ref.token,
      careersUrl: '',
      sources: [],
      firstSeen: today(),
    };
    for (const k of ['site', 'host', 'region']) if (ref[k] && !entry[k]) entry[k] = ref[k];
    // A real company name beats the URL slug (or a job title saved by mistake).
    const roleLike = (v) => /\b(engineer|developer|sde|intern|manager|analyst|designer|architect)\b/i.test(String(v || ''));
    if (name && !roleLike(name) && (!entry.name || entry.name === entry.token || roleLike(entry.name))) entry.name = name;
    if (careersUrl && !entry.careersUrl) entry.careersUrl = careersUrl;
    if (source && !entry.sources.includes(source)) entry.sources.push(source);
    entry.lastSeen = today();
    data.companies[key] = entry;
    if (persist) save();
    return { entry, isNew: !prev };
  }

  /** Record what a board read found. */
  function markChecked(ref, { openings = 0, indiaOpenings = 0, relevant = 0, error = '' } = {}) {
    ensure();
    const entry = data.companies[keyOf(ref)];
    if (!entry) return;
    Object.assign(entry, { lastChecked: today(), openings, indiaOpenings, relevant });
    if (error) entry.lastError = error;
    else delete entry.lastError;
  }

  function list() {
    ensure();
    return Object.values(data.companies);
  }

  function get(ref) {
    ensure();
    return data.companies[keyOf(ref)] || null;
  }

  return { load, save, upsert, markChecked, list, get, keyOf, file };
}

const defaultDirectory = createDirectory();

module.exports = { createDirectory, ...defaultDirectory, keyOf };
