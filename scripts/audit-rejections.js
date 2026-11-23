#!/usr/bin/env node
/**
 * Audit role/stack rejections from a past run (data/run-state/checkpoint.json):
 *
 *   1. what each "score N below threshold" / "role rejected" decision rested on —
 *      a definitive rule (seniority title, .NET, …) or only a listing card
 *   2. for card-only decisions on role-family titles: fetch the full description
 *      (HTTP by default; --browser also uses the bot's logged-in Chrome for Naukri,
 *      Wellfound, Instahyre, Foundit) and re-decide with the SAME rules
 *   3. write reports/audit-rejections-<date>.md with counts and examples
 *
 * Read-only on job sites: no clicks, no applications. Respects verification pages
 * (a host that shows one is skipped for the rest of the audit).
 *
 *   node scripts/audit-rejections.js [--date=2026-11-09] [--browser] [--limit=400]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { evaluateJob, isRoleFamily, evidenceSnippets } = require('../src/core/evaluate');
const { hardReject, stackBalance } = require('../src/core/filter');
const { createEnricher } = require('../src/core/enrich');
const { mapLimit } = require('../src/core/concurrency');

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const useBrowser = process.argv.includes('--browser');
const limit = Number(arg('limit', 1000));
const ROOT = path.join(__dirname, '..');

async function main() {
  const cpFile = path.join(ROOT, 'data', 'run-state', 'checkpoint.json');
  const cp = JSON.parse(fs.readFileSync(cpFile, 'utf8'));
  const date = arg('date', cp.date);
  if (cp.date !== date) throw new Error(`checkpoint is for ${cp.date}, not ${date}`);

  // ---- 1. classify every role/stack rejection by what it rested on ----
  const rows = [];
  for (const [portal, st] of Object.entries(cp.portals)) {
    for (const e of st.result?.skipped || []) {
      if (!/score|role rejected/.test(e.reason || '')) continue;
      const cardText = [e.description, e.text].filter(Boolean).join(' ');
      const hard = hardReject({ title: e.title, description: cardText });
      const card = evaluateJob({ title: e.title, description: cardText, source: 'card' });
      let basis;
      if (hard && hard.basis !== 'absence') basis = `definitive: ${hard.reason}`;
      else if (card.decision === 'needs_enrichment') basis = 'card-only, role-family title';
      else if (card.decision === 'eligible') basis = 'card now eligible (title-tier fix)';
      else basis = 'card-only, title outside role family';
      rows.push({ portal, ...e, cardText, card, basis, hard });
    }
  }
  const byBasis = {};
  for (const r of rows) byBasis[r.basis.replace(/:.*/, '')] = (byBasis[r.basis.replace(/:.*/, '')] || 0) + 1;

  // ---- 2. enrich the uncertain ones ----
  const uncertain = rows.filter((r) => r.card.decision !== 'rejected').slice(0, limit);
  let launch = null;
  if (useBrowser) {
    launch = await require('../src/core/browser').launch();
  }
  const enricher = createEnricher({ newPage: launch ? launch.newPage : null, cacheFile: path.join(ROOT, 'data', 'jd-cache.json') });
  let done = 0;
  await mapLimit(uncertain, 6, async (r) => {
    const res = await enricher.enrich({ url: r.url });
    r.enrich = res;
    if (res.ok) {
      const v = evaluateJob({ title: r.title, description: res.text, source: 'full', postedDaysAgo: res.postedDaysAgo ?? undefined });
      r.full = v;
      r.snippets = evidenceSnippets(res.text, 3);
      r.balance = stackBalance(res.text);
    }
    if (++done % 25 === 0) process.stderr.write(`  ${done}/${uncertain.length} checked\n`);
  });
  enricher.flush();
  // Attached to a Chrome you already have open (e.g. manual-apply tabs from a run)? Only detach.
  if (launch) await (launch.browser.__jobmanAttached ? Promise.resolve(launch.browser.disconnect()) : launch.browser.close()).catch(() => {});

  // ---- 3. report ----
  const fetched = uncertain.filter((r) => r.enrich?.ok);
  const corrected = fetched.filter((r) => r.full.decision === 'eligible');
  const strong = corrected.filter((r) => r.balance.dominant === 'ours');
  const confirmed = fetched.filter((r) => r.full.decision === 'rejected');
  const unavailable = uncertain.filter((r) => !r.enrich?.ok);
  const why = {};
  for (const r of unavailable) {
    const k = r.enrich?.blocked ? `blocked (${String(r.enrich.blocked).slice(0, 40)})` : r.enrich?.error || 'n/a';
    const host = (() => { try { return new URL(r.url).hostname.replace(/^www\./, ''); } catch { return '?'; } })();
    why[`${host}: ${k}`] = (why[`${host}: ${k}`] || 0) + 1;
  }
  const confirmedWhy = {};
  for (const r of confirmed) {
    const k = r.full.category === 'experience' ? 'experience out of range' : r.full.category === 'stale' ? 'stale' : r.full.rule ? `rule: ${r.full.rule}` : 'stack not ours (full description)';
    confirmedWhy[k] = (confirmedWhy[k] || 0) + 1;
  }

  const L = [];
  L.push(`# Rejection audit — run of ${date}`, '');
  L.push(`Source: \`data/run-state/checkpoint.json\` (the final ${date} run). Rules are unchanged; only the evidence differs.`, '');
  L.push('## 1. What the role/stack rejections rested on', '');
  L.push('| Basis | Records |', '|---|---|');
  for (const [k, v] of Object.entries(byBasis).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);
  L.push(`| **Total role/stack rejections** | **${rows.length}** |`, '');
  L.push('No rejected record stored the text it was scored on; on 7 of 9 boards that text was the listing card only (title + snippet). Full descriptions were fetched only by the careers channel (employer ATS APIs) and by LinkedIn *after* a card had already passed.', '');
  L.push('## 2. Full-description re-check of the uncertain ones', '');
  L.push(`Checked ${uncertain.length} card-only rejections with role-family titles (${useBrowser ? 'HTTP + logged-in browser' : 'HTTP only — Naukri / Wellfound / Instahyre / Foundit need `--browser`'}).`, '');
  L.push('| Outcome | Records |', '|---|---|');
  L.push(`| Description read | ${fetched.length} |`);
  L.push(`| → **incorrectly rejected — eligible on the full description** | **${corrected.length}** (${strong.length} with React/Node/RN as the main stack, ${corrected.length - strong.length} flagged: another stack dominates) |`);
  L.push(`| → rejection confirmed on the full description | ${confirmed.length} |`);
  L.push(`| Description not accessible → now "needs enrichment", not "rejected" | ${unavailable.length} |`, '');
  if (Object.keys(confirmedWhy).length) L.push(`Confirmed rejections, by reason: ${Object.entries(confirmedWhy).map(([k, v]) => `${k} ${v}`).join(' · ')}`, '');
  if (unavailable.some((r) => /wellfound\.com\/jobs\/\d+$/.test(r.url))) L.push('Wellfound records were stored under the id-only URL `wellfound.com/jobs/<id>`, which returns 404 — the real page needs its slug. Those decisions cannot be re-checked retroactively; the bot now keeps the slugged link (`detailUrl`) for detail fetches and applications.', '');
  if (Object.keys(why).length) L.push(`Not accessible, by host/reason: ${Object.entries(why).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(' · ')}`, '');

  L.push('## 3. Incorrectly rejected jobs (corrected decisions)', '');
  if (!corrected.length) L.push('_None among the descriptions that could be read._', '');
  for (const r of [...strong, ...corrected.filter((x) => !strong.includes(x))].slice(0, 40)) {
    L.push(`### ${r.title} — ${r.company} (${r.portal})`, '');
    L.push(`- URL: ${r.url}`);
    L.push(`- Nov 9 decision: rejected — \`${r.reason}\` (listing card)`);
    L.push(`- Corrected: **eligible** — ${r.full.reason} · description via ${r.enrich.via}${r.enrich.postedDaysAgo != null ? ` · posted ${r.enrich.postedDaysAgo} d ago` : ''}`);
    L.push(`- Stack in the description: ${r.balance.js} React/Node/TS/RN mentions vs ${r.balance.competing} other (${r.balance.top.join(', ') || 'none'})${r.balance.dominant === 'other' ? ' — ⚠ flagged in the approval queue' : ''}`);
    for (const s of r.snippets || []) L.push(`  > ${s.slice(0, 220)}`);
    L.push('');
  }
  L.push('## 4. Rejections confirmed by the full description (examples)', '');
  for (const r of confirmed.slice(0, 15)) L.push(`- **${r.title}** — ${r.company} (${r.portal}) — ${r.full.reason} — ${r.url}`);
  L.push('', '## 5. Still uncertain (description not accessible)', '');
  for (const r of unavailable.slice(0, 15)) L.push(`- **${r.title}** — ${r.company} (${r.portal}) — ${r.enrich?.blocked || r.enrich?.error} — ${r.url}`);
  L.push('');

  const out = path.join(ROOT, 'reports', `audit-rejections-${date}.md`);
  fs.writeFileSync(out, `${L.join('\n')}\n`);
  fs.writeFileSync(path.join(ROOT, 'reports', `audit-rejections-${date}.json`), JSON.stringify({ byBasis, total: rows.length, checked: uncertain.length, fetched: fetched.length, corrected: corrected.map((r) => ({ portal: r.portal, title: r.title, company: r.company, url: r.url, was: r.reason, now: r.full.reason, via: r.enrich.via, stack: r.balance })), strong: strong.length, confirmed: confirmed.length, unavailable: unavailable.length, unavailableWhy: why }, null, 1));
  console.log(`${rows.length} role/stack rejections · basis ${JSON.stringify(byBasis)}`);
  console.log(`checked ${uncertain.length} · read ${fetched.length} · corrected ${corrected.length} · confirmed ${confirmed.length} · unavailable ${unavailable.length}`);
  console.log(`→ ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
