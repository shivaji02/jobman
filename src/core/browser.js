/**
 * Puppeteer helper.
 *
 * - headless: false by default (job sites bot-detect headless); HEADLESS=true
 *   env override for CI/testing.
 * - Persistent profile so manual logins survive restarts.
 * - Safety: this module never types credentials. Bots call assertLoggedIn()
 *   and throw SkipPortalError when they hit a login wall or CAPTCHA.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer');
const logger = require('./logger');

const platform = process.platform; // 'darwin' | 'linux' | 'win32'

function getProfilePath() {
  if (process.env.JOBMAN_PROFILE_DIR) {
    const envDir = process.env.JOBMAN_PROFILE_DIR;
    if (!fs.existsSync(envDir)) fs.mkdirSync(envDir, { recursive: true });
    return envDir;
  }

  const homeDir = path.join(os.homedir(), '.jobman-profile');
  const legacyDir = path.join(__dirname, '..', '..', '.chrome-profile');

  // Prefer the cross-platform home dir when it already has a session; otherwise
  // keep using the legacy project-local profile so existing logins survive.
  const hasSession = (dir) => {
    if (!fs.existsSync(dir)) return false;
    const markers = ['Cookies', 'Local State', 'Preferences', path.join('Default', 'Cookies')];
    return markers.some((f) => fs.existsSync(path.join(dir, f)));
  };

  if (hasSession(homeDir)) return homeDir;
  if (hasSession(legacyDir)) return legacyDir;

  if (!fs.existsSync(homeDir)) fs.mkdirSync(homeDir, { recursive: true });
  return homeDir;
}

const PROFILE_DIR = getProfilePath();

/** Thrown when a portal can't be automated safely (login wall, CAPTCHA). */
class SkipPortalError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'SkipPortalError';
  }
}

/**
 * Kill leftover Chromium/Chrome processes that still hold our profile lock.
 * Scoped to our profile path — never kills the user's everyday browser.
 */
function cleanupStrayChromeProcesses() {
  const marker = PROFILE_DIR.replace(/"/g, '');
  try {
    if (platform === 'win32') {
      // Best-effort: PowerShell filter by command line containing our profile dir
      execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'chrome|chromium' -and $_.CommandLine -like '*${marker.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'ignore', timeout: 8000 }
      );
    } else {
      execSync(`pkill -f "${marker}" 2>/dev/null || true`, {
        stdio: 'ignore',
        timeout: 5000,
      });
    }
  } catch {
    // pkill exits non-zero when nothing matched — ignore
  }

  // Stale SingletonLock prevents relaunch after a crash
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const lockPath = path.join(PROFILE_DIR, lock);
    try {
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

/**
 * Ensure the user has run `npm run login` at least once (profile has cookies/local state).
 */
function assertProfileInitialized() {
  const markerFiles = ['Cookies', 'Network Persistent State', 'Preferences', 'Local State'];
  const ready = markerFiles.some((f) => fs.existsSync(path.join(PROFILE_DIR, f)));
  // Also accept Default/ subdir (Chrome profile layout)
  const defaultDir = path.join(PROFILE_DIR, 'Default');
  const readyDefault =
    fs.existsSync(defaultDir) &&
    markerFiles.some((f) => fs.existsSync(path.join(defaultDir, f)));

  if (!ready && !readyDefault) {
    throw new SkipPortalError(
      `browser profile not initialized at ${PROFILE_DIR} — run \`npm run login\` once to save your session (passwords are never stored)`
    );
  }
}

async function launch(opts = {}) {
  cleanupStrayChromeProcesses();
  if (!opts.skipProfileCheck) {
    assertProfileInitialized();
  }

  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
  ];
  // Chromium sandbox often blocks headless/CI on Linux
  if (platform === 'linux') args.push('--no-sandbox', '--disable-setuid-sandbox');

  const baseOpts = {
    headless: process.env.HEADLESS === 'true',
    userDataDir: PROFILE_DIR,
    defaultViewport: { width: 1366, height: 850 },
    args,
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    baseOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  let browser;
  try {
    browser = await puppeteer.launch(baseOpts);
  } catch (err) {
    // Bundled Chromium failed to spawn (common cause: wrong-arch binary on
    // Apple Silicon, "Unknown system error -88"). Fall back to the system's
    // installed Google Chrome.
    logger.warn(`[browser] bundled Chromium failed (${err.message}) — retrying with system Chrome`);
    browser = await puppeteer.launch({ ...baseOpts, channel: 'chrome' });
  }

  async function newPage() {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(45_000);
    page.setDefaultTimeout(30_000);
    return page;
  }

  return { browser, newPage };
}

/** Randomized human-ish delay (rate-limit protection between applications). */
function humanDelay(minMs = 2000, maxMs = 3500) {
  const ms = minMs + Math.floor(Math.random() * (maxMs - minMs));
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Heuristic CAPTCHA detector. Never solve — throw so the runner logs a skip.
 *
 * Many sites (Naukri included) embed an invisible reCAPTCHA v3 "anchor" iframe
 * (api2/aframe, 0x0, not visible) on every page defensively — that alone is
 * not an active challenge. Only a visible, non-trivial-size captcha element
 * (the actual "bframe" challenge, a checkbox widget, or interstitial text)
 * counts as a real block.
 */
async function checkForCaptcha(page) {
  const hit = await page.evaluate(() => {
    const text = document.body ? document.body.innerText.toLowerCase() : '';
    const isVisibleChallenge = (el) => {
      if (!el || !el.offsetParent) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 10 && rect.height > 10;
    };
    const captchaEls = Array.from(
      document.querySelectorAll(
        'iframe[src*="recaptcha/api2/bframe"], iframe[src*="hcaptcha.com"], .g-recaptcha, #captcha'
      )
    );
    return (
      captchaEls.some(isVisibleChallenge) ||
      text.includes('verify you are human') ||
      text.includes('unusual traffic')
    );
  });
  if (hit) throw new SkipPortalError('CAPTCHA detected — skipped (never auto-solved)');
}

module.exports = {
  launch,
  humanDelay,
  checkForCaptcha,
  SkipPortalError,
  PROFILE_DIR,
  getProfilePath,
  cleanupStrayChromeProcesses,
  assertProfileInitialized,
  platform,
};
