# jobman 🤖

Automated daily job-search-and-apply bot for **Shivaji Mandapati** — React Native / Mobile / Full-stack roles across India.

## Status
Working: 10 portals, parallel runner, full-description screening, per-job approval queue, verified submissions.

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

## Daily workflow

```bash
npm run parallel             # discover + screen + read full descriptions + prepare (live dashboard)
npm run review               # in another terminal, any time: approve / decline each prepared job
npm run submit               # submit everything you approved (a running `parallel` also picks approvals up within ~10 s)
```

Nothing is ever submitted without your approval of that exact job. Other commands:

```bash
npm run parallel:dry                       # everything except submission; queue goes to data/approvals.dry-run.json
npm run parallel -- --wait-approvals 20    # stay up 20 min after discovery to submit what you approve meanwhile
npm run parallel -- --full-scan            # ignore the description cache (default is incremental)
npm run parallel -- --portals=naukri,linkedin
npm run approvals                          # list pending (--status approved|declined|submitted|all)
npm run approve -- <id> [<id> ...]         # approve specific jobs by id
npm run decline -- <id>
npm run audit:rejections -- --browser      # re-check a run's role/stack rejections on full descriptions
npm run schedule                           # daemon: daily 7:00 AM IST (same pipeline, no dashboard)
npm run report                             # today's report
```

### How a job flows

```
portal bots (discovery, 8 at once) ──offer──▶ enrich (full description, cached) ─▶ evaluate ─▶ prepare ─▶ approval queue
                                                                                                         │ you approve
                                                                     verify (success text + screenshot) ◀─ submit (≤3 in flight, 1 per portal, stall timeout)
```

- A listing card that fails screening only for missing stack/experience detail is **not** rejected: the full
  description is read first. If it can't be read, the job is reported as *insufficient evidence* and re-checked next run.
- Card-eligible jobs are also read in full before preparation (a "Full Stack" card that is Ruby on Rails is caught).
- Hard rules are unchanged: seniority titles, .NET, stated experience outside 1.5–3.5 yrs, Mumbai, stale postings.
- Verification pages (e.g. Indeed's "Just a moment...") pause only that portal; you complete them yourself.

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

See [LEGAL.md](./LEGAL.md) for Terms-of-Service risks and [SETUP.md](./SETUP.md) for install steps.
