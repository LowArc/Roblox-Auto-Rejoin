'use strict';

const chalk = require('chalk');

const LEVEL_MAP = {
  INFO:    'info',
  SUCCESS: 'success',
  WARN:    'warn',
  ERROR:   'error',
};

// When set, all log messages route through this callback instead of console.log.
// Signature: sink(level, message)  where level is 'info'|'success'|'warn'|'error'
let _sink = null;

function setSink(fn) { _sink = fn; }
function clearSink()  { _sink = null; }

function log(level, accountName, message) {
  const sinkLevel = LEVEL_MAP[level] || 'info';
  const tag = accountName ? `[${accountName}]` : '[System]';
  const text = `${tag} ${message}`;

  if (_sink) {
    // Route through LiveUI log feed — no console.log to corrupt the display
    try { _sink(sinkLevel, text); } catch (_) {}
    return;
  }

  // Fallback: direct console output (used during boot before LiveUI starts)
  const ts = chalk.dim(new Date().toLocaleTimeString('en-US', { hour12: false }));
  const prefix = accountName
    ? `${chalk.dim('[')}${chalk.magentaBright(accountName)}${chalk.dim(']')}`
    : `${chalk.dim('[')}${chalk.magenta('System')}${chalk.dim(']')}`;
  console.log(`${ts} ${prefix} ${message}`);
}

module.exports = {
  info:    (account, msg) => log('INFO',    account, msg),
  success: (account, msg) => log('SUCCESS', account, msg),
  warn:    (account, msg) => log('WARN',    account, msg),
  error:   (account, msg) => log('ERROR',   account, msg),
  setSink,
  clearSink,
};
