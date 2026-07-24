#!/usr/bin/env node
/**
 * Opens a persistent, visible Chrome profile so the user can log in to each
 * portal manually once. Logins persist in .chrome-profile/ for future runs.
 */
const { launch } = require('../src/core/browser');

const PORTAL_URLS = {
  instahyre: 'https://www.instahyre.com/login/',
  naukri: 'https://www.naukri.com/nlogin/login',
  linkedin: 'https://www.linkedin.com/login',
  yourstory: 'https://yourstory.com/login',
  wellfound: 'https://wellfound.com/login',
};

async function main() {
  const { browser, newPage } = await launch();
  for (const [name, url] of Object.entries(PORTAL_URLS)) {
    const page = await newPage();
    await page.goto(url, { waitUntil: 'networkidle2' }).catch(() => {});
    console.log(`Opened ${name} login page: ${url}`);
  }
  console.log('\nLog in to each tab manually, then close this process (Ctrl+C) once done.');
  console.log('Your sessions will persist in .chrome-profile/ for future jobman runs.');
}

main();
