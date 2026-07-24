/**
 * Puppeteer helper.
 *
 * - headless: false by default (job sites bot-detect headless); HEADLESS=true
 *   env override for CI/testing.
 * - Persistent profile in .chrome-profile/ so manual logins survive restarts.
 * - Safety: this module never types credentials. Bots call assertLoggedIn()
 *   and throw SkipPortalError when they hit a login wall or CAPTCHA.
 */
const path = require('path');
const puppeteer = require('puppeteer');

const PROFILE_DIR = path.join(__dirname, '..', '..', '.chrome-profile');

/** Thrown when a portal can't be automated safely (login wall, CAPTCHA). */
class SkipPortalError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'SkipPortalError';
  }
}

async function launch() {
  const baseOpts = {
    headless: process.env.HEADLESS === 'true',
    userDataDir: PROFILE_DIR,
    defaultViewport: { width: 1366, height: 850 },
    args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
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
    console.warn(`[browser] bundled Chromium failed (${err.message}) — retrying with system Chrome`);
    browser = await puppeteer.launch({ ...baseOpts, channel: 'chrome' });
  }

  async function newPage() {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60_000);
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

module.exports = { launch, humanDelay, checkForCaptcha, SkipPortalError, PROFILE_DIR };
