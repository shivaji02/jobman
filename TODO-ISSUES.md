# jobman — Issues & TODOs

## Critical Issues (Must Fix Before Public Release)

### 1. ❌ LinkedIn Bot Failing (6/6 timeout failures)
**Status:** Broken  
**File:** `src/bots/linkedin.js`  
**Problem:** Navigation timeout waiting for Easy Apply modal on job detail pages (60s timeout exceeded on all attempts)  
**Root Cause:** LinkedIn pages load slowly or modal takes >60s to render  
**Solution:**
- [ ] Reduce `waitUntil: 'networkidle2'` to `domcontentloaded` 
- [ ] Add explicit wait for Easy Apply button BEFORE navigating
- [ ] Implement exponential backoff + retry (up to 3 attempts)
- [ ] Lower timeout to 45s for faster page detection
- [ ] Add debug logging to see what's blocking the page

**Expected Result:** LinkedIn should have >50% success rate

---

### 2. ❌ No Error Recovery/Retry Logic
**Files affected:** `src/bots/*.js`, `src/runner.js`  
**Problem:** Single network failure crashes entire bot run  
**Examples:**
- Timeout on one job crashes whole portal search
- Browser crash = all queued applications lost
- No retry for transient errors
  
**Solution:**
- [ ] Wrap each portal in try-catch with graceful degradation
- [ ] Add retry logic: 1st fail = retry once, 2nd fail = skip + log
- [ ] Implement exponential backoff (200ms, 500ms, 1000ms)
- [ ] Kill stray Chrome processes on startup
- [ ] Log all errors to file (not just console)

**Expected Result:** Single job failure won't crash entire run

---

### 3. ❌ No Logging System (Only Console.log)
**Files to create:** `src/core/logger.js`  
**Problem:** Errors only visible in terminal; no record for scheduled runs  
**Solution:**
- [ ] Create Logger class with levels: debug, info, warn, error
- [ ] Log to file: `logs/YYYY-MM-DD.log`
- [ ] Rotate logs weekly (keep last 30 days)
- [ ] Include timestamps, error stacks, context
- [ ] Replace all `console.log/warn` with `logger.info/warn`

**Expected Result:** Every run has timestamped logs in `logs/` dir

---

### 4. ❌ Security: Passwords Stored in Plain Text
**Files affected:** `.env`, `config/candidate.json`  
**Problem:** Credentials visible in plaintext; laptop theft = account takeover  
**Solution:**
- [ ] Never store passwords in `.env` or `.json`
- [ ] Use OAuth tokens instead (LinkedIn) or session-based (Naukri)
- [ ] Implement secure credential storage:
  - macOS: Keychain
  - Linux: Pass / 1Password API
  - Windows: Credential Manager
- [ ] OR: Prompt for password on first run, cache session only
- [ ] Add warning in SETUP.md about security risks

**Expected Result:** No passwords in config files; use sessions instead

---

### 5. ❌ Browser Profile Management Fragile
**File:** `src/core/browser.js`  
**Problem:** Assumes `.chrome-profile/` exists; fails on Windows/Mac with different paths  
**Solution:**
- [ ] Detect OS and use platform-specific paths (process.platform)
- [ ] Create profile directory if missing
- [ ] Handle sandbox restrictions on Linux
- [ ] Test on all 3 platforms (Mac, Linux, Windows)
- [ ] Add fallback for systems without local Chrome

**Expected Result:** Works seamlessly on macOS, Linux, Windows

---

## High Priority Issues (Should Have)

### 6. ❌ YourStory Bot Not Implemented
**File:** `src/bots/yourstory.js` (stub)  
**Problem:** Only `module.exports = { run };` placeholder  
**Solution:**
- [ ] Research YourStory job board structure
- [ ] Implement extractCards() for job listing
- [ ] Implement applyToJob() for application flow
- [ ] Test with 5+ applications
- [ ] Add to runner.js

**Expected Result:** YourStory applies to 3-5 jobs per run

---

### 7. ❌ WellFound Bot Not Implemented
**File:** `src/bots/wellfound.js` (stub)  
**Problem:** Only `module.exports = { run };` placeholder  
**Solution:**
- [ ] Research WellFound (formerly AngelList Talent) API/structure
- [ ] Implement job search & filtering
- [ ] Implement application flow
- [ ] Test with 5+ applications

**Expected Result:** WellFound applies to 3-5 jobs per run

---

### 8. ❌ No CI/CD Pipeline
**Files to create:** `.github/workflows/test.yml`  
**Problem:** No automated testing on push; broken code gets merged  
**Solution:**
- [ ] Create GitHub Actions workflow:
  - Run `npm test` on every push
  - Run linter (ESLint)
  - Check for hardcoded passwords
- [ ] Set main branch protection: require passing checks
- [ ] Add badge to README

**Expected Result:** Broken code caught before merge

---

### 9. ❌ No Config Validation
**File:** `src/core/validate-config.js` (create new)  
**Problem:** Wrong `.env` values = cryptic "login required" errors  
**Solution:**
- [ ] Validate on startup:
  - `.env` exists and has required keys
  - `config/candidate.json` valid JSON + required fields
  - Email formats are valid
  - Experience years in range 0-20
- [ ] Show clear error messages with fixes
- [ ] Fail fast before browser launches

**Expected Result:** User gets helpful error before wasting time

---

### 10. ❌ Hardcoded Values Not Configurable
**Files:** `src/bots/*.js`, `src/core/filter.js`  
**Problem:** Experience range (1.5–3.5), threshold (55), delays hardcoded  
**Solution:**
- [ ] Move to `config/bot-settings.json`:
  ```json
  {
    "filter": {
      "threshold": 55,
      "min_exp": 1.5,
      "max_exp": 3.5
    },
    "delays": {
      "instahyre": [2000, 3000],
      "naukri": [1000, 2000],
      "linkedin": [3000, 5000]
    },
    "max_apps_per_run": { "instahyre": 10, "naukri": 10, "linkedin": 15 }
  }
  ```
- [ ] Load config on startup
- [ ] Use instead of hardcoded values

**Expected Result:** Users can adjust thresholds without code changes

---

### 11. ❌ Tests Are Incomplete
**Files:** `tests/*.test.js`  
**Problem:** Only basic filter & dedup tests; no integration tests  
**Solution:**
- [ ] Add tests for:
  - Each bot's extractCards() function
  - Error handling & retries
  - Logger output
  - Config validation
- [ ] Add integration test (dry-run mode)
- [ ] Aim for 70%+ code coverage

**Expected Result:** `npm test` runs 30+ tests, coverage >70%

---

## Medium Priority Issues (Nice to Have)

### 12. ⚠️ No Documentation on Legal/ToS
**File:** `LEGAL.md` (create new)  
**Problem:** Users don't know if auto-applying violates portal policies  
**Solution:**
- [ ] Add LEGAL.md documenting:
  - Each portal's ToS regarding automation
  - Risks (account ban, IP block)
  - Disclaimer: not liable for bans
- [ ] Link from README & SETUP.md

**Expected Result:** Users understand risks before using

---

### 13. ⚠️ Scheduled Runs Have No Monitoring
**File:** `src/scheduler.js`  
**Problem:** Daily 7 AM run can fail silently; user won't know  
**Solution:**
- [ ] Add health check:
  - Log last successful run to file: `.cache/last-run.json`
  - Alert if no run in 24 hours (optional: email)
  - Command: `npm run status` shows last run time
- [ ] OR: Use external monitoring (e.g., healthchecks.io)

**Expected Result:** User can verify daily run actually happened

---

### 14. ⚠️ No Docker Support
**File:** `Dockerfile`, `docker-compose.yml` (create)  
**Problem:** Setup requires Node, Chrome, manual config on each machine  
**Solution:**
- [ ] Create Dockerfile:
  - Ubuntu + Node 18 + Chrome
  - Mount volumes for config & reports
  - Entry point: `npm run schedule`
- [ ] Create docker-compose.yml for easy `docker-compose up`
- [ ] Add Docker setup instructions to SETUP.md

**Expected Result:** Users can run with single command: `docker-compose up`

---

### 15. ⚠️ Unclear Portal-Specific Errors
**Files:** `src/bots/*.js`  
**Problem:** "Apply button not found" doesn't say which button or why  
**Solution:**
- [ ] Improve error messages:
  - Show actual page title & URL in error
  - List what buttons were found
  - Suggest remediation (e.g., "Try re-login")
  - Example: `"Apply button not found on https://naukri.com/job/123. Found buttons: [Share, Save, Report]. This usually means the page UI changed."`

**Expected Result:** Errors are actionable, not cryptic

---

## Lower Priority Issues (Can Defer)

### 16. 📊 No Dashboard/Analytics
- Could add web UI to view reports, stats
- Not critical for MVP

### 17. 📧 No Email Notifications
- Could email user on successful applications
- Nice-to-have, not essential

### 18. 💾 No Database Tracking
- Currently uses CSV; could use SQLite
- CSV is sufficient for MVP

---

## Summary Statistics

| Priority | Count | Impact |
|---|---|---|
| **Critical** | 5 | Must fix before public release |
| **High** | 6 | Needed for general use |
| **Medium** | 4 | Important but can defer |
| **Low** | 3 | Nice-to-have, post-launch |
| **TOTAL** | **18** | Roadmap for next 2-3 weeks |

---

## Next Steps (in order)

1. **Week 1 (Critical):**
   - [ ] Fix LinkedIn timeouts
   - [ ] Add error recovery & logging
   - [ ] Remove password storage

2. **Week 2 (High):**
   - [ ] Implement YourStory & WellFound
   - [ ] Add config validation
   - [ ] Set up CI/CD

3. **Week 3+ (Medium/Low):**
   - [ ] Docker support
   - [ ] Better error messages
   - [ ] Monitoring & dashboards

---

**Ready to be shared publicly after Week 1 + Week 2 items are complete.**
