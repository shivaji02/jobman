# jobman — Setup & Usage Guide

A bot that automatically searches and applies to job postings on Indian job portals (Instahyre, Naukri, LinkedIn). Runs daily at 7:00 AM IST or on-demand via CLI.

---

## 📋 Prerequisites

- **Node.js** 18+ ([download](https://nodejs.org/))
- **npm** (comes with Node.js)
- A Linux/Mac/Windows terminal (Git Bash on Windows)
- Browser profiles stored locally (Chrome will be auto-managed)

---

## 🚀 Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/shivaji02/jobman.git
cd jobman
npm install
```

### 2. Configure Your Profile

Edit `config/candidate.json` with your details:

```json
{
  "name": "Your Name",
  "email": "your.email@example.com",
  "phone": "+91XXXXXXXXXX",
  "experience_years": 2.5,
  "skills": ["React Native", "React", "Node.js", "TypeScript"],
  "target_roles": [
    "react native developer",
    "mobile developer",
    "frontend engineer react",
    "full stack developer node react"
  ],
  "location_preference": "Remote, India",
  "salary_range": "8-15 LPA"
}
```

### 3. Environment & Login (No Passwords)

Create a `.env` file (optional — only for flags like `HEADLESS`):

```bash
cp .env.example .env
```

**Do not put portal passwords in `.env` or `candidate.json`.** The bot never stores passwords.

Run `npm run login` once to save your browser session. The bot reuses this session for future runs.

See [LEGAL.md](./LEGAL.md) for security notices and Terms-of-Service risks.

### 4. Login to Job Portals (First Time Only)

```bash
npm run login
```

This opens each portal in a browser. Sign in manually, then stop the process (Ctrl+C). Your session cookies are saved under `~/.jobman-profile/` (or the legacy `.chrome-profile/` if you already logged in there).

---

## 💼 Run the Bot

### Apply to All Portals (One-time)

```bash
npm run apply
```

Searches and applies to matching jobs across all portals. Creates a report in `reports/YYYY-MM-DD.md`.

### Apply to Specific Portal

```bash
npm run apply -- --portal=instahyre
npm run apply -- --portal=naukri
npm run apply -- --portal=linkedin
```

### Dry Run (Preview What It Would Do)

```bash
npm run apply -- --dry-run
```

Shows matching jobs and scores without actually clicking Apply.

### Schedule Daily Runs

```bash
npm run schedule
```

Runs automatically every day at 7:00 AM IST. Disable with `npm run schedule:stop`.

### View Reports

```bash
ls reports/
cat reports/2026-07-24.md
```

Each report shows:
- Total jobs reviewed, applied, skipped, failed
- List of jobs applied to
- Reasons for skipped/failed applications
- Application scores

---

## 🎯 How It Works

### Job Filtering

The bot scores each job 0-100 based on:

| Factor | Points | Details |
|---|---|---|
| React Native / Mobile title | +40 | "React Native Developer", "Mobile Developer" |
| React title | +25 | "ReactJS Developer", "React Frontend Engineer" |
| Frontend/Full-stack title | +25 | "Frontend Engineer (React)", "Full Stack (Node+React)" |
| Our tech stack mentioned | +20 | React, React Native, Node, TypeScript |
| Experience overlap | +10 | Your 1.5–3.5 yr range matches posting |
| Unknown experience | +10 | No penalty for missing experience text |

**Hard rejects (-100):**
- Senior/Staff/Lead/Architect titles
- iOS/Android-only roles (without React Native)
- .NET, Java-only, pure backend roles
- Experience minimum > 3.5 years

**Threshold:** Applies to jobs scoring **55+** (tuned to balance volume vs. relevance).

### Deduplication

Before applying, the bot checks `data/applied_jobs_log.csv` to avoid duplicate applications. Logs every attempt immediately (applied/skipped/failed).

### Rate Limiting

- Instahyre: 2–3s delay between applications
- Naukri: 1–2s delay + 2 retry attempts
- LinkedIn: 3–5s delay (Easy Apply only)

---

## 📊 Output & Reports

Each run creates a timestamped report:

```
reports/2026-07-24.md
├─ Totals (Reviewed | Applied | Skipped | Failed)
├─ Instahyre
│  ├─ Applied (3 jobs)
│  ├─ Skipped (6 jobs with scores & reasons)
│  └─ Failed (0 jobs)
├─ Naukri
│  ├─ Applied (4 jobs)
│  ├─ Skipped (65 jobs)
│  └─ Failed (10 jobs with error details)
└─ LinkedIn
   ├─ Applied (0 jobs)
   ├─ Skipped (29 jobs)
   └─ Failed (6 jobs with timeout details)
```

### Understanding Reasons

| Reason | Meaning |
|---|---|
| `score 50 below threshold` | Role matched but didn't score high enough |
| `external ATS (apply on company site)` | Portal doesn't have built-in apply; skip |
| `no Easy Apply` | LinkedIn job has no Easy Apply button |
| `Apply button not found — page buttons [...]` | Job page UI changed or modal didn't load |
| `Navigation timeout of 60000 ms` | Page load took >60s; network issue |

---

## 🔧 Troubleshooting

### "login required — sign in once via `npm run login`"
The bot lost its session. Run `npm run login` again and sign in manually.

### "Apply button not found"
The job portal's UI may have changed, or the page didn't load properly. Check the page buttons listed in the error message.

### LinkedIn applications timeout
LinkedIn's pages load slowly. Try increasing timeout in `src/bots/linkedin.js`:
```javascript
await page.goto(job.url, { waitUntil: 'networkidle2', timeout: 90000 });
```

### "No apply confirmation detected"
The apply flow completed but didn't redirect to a confirmation page. Check the portal manually to verify.

### Bot hangs or crashes
- Check browser process: `ps aux | grep chrome`
- Kill stray Chrome: `pkill -f "chrome|chromium"`
- Restart: `npm run apply`

---

## 📁 Project Structure

```
jobman/
├── config/candidate.json          # Your profile data
├── data/applied_jobs_log.csv      # Dedup log (auto-updated)
├── reports/                       # Daily reports
├── src/
│  ├── index.js                    # CLI entry point
│  ├── scheduler.js                # Daily 7 AM IST schedule
│  ├── bots/
│  │  ├── instahyre.js
│  │  ├── naukri.js
│  │  ├── linkedin.js
│  │  └── yourstory.js
│  └── core/
│     ├── browser.js               # Puppeteer + profile management
│     ├── filter.js                # Job scoring logic
│     ├── dedup.js                 # CSV log reader/writer
│     └── reporter.js              # Report generator
├── tests/                         # Unit tests
└── CLAUDE.md                      # Architecture docs
```

---

## 🧪 Run Tests

```bash
npm test
```

Runs unit tests for job filtering and deduplication logic.

---

## ⚙️ Advanced Config

### Change Application Threshold

Edit `src/core/filter.js`:
```javascript
const DEFAULT_THRESHOLD = 55;  // lower = more apps, higher = more selective
```

### Change Daily Schedule Time

Edit `src/scheduler.js`:
```javascript
const cron = '0 7 * * *';  // 7:00 AM IST, every day
```

### Disable a Portal

Comment out in `src/runner.js`:
```javascript
// await runBot('instahyre', { dedup, profile, ...opts });
```

---

## 📞 Support

- **Logs:** Check console output or `reports/` for detailed error messages
- **Issues:** Open an issue on [GitHub](https://github.com/shivaji02/jobman/issues)
- **Contributions:** PRs welcome for new portals, filter improvements, or bug fixes

---

## 📄 License

MIT — Use freely, modify as needed.

---

**Happy job hunting! 🎯**
