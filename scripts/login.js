#!/usr/bin/env node
/**
 * Opens a persistent, visible Chrome profile so the user can log in to each
 * portal manually once. Sessions persist for future runs — passwords are never stored.
 */
const { launch, PROFILE_DIR } = require('../src/core/browser');
const logger = require('../src/core/logger');

const PORTAL_URLS = {
  instahyre: 'https://www.instahyre.com/login/',
  naukri: 'https://www.naukri.com/nlogin/login',
  linkedin: 'https://www.linkedin.com/login',
  yourstory: 'https://yourstory.com/login',
  wellfound: 'https://wellfound.com/login',
};

async function main() {
  const { browser, newPage } = await launch({ skipProfileCheck: true });
  for (const [name, url] of Object.entries(PORTAL_URLS)) {
    const page = await newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    logger.info(`Opened ${name} login page: ${url}`);
  }
  logger.info('\nLog in to each tab manually, then close this process (Ctrl+C) once done.');
  logger.info(`Your sessions will persist in ${PROFILE_DIR} for future jobman runs.`);
  logger.info('Passwords are never stored — only the browser session cookies.');
}

main();
