# jobman 🤖

Automated daily job-search-and-apply bot for **Shivaji Mandapati** — React Native / Mobile / Full-stack roles across India.

## Status
Project scaffold + spec, handed over from a Cowork session. **Implementation pending — built to be finished by Claude Code.**

Already done in the Cowork session:
- 2 applications submitted on Naukri (logged in `data/applied_jobs_log.csv`)
- Instahyre automation approach proven (`docs/phase1-instahyre-automation.md`)
- 15 portals researched (`docs/job-portals-research.md`)

## Hand over to Claude Code

```bash
cd ~/Desktop/jobman
claude
```

Then just say:

> Read CLAUDE.md and implement the bot. Start with core/ (filter, dedup, browser, reporter), then the Instahyre and Naukri bots, then the CLI and scheduler. Write tests for filter.js and dedup.js. Use --dry-run to verify before any real applications.

Claude Code will pick up `CLAUDE.md` automatically for full context.

## Usage (once built)

```bash
npm install
npm run apply:dry            # dry run — no real applications
npm run apply                # run all portals now
node src/index.js run naukri # single portal
npm run schedule             # daemon: daily 7:00 AM IST
npm run report               # today's report
```

## Layout
```
CLAUDE.md        # build spec for Claude Code (start here)
config/          # candidate profile
data/            # applied_jobs_log.csv (persistent dedup)
docs/            # research & findings from the Cowork session
reports/         # daily run reports (generated)
src/             # code (stubs with TODOs)
```

## Safety rules (non-negotiable)
- Never enters passwords/credentials — user logs in manually once (persistent Chrome profile)
- Never solves CAPTCHAs — skips and logs
- Never fabricates salary, certifications, or experience in application answers
- Dedup log is appended after every attempt, never batched
