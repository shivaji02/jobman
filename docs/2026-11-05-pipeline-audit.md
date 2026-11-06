# Jobman pipeline audit — 2026-11-05

**Goal:** more *confirmed* relevant applications, not more listings discovered.
**Starting point (morning run, 2026-11-05):** 5,853 "reviewed" → 1 confirmed, 2 "failed", 2 manual,
4,481 skipped, **1,367 unexplained**.

---

## 1. Pipeline trace

```
discover (search pages / ATS APIs)
  → admit()          duplicate this run? already in log? same role applied on another portal? failed ≥2×?
  → filter           location → experience → role/tech score (+ shared hard rejects)
  → apply attempt    portal flow, screening answers from candidate.json only
  → submit           click Submit / Apply (tracked: `submitted = true`)
  → confirmation     portal-shown success signal → screenshot + signal = evidence
  → disposition      exactly one of 10 final states, appended to the CSV immediately
  → report           funnel reconciled: discovered − duplicates − out-of-scope = reviewed = Σ dispositions
```

## 2. Root causes (with evidence)

| # | Where | Root cause | Evidence | Effect |
|---|---|---|---|---|
| R1 | `core/dedup.js` | `normalizeJobUrl` stripped **all** query params. Indeed keys jobs only by `?jk=` → every Indeed job became `https://in.indeed.com/viewjob`. One manual-apply row (11-04) made `dedup.has()` true for *every* Indeed job. | 74 Indeed rows in the log, all with the same URL; 11-05 log: 347 cards, 0 outcomes | **Indeed: 347 reviewed, 0 processed** |
| R2 | every bot | `reviewed += cards.length` counted each card once **per search** (8 cities × 5–7 queries), and dedup hits did a bare `continue` with no disposition. | Naukri 708 reviewed vs 277 dispositioned; Talent 735/354; Wellfound 278/97; Indeed 347/0 | **1,367 unexplained** listings |
| R3 | `bots/linkedin.js` | LinkedIn moved `/jobs/search/` → `/jobs/search-results/` (11-04). Card selectors `[data-occludable-job-id]` no longer exist; cards are `[componentkey="job-card-component-ref-<id>"]`. Easy Apply now renders in a native `<dialog data-testid="dialog">`, not `[role=dialog]`. | Logs: 112/112 searches on 11-04 and 56/56 on 11-05 returned 0 cards; worked through 11-03 | **LinkedIn: 0 results** |
| R4 | `bots/careers.js` | Greenhouse/Lever/Ashby boards return every opening worldwide; each was "reviewed then skipped". | 2,593 "not in a south India city" + 741 "remote-only" of 3,624 | 3,624 skipped, inflating review counts; no real candidates lost |
| R5 | `bots/naukri.js` | Already-applied jobs render `<span id="already-applied">Applied</span>`; the detector only scanned `button, a, [role=button]` → "Apply button not found" → `failed` → retried next run, forever. | 518 of 571 Naukri failures; two sampled jobs both show "Applied" live | Bulk false failures, wasted tabs/time |
| R6 | `bots/naukri.js` | After clicking Apply + screening it returned `applied` **optimistically**, even if a screening question was left unanswered. | `// Optimistic: form filled + apply clicked` | 172 historical Naukri "applied" rows are unverified |
| R7 | foundit / instahyre / indeed / wellfound / linkedin | Retry loops re-clicked Apply after an *uncertain* submit ("apply not confirmed", "No Applied confirmation", exception after Submit), and "no confirmation" was logged `failed`, which the next run retries. | Code paths; Foundit "apply not confirmed" rows | **Duplicate-application risk** |
| R8 | `bots/indeed.js` | The smartapply flow takes 5–8 s to render; the walker looked after 1.2 s, saw no button and handed off "unrecognised apply step". Apply also navigated the *results* tab away. | Live: `resume-selection-module` step has `data-testid="continue-button"`, pre-selected resume | Every Indeed Apply became manual |
| R9 | `bots/instahyre.js` | Search button renamed "Show results" → "Search"; fallback was a 3-job recommended list. Confirmation was `body.includes('Applied')` (true on almost any page). | Log 11-05: "Show results button not found"; live page | Instahyre: 3 jobs/run |
| R10 | all bots | Resume paths hard-coded to `/Users/neosoft/Downloads/Resumes/…` (another machine) and `ShivajiPresidio.pdf` (doesn't exist). | `ls` | Resume uploads silently attached nothing |
| R11 | linkedin / naukri / wellfound screening | **Fabrication risk:** LinkedIn filled total years into *any* "experience/years" field (e.g. "years with Kubernetes"); Naukri raised experience to 3 for mid-level posts, answered **current** CTC with expected CTC (or hard-coded 15-20 LPA), "current location" with Hyderabad, and "Yes" to anything containing *agree/comfortable/willing*; Wellfound used `Math.round(2.7)=3`. Also, LinkedIn wrote `el.value=` which React ignores. Phone number was never filled. | Code; 132 log rows blocked on screening: 93 skill-years, 34 phone, ~60 CTC/notice | Blocked or misrepresented applications |
| R12 | linkedin | LinkedIn's title scoring accepted "Lead Mobile developer, .NET Xamarin" — no shared hard rejects; titles like "(9+ Yrs)" not parsed. | Dry-run output | Irrelevant would-apply candidates |
| R13 | runner | A CAPTCHA/login stop mid-portal discarded everything that portal had done from the report. | `return emptyResults(...)` | Under-reporting |
| R14 | dedup log | Identical `skipped` rows re-appended daily (one Wellfound job 91×). | 17,638 rows for 3,318 unique jobs | Log bloat (3.3 MB) |

## 3. Fixes implemented

**Identity & dedup** (`core/dedup.js`)
- Identity query params kept per host (`indeed: jk/vjk`, `talent: id`, `greenhouse: gh_jid`); LinkedIn `currentJobId` / `/jobs/view/<id>` canonicalised; legacy identity-less Indeed rows ignored.
- Blocking statuses: `applied`, **`unconfirmed`** (new), `manual-apply` → never resubmitted.
- Cross-run bounded retries: a job `failed` 2× is handed to you (`priorDisposition → exhausted`).
- Cross-portal fingerprint (company + title, 45 days): a role applied on Naukri isn't re-applied via Talent/Foundit.
- Identical repeat `skipped` rows are no longer appended.

**Dispositions & reconciliation** (`core/disposition.js`, `core/reporter.js`, `core/summary.js`)
- 10 mutually exclusive final dispositions: `applied_confirmed`, `would_apply`, `applied_unconfirmed`, `already_applied`, `manual_required`, `failed_technical`, `rejected_location`, `rejected_experience`, `rejected_role`, `deferred_cap`.
- `admit()` gate used by every bot: counts duplicates separately, records already-applied explicitly.
- Funnel: `discovered − duplicates − outOfScope = reviewed = Σ dispositions`; any gap is printed as ⚠ UNACCOUNTED.
- Bots attach `err.partialResults` so a mid-portal stop still reports what was done.

**Confirmation evidence** (`core/evidence.js`)
- `applied` requires a portal-shown signal (success text or Applied state). A screenshot goes to `data/evidence/<date>/`; the signal and path go into the CSV note and the report.
- Submit clicked but no signal → `unconfirmed` (blocking). Retries happen only when nothing was submitted.

**Discovery**
- LinkedIn: new card extraction, scroll container, up to 3 result pages, `<dialog>` support.
- Instahyre: "Search" button. Naukri: `experience=3` in the search URL (pushes experience filter into discovery).
- Careers: India + software-title pre-filter at discovery (`outOfScope`), transient retry for board API timeouts.
- Indeed: decoy `data-jk` nodes ignored (only visible cards with a 16-hex key).
- Priority: aggregator Talent.com now runs after the direct boards it syndicates.

**Apply flows**
- Indeed: each job in its own tab; waits for each smartapply step; answers from profile; detects stuck steps, CAPTCHA, OTP.
- Naukri: `#already-applied` detection; success required (toast or `#already-applied`, re-checked after reload); unanswered drawer question → needs you.
- LinkedIn: React-safe value setter, radio/select handling, resume choice, `unconfirmed` vs `failed`.
- Foundit/Instahyre/Wellfound/Talent: no re-click after an uncertain submit; strict success signals.
- Resumes: `core/resume.js` → `~/Downloads/Resumes/{shivajirn02,shivajifs02,shivajife02}.pdf` (or `candidate.json → resumes`).

**Screening answers** (`core/screening.js`, used by LinkedIn + Indeed; Naukri/Wellfound fixed in place)
- Only from `candidate.json`. Phone, email, notice (0 → "Immediate"/0), expected CTC (lakhs for numeric fields), relocation, immediate joining, total years (rounded **down**).
- Skill-years only from `skill_years` (new, empty — **you fill it**). Current CTC only from `current_ctc` (empty — **you fill it**). Current location only from `current_location`.
- Blanket "Yes" to willingness/agreements only with `screening_defaults.answer_yes_to_willingness: true`.
- Shared hard rejects now also gate LinkedIn; `.NET` without the dot and "(9+ Yrs)" titles rejected.

**Ops**
- If a jobman Chrome is already open (manual tabs pending), runs attach to it instead of killing it.
- `run-all --portals=a,b`, `JOBMAN_CITIES=hyderabad,bangalore`, `JOBMAN_MAX_APPS=N`.

## 4. Tests

`npm test` → **98 pass, 0 fail** (67 before; new: `tests/funnel.test.js`, `tests/screening.test.js`, filter additions).
They cover the Indeed key regression, LinkedIn URL canonicalisation, unconfirmed blocking, retry exhaustion,
cross-portal fingerprint and expiry, skipped-row de-bloat, classification of real reasons, `admit()`
accounting, reconciliation of the 11-05 Naukri gap, LinkedIn card parsing, the career pre-filter, the Naukri
experience URL, and every screening question pattern seen in the log, including the never-guess cases.

## 5. Live verification (2026-11-05, Hyderabad + Bangalore, capped at 3 applications per portal)

**Dry run, all 9 portals.** 4,550 discovered − 377 duplicate sightings − 3,522 out of scope (career-site
global roles) = **651 unique reviewed = 651 dispositioned (0 unaccounted)**. 34 would-apply, against 1
confirmed in the morning run. Instahyre found 30 jobs (was 3). LinkedIn found 52 cards (was 0) and Indeed
97 (was 0 processed).

**Live run 1** (instahyre, naukri, linkedin, indeed, foundit): 212 discovered → 161 unique.
- ✅ Instahyre **3 confirmed** (Cognizant ×2, Accenture). Evidence: "Application sent" text or the modal's "Applied" button.
- Naukri: 3 marked *unconfirmed* and blocked from resubmission. `scripts/verify-unconfirmed.js` then re-read the job pages:
  **2 confirmed** (Keyblocks — Mobile Developer; Providence — Full Stack Go+React, both `#already-applied`) and 1 *verified not applied*.
- LinkedIn: 9 × "never reached Submit". Cause: the dialog renders its header first; fixed by waiting for the footer action.
- Indeed: crashed on a missing import. The reconciliation check flagged it as **1 UNACCOUNTED** in the summary, which is how it was spotted. Fixed.

**Live run 2** (naukri, linkedin, indeed): 244 discovered → 132 unique = **132 dispositioned ✓**.
- ✅ LinkedIn **3 confirmed** (Anytime Diesel — Full Stack Developer; Scoutit — Frontend Developer; Impact Makers —
  Full Stack Engineer). Each has a screenshot showing LinkedIn's "Application status: Application submitted".
- Needs you (7): 2 external ATS (SmartRecruiters, Recruitee), and 4 screening forms asking for skill-years /
  current CTC / current location that the profile doesn't hold. These were left unanswered, not guessed.
- Naukri: 3 *verified not applied* (Apply click didn't register; eligible for one bounded retry) and 1 page with no Apply control.

**Naukri follow-up (Apply clicks not registering).** A network capture showed two separate causes:
1. **The click fired before the page was ready.** It landed before Naukri's click handlers were attached and was dropped silently. A click after the page finished loading
   went through: the apply API (`apply-workflow/v1/apply`) replied *"You have successfully applied to this job."* (Talent Bee — confirmed).
2. **Mandatory questionnaires.** Infosys/Epam/Synechron reply with a questionnaire (skill-years, Saturday interview slot,
   in-person round dates, current CTC, last working date). The old drawer handler didn't recognise these questions and quit silently.
Fix: wait for the page to load, click with the mouse, and treat the **apply-API reply as proof**. A 200 + success message = confirmed
(the evidence note includes the daily quota). No API call = nothing submitted, so one re-click is safe. A questionnaire is
checked against the profile up front, and the missing answers are named. The quota limit (**50 / day**) stops the portal cleanly.
Two more capped Naukri runs (311 unique jobs, 0 unaccounted) left today's eligible Naukri pool fully handled. The
remaining eligible jobs all need answers only you can give (see §6).

**Confirmed applications with evidence: 9** (3 Instahyre, 3 Naukri, 3 LinkedIn), against 1 in the morning run.
Screenshots are in `data/evidence/2026-11-05/`, and each signal is in the CSV notes.

### Known remaining issues
- ~~Naukri Apply sometimes doesn't register~~ — fixed (page-load wait + apply-API proof; questionnaires checked up front).
- Naukri questionnaires often ask for interview slots ("available Saturday?", "in-person round on Friday?"). These are always handed to you.
- A job that `failed` twice is handed off *before* its page is opened, so an already-applied Naukri job that
  failed earlier shows as "needs you" rather than "already applied" (seen once: Infosys "React, NodeJS, DevOps, AWS").
- Foundit returned 0 eligible jobs: 69 of 70 were rejected for experience or role. Its search URL has no experience filter (format unverified).
- ~~Careers boards produced no South-India matches~~ — superseded by §7 (direct employer channel with ATS auto-apply).
- Indeed Apply ran as far as the questions step and stopped correctly at unknown answers. A full Indeed submission hasn't been observed yet.

## 6. What still needs you

1. **`config/candidate.json → skill_years`** — 93 past applications stalled on "years with <skill>". Fill real values.
2. **`current_ctc`** — ~60 stalls. Leave empty if you prefer to answer each time.
3. **`current_location`** — some forms ask; your LinkedIn profile says Navi Mumbai.
5. **Employer forms (§7):** `linkedin_url`, `current_location`, `custom_answers` (your own words for "reason for change" etc.), and
   `consents.privacy_and_terms` (only if you want privacy-notice boxes ticked for you). These four unlock most Greenhouse/Lever forms.
4. The 172 historical Naukri "applied" rows were never verified. Check Naukri → *Applied jobs* if it matters.

## 7. Google discovery + direct employer applications (added 2026-11-05, afternoon)

**What was built**
| Piece | File | What it does |
|---|---|---|
| Search | `src/core/websearch.js` | serper.dev or Google CSE if keyed, else google.com in the jobman Chrome at a human pace. A CAPTCHA stops searching for the run and is never solved. |
| Discovery | `src/core/discovery.js`, `src/bots/google.js` | The brief's 14 targeted queries (ATS `site:` + open-web careers), 7 per run in rotation, with the last-month date filter. Results are classified as ATS posting / ATS board / custom careers page / aggregator / noise. Custom pages are fetched once for an embedded ATS or a schema.org `JobPosting`. Results are kept as **leads for 14 days**, so a blocked run still works. |
| ATS readers | `src/core/ats.js` | Greenhouse, Lever (incl. EU), Ashby, SmartRecruiters (India-only, server-side), Workday (CXS search, server-side). `fetchPosting()` re-reads every posting from the ATS, which proves it is open and supplies the **real JD and posted date**. |
| Company directory | `src/core/companies.js` → `data/companies.json` | Seeded from `config/careers.json` and grown by discovery. Stores name, ATS, token, sources, first/last seen, openings, India openings. |
| Pipeline | `src/core/direct.js` | dedup → freshness (≤30 days) → location (south-India city required; "India" accepted only if the JD names one) → experience parsed from the JD → role score → cap → resume → adapter → CSV row + `data/direct_applications.jsonl` record (source, official URL, ATS, resume, timestamp, disposition, evidence/reason). |
| Adapters | `src/ats/index.js`, `form.js`, `answers.js` | Generic form engine: labels, text/select/radio/checkbox/react-select/yes-no/file/location-autocomplete, read-back of required fields, CAPTCHA detection. Greenhouse, Lever, Ashby: fill + single submit + success proof. SmartRecruiters: hand-off (shadow-DOM form). Workday: hand-off (needs a candidate account; jobman never creates accounts or enters passwords). |
| Dedup across channels | `canonicalAtsUrl()` in `normalizeJobUrl` | One key per ATS posting whether it came from Google, a portal redirect, `/apply`, an embed or a careers board. Plus the company+title fingerprint against LinkedIn/Naukri/etc. (company+title is stricter than company+title+location, so it never lets a duplicate through). Google and careers share a per-run set, so neither redoes the other's jobs. |
| Priority | `src/runner.js` | `google` then `careers` run first, back to back in one worker, then the portals. |
| Report | `src/core/reporter.js` | New "Direct employer channel" section: Google discovery stats, then one row per direct application. |

**Answers are never invented** (`src/ats/answers.js`). Identity fields come from the profile verbatim. Screening questions go through `core/screening`. Essays are answered only from `custom_answers`. Consent boxes are ticked only with `consents.privacy_and_terms: true`. Demographic questions are left blank, or "decline" when required. Anything else that is required is handed to you, with the form pre-filled and the tab left open.

**Tests:** `tests/ats.test.js` (14 tests). They cover URL parsing for every ATS, canonical keys, cross-channel blocking, embedded-ATS and JSON-LD detection, result classification, company naming, JD experience/freshness, `screenPosting` rules, the honest-answer rules, and the directory. `npm test` → **113 pass, 0 fail**.

**Live validation (small, controlled)**
- Google discovery: 13 live searches returned 83 results. Of those, 48 were employer postings (5 ATS types), 31 aggregator/reposting results were dropped, 5 were custom careers pages and 2 were noise. Re-reading the postings showed **7 were closed** (e.g. Toast, 6sense, Point72), which is why indexed jobs are never assumed open. On the 14th query **Google showed its unusual-traffic page**. The bot stopped, didn't solve it, and the block was still on hours later. That led to the 7-query rotation, 8–15 s pacing and saved leads.
- Filters on real JDs: Capco "React Developer" (5+ yrs), Merge Money (7+), BitGo (4+), Hitachi (7), Eltropy (6–15) and PhonePe "SE – React Native" (5–8) were all rejected on experience stated in the JD. Their titles alone would have passed.
- Careers channel: 57 boards, 6,612 openings → 536 in India → 471 unique reviewed = 471 dispositioned (0 gap).
- ✅ **2 confirmed direct applications** (Ashby, capped run `JOBMAN_MAX_APPS=2`): AiPrise — *Software Engineer II, Frontend* (FE resume) and *Software Engineer II, Full Stack (Frontend Focused)* (FS resume), both Bengaluru. Evidence: Ashby's "Your application was successfully submitted" (screenshots `data/evidence/2026-11-05/ashby-*.png`).
- Hand-offs, correctly not submitted: 2 Workday (ABC Fitness, Hyderabad — account required); Smartsheet Greenhouse (needs location, privacy notice, referral, current CTC, required demographics); 1 custom careers page without an ATS (HBSPL).
- Re-run of both channels: AiPrise appeared via Google leads *and* the careers board and was "already applied" both times. **0 duplicate submissions.**
- Fill mechanics, dummy values, never submitted: Greenhouse (Capco, 26 questions incl. 11 react-select dropdowns + intl phone), Lever (Neuron 7, 26 incl. location autocomplete) and Ashby (Merge Money, 15 incl. yes/no buttons). **All required fields filled and read back.** Two bugs were found and fixed: dropdown options leaking from the phone country list, and Lever's location field needing a suggestion pick.

**Confirmed today: 11** (9 portals + 2 direct employer).

**Not yet validated live:** a Greenhouse or Lever submission (none today qualified with answers the profile holds), and a successful Google search run after the rate-limit change (still blocked at the time of writing).

## 8. Direct channel, round 2 (2026-11-05, evening)

**What changed**
| Priority | Change | Where |
|---|---|---|
| SmartRecruiters | The form engine now reads **open shadow DOM**: deep `querySelectorAll`, `closest()` across shadow hosts, labels from `<label for>` inside the field's own root, **slot-assigned label text** (`<span slot="label-content">`), and semantic attributes (`formcontrolname`, `data-test`) as a last resort. Puppeteer `>>>` handles reach tagged elements in any root. The adapter is now multi-page: fill → **Next** → wait for the next page to render → fill → Submit, up to 6 pages. Shadow-DOM dropdown options (`<spl-select-option>`), remote city suggestions, uploads that only show the file name, and buttons whose text sits on the `<spl-button>` host are all handled. Closed shadow roots are never forced. | `src/ats/form.js`, `src/ats/index.js` |
| Workday | Session handling, no credentials. The bot opens the posting and reads Workday's header: a visible `utilityButtonSignIn` means no session. The result goes on the job and in the hand-off reason. With a signed-in session (the user signed in once in the jobman Chrome), the tab is left on the application's first step. It never creates an account, never types a password, and never submits Workday's multi-page form without answers it doesn't have. | `src/ats/index.js` (`workdayHandoff`, `workdaySession`) |
| Directory growth without Google | Public ATS board APIs are probed with slug guesses built from (1) ATS links already in the log, (2) companies that posted matching roles on the portals, and (3) the well-known-companies list. A board is added only if it exists **and** lists an Indian opening, and Greenhouse/SmartRecruiters boards must also carry a matching company name. Recruiters, placeholders ("Confidential", "Leading Client") and reposting boards (Turing, Jobgether…) are excluded. Misses are cached for 30 days. Each careers run probes 40 new companies; `npm run directory:grow -- --companies=N` runs a bulk pass. | `src/core/directoryGrowth.js`, `scripts/grow-directory.js` |
| Cached Google leads | Every lead, fresh or saved, is re-read from the employer's **live ATS** before use. Nothing from a snippet or the cache counts as open. Leads the ATS no longer lists are deleted. Leads that are still open get `lastVerifiedOpen`. | `src/bots/google.js` |
| Report | "By ATS" table: eligible (passed every check on the live posting) → submit attempts → confirmed with evidence → unconfirmed → hand-offs → failed → rejected, with **why handed off** grouped into categories (`current_location`, `linkedin_url`, current CTC, consent box, demographic, essay, Workday session, CAPTCHA…). Also shows directory growth and lead drops. | `src/core/reporter.js`, `blockersFrom()` in `src/core/disposition.js` |
| Bug found by the SmartRecruiters test | "Were you previously employed at **PhonePe**?" matched the phone-number rule and would have been answered with the phone number. Identity rules now match whole words only, and never apply to dropdown/choice questions except country and city. Regression test added. | `src/ats/answers.js` |
