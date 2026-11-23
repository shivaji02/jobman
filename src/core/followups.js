const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'data', 'manual-followups.json');

function createFollowupStore({ file = DEFAULT_FILE } = {}) {
  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { version: 1, items: Array.isArray(data.items) ? data.items : [] };
    } catch {
      return { version: 1, items: [] };
    }
  }

  function list({ status = 'needs_reconfirmation' } = {}) {
    return read().items.filter((item) => !status || item.status === status);
  }

  function resolve(url, note = 'resolved by user') {
    const data = read();
    const item = data.items.find((entry) => entry.url === url);
    if (!item) return false;
    item.status = 'resolved';
    item.resolvedAt = new Date().toISOString();
    item.resolution = note;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return true;
  }

  return { file, list, resolve };
}

module.exports = { createFollowupStore, DEFAULT_FILE };
