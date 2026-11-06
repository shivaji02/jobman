/**
 * Location preference. Pure functions — unit tested in tests/location.test.js.
 *
 * Policy (set by the user, Nov 2026):
 *   - South India only. Hyderabad is always first preference, then Bangalore,
 *     Chennai, then the other southern cities.
 *   - Pune is allowed only for well-known companies (GOOD_COMPANIES below), ranked
 *     after the southern cities.
 *   - Mumbai (and Navi Mumbai / Thane) is excluded completely — if the posting
 *     mentions it anywhere, the job is rejected.
 *   - A posting with an explicit non-southern location is rejected.
 *   - Postings with no location at all are allowed (portal cards often omit it).
 *   - Pure "Remote" is rejected unless it also names a southern city.
 */

// Ordered by preference; lower rank = better. Aliases are matched as whole words.
const SOUTH_CITIES = [
  { name: 'Hyderabad', aliases: ['hyderabad', 'secunderabad', 'hitech city', 'hitec city', 'gachibowli', 'madhapur', 'telangana'] },
  { name: 'Bangalore', aliases: ['bangalore', 'bengaluru', 'karnataka'] },
  { name: 'Chennai', aliases: ['chennai', 'tamil nadu'] },
];

SOUTH_CITIES.push(
  { name: 'Kochi', aliases: ['kochi', 'cochin', 'kerala', 'ernakulam'] },
  { name: 'Coimbatore', aliases: ['coimbatore'] },
  { name: 'Trivandrum', aliases: ['trivandrum', 'thiruvananthapuram', 'technopark'] },
  { name: 'Mysore', aliases: ['mysore', 'mysuru'] },
  { name: 'Visakhapatnam', aliases: ['visakhapatnam', 'vizag', 'andhra pradesh', 'vijayawada', 'amaravati', 'guntur', 'tirupati'] },
  { name: 'Mangalore', aliases: ['mangalore', 'mangaluru'] },
  { name: 'Madurai', aliases: ['madurai'] },
  { name: 'Hubli', aliases: ['hubli', 'hubballi', 'belgaum', 'belagavi'] }
);

const EXCLUDED = ['mumbai', 'navi mumbai', 'thane', 'bombay', 'bkc', 'andheri', 'powai', 'vashi', 'airoli'];

// Pune is accepted only for these companies (case-insensitive whole-word match
// on the company name). Edit freely.
const GOOD_COMPANIES = [
  'google', 'microsoft', 'amazon', 'apple', 'meta', 'adobe', 'atlassian', 'salesforce', 'oracle', 'sap',
  'intuit', 'paypal', 'uber', 'flipkart', 'walmart', 'phonepe', 'razorpay', 'cred', 'zomato', 'swiggy',
  'freshworks', 'zoho', 'thoughtworks', 'nvidia', 'vmware', 'broadcom', 'cisco', 'dell', 'linkedin',
  'mastercard', 'visa', 'goldman sachs', 'jpmorgan', 'jp morgan', 'morgan stanley', 'deutsche bank',
  'barclays', 'citi', 'american express', 'persistent systems', 'zscaler', 'druva', 'bmc', 'cloudera',
  'servicenow', 'workday', 'twilio', 'atlan', 'postman', 'browserstack', 'amdocs', 'nutanix',
];

function isGoodCompany(company) {
  const c = norm(company);
  return !!c && GOOD_COMPANIES.some((g) => has(c, g));
}

// Explicit non-southern cities: reject when found and no southern city is named.
const NON_SOUTH = [
  'delhi', 'new delhi', 'gurgaon', 'gurugram', 'noida', 'ghaziabad', 'faridabad', 'ncr',
  'ahmedabad', 'gandhinagar', 'kolkata', 'jaipur', 'chandigarh', 'mohali', 'lucknow',
  'indore', 'bhopal', 'nagpur', 'surat', 'vadodara', 'bhubaneswar', 'patna', 'ranchi', 'kanpur',
  'dehradun', 'nashik', 'rajkot', 'guwahati', 'goa',
];

function norm(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function has(blob, term) {
  return new RegExp(`(?:^|\\s)${term}(?:\\s|$)`).test(blob);
}

/**
 * Classify free text (card location + description snippet).
 * Returns { allowed, reason, city, rank } — rank 0 is Hyderabad (best);
 * rank is Infinity when no southern city was found.
 */
function classifyLocation(text, company = '') {
  const blob = norm(text);
  if (!blob) return { allowed: true, reason: 'location unknown', city: null, rank: SOUTH_CITIES.length + 1 };

  if (EXCLUDED.some((t) => has(blob, t))) {
    return { allowed: false, reason: 'Mumbai region excluded', city: null, rank: Infinity };
  }

  for (let rank = 0; rank < SOUTH_CITIES.length; rank++) {
    const c = SOUTH_CITIES[rank];
    if (c.aliases.some((a) => has(blob, a))) {
      return { allowed: true, reason: `south india: ${c.name}`, city: c.name, rank };
    }
  }

  if (has(blob, 'pune')) {
    return isGoodCompany(company)
      ? { allowed: true, reason: 'pune (good company)', city: 'Pune', rank: SOUTH_CITIES.length }
      : { allowed: false, reason: 'pune only allowed for good companies', city: null, rank: Infinity };
  }

  const other = NON_SOUTH.find((t) => has(blob, t));
  if (other) return { allowed: false, reason: `location outside south india (${other})`, city: null, rank: Infinity };

  if (/\b(remote|work from home|wfh|anywhere)\b/.test(blob) && blob.length < 60) {
    return { allowed: false, reason: 'remote-only, no south india city', city: null, rank: Infinity };
  }
  return { allowed: true, reason: 'location unknown', city: null, rank: SOUTH_CITIES.length + 1 };
}

/** Stable sort helper: Hyderabad first, then by city preference, unknown last. */
function byLocationPreference(a, b) {
  return classifyLocation(a.location || a.text, a.company).rank - classifyLocation(b.location || b.text, b.company).rank;
}

/** Search cities in preference order, for portals that take a location param. */
// JOBMAN_CITIES=hyderabad,bangalore narrows a run (testing, or a quick daytime pass).
const SEARCH_CITIES = process.env.JOBMAN_CITIES
  ? process.env.JOBMAN_CITIES.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean)
  : ['hyderabad', 'bangalore', 'chennai', 'kochi', 'coimbatore', 'trivandrum', 'visakhapatnam', 'pune'];

module.exports = { classifyLocation, isGoodCompany, GOOD_COMPANIES, byLocationPreference, SEARCH_CITIES, SOUTH_CITIES };
