# jobman — Automated Job Application Bot

## What this project is
Daily automated job-search-and-apply bot for **Shivaji Mandapati** (React Native / Mobile / Full-stack, 2.5+ yrs, India). It searches job portals, filters roles matching his profile, auto-applies, dedups against a CSV log, and generates daily reports.

## Current state (handover from Cowork session, 2026-07-24)
- ✅ 2 applications already submitted manually via browser automation (Naukri — see `data/applied_jobs_log.csv`)
- ✅ Instahyre modal issue solved: plain JS `button.click()` works (see `docs/phase1-instahyre-automation.md`)
- ✅ 15 portals researched and prioritized (see `docs/job-portals-research.md`)
- ❌ No working Node.js code yet — **that's your job**

## Your task (Claude Code)
Build the scheduler bot described below. Work through TODOs in `src/`. The stubs define the intended architecture — implement them.

### Requirements
1. **Daily run at 7:00 AM IST** (node-cron), plus on-demand CLI: `npm run apply -- --portal=instahyre`
2. **Portals (priority order):** Instahyre → Naukri → LinkedIn → YourStory. One module per portal in `src/bots/`.
3. **Browser automation:** Puppeteer with persistent user-data-dir (`.chrome-profile/`) so logins survive restarts. Assume the user logs in manually once.
4. **Candidate profile:** read from `config/candidate.json` — use for form filling. Never fabricate salary/certs.
5. **Filtering:** target React Native / React / Mobile / Node full-stack roles, 1.5–3.5 yrs (accept postings whose range overlaps). Skip pure native iOS/Android, .NET, Java-only, 5+ yr minimums.
6. **Dedup:** before applying, check `data/applied_jobs_log.csv` by job_url. Append immediately after every attempt (applied/skipped/failed) — never batch.
7. **Reports:** write `reports/YYYY-MM-DD.md` per run: totals, per-portal breakdown, applied list, skipped/failed with reasons.
8. **Safety rails:**
   - Never enter passwords/credentials — if session is logged out, log "skipped — login required" and move on
   - Never answer CAPTCHAs — skip and log
   - 2–3s delay between applications (rate-limit protection)
   - Retry failed applications once, then log as failed
9. **Error handling:** one portal crashing must not kill the run. Wrap each portal in try/catch, continue.

### Suggested structure (stubs already in place)
```
src/
  index.js          # CLI entry (commander): run-all | run <portal> | schedule | report
  scheduler.js      # node-cron 7:00 AM IST wiring
  bots/
    instahyre.js    # TODO — use the JS-click approach from docs/phase1
    naukri.js       # TODO — search, skip CTC modal via "Skip this question"
    linkedin.js     # TODO — Easy Apply only
    yourstory.js    # TODO
  core/
    browser.js      # Puppeteer launch/profile helper
    dedup.js        # CSV read/append (job_url keyed)
    filter.js       # role-matching logic (title + description scoring)
    reporter.js     # daily markdown report writer
config/
  candidate.json    # profile data (already filled in)
data/
  applied_jobs_log.csv  # persistent dedup log (already seeded with 2 rows)
reports/            # daily reports output
docs/               # research + automation notes from the Cowork session
```

### Verification
- `npm test` should run unit tests for `filter.js` and `dedup.js` at minimum
- A `--dry-run` flag on every command: does everything except click Apply, logs what it *would* do

## Conventions
- Node 18+, CommonJS or ESM (your pick, be consistent)
- No TypeScript needed
- Keep secrets in `.env` (gitignored); `.env.example` documents keys
