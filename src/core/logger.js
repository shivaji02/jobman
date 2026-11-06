const fs = require('fs');
const path = require('path');

class Logger {
  constructor(logDir = path.join(__dirname, '..', '..', 'logs')) {
    this.logDir = logDir;
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    this.logFile = path.join(logDir, `${new Date().toISOString().split('T')[0]}.log`);
  }

  log(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${level}] ${message}`;
    const fullEntry =
      data && typeof data === 'object' && Object.keys(data).length
        ? `${entry} ${JSON.stringify(data)}`
        : entry;

    if (level === 'DEBUG' && !process.env.JOBMAN_VERBOSE) {
      // file only — keep the terminal feed readable
    } else if (this.sink) {
      this.sink(level, entry); // live dashboard owns the terminal
    } else if (level === 'ERROR') console.error(entry);
    else if (level === 'WARN') console.warn(entry);
    else console.log(entry);

    try {
      fs.appendFileSync(this.logFile, fullEntry + '\n');
    } catch {
      // never let logging crash the bot
    }
  }

  /** Route terminal output elsewhere (the parallel dashboard); null restores console. */
  setSink(fn) {
    this.sink = typeof fn === 'function' ? fn : null;
  }

  info(msg, data) {
    this.log('INFO', msg, data);
  }
  warn(msg, data) {
    this.log('WARN', msg, data);
  }
  error(msg, data) {
    this.log('ERROR', msg, data);
  }
  debug(msg, data) {
    this.log('DEBUG', msg, data);
  }
}

module.exports = new Logger();
