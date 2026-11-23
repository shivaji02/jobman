/**
 * Safe JSON state files (data/*.json written by jobman).
 *
 *  - writes are atomic: temp file in the same directory, then rename
 *  - a file that exists but cannot be parsed is NEVER silently replaced with an
 *    empty default (that would destroy history); readJsonState throws instead
 *  - a missing file is the only case that yields the fallback
 */
const fs = require('fs');
const path = require('path');

function readJsonState(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return typeof fallback === 'function' ? fallback() : structuredClone(fallback);
    throw err;
  }
  if (!raw.trim()) throw new Error(`${file} is empty; refusing to treat it as a fresh state file`);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}); refusing to overwrite it`);
  }
}

function writeJsonState(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

module.exports = { readJsonState, writeJsonState };
