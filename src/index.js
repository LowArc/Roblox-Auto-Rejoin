'use strict';

const fs       = require('fs');
const path     = require('path');
const chalk    = require('chalk');
const readline = require('readline');
const AccountMonitor = require('./AccountMonitor');
const logger         = require('./Logger');
const LiveUI         = require('./LiveUI');
const ProcessKiller  = require('./ProcessKiller');
const { AutoUpdater, CURRENT_VERSION } = require('./AutoUpdater');

// Raise listener limit — monitors + timers + signals add up over long runs
require('events').defaultMaxListeners = 30;

// ═══════════════════════════════════════════════════
//  Crash log — capped at 512KB to prevent disk fill
// ═══════════════════════════════════════════════════
const CRASH_LOG_PATH = path.join(
  process.cwd(),
  'crash.log'
);
const CRASH_LOG_MAX = 512 * 1024; // 512KB

function writeCrashLog(msg) {
  try {
    // Truncate if too large
    try {
      const stat = fs.statSync(CRASH_LOG_PATH);
      if (stat.size > CRASH_LOG_MAX) {
        const data = fs.readFileSync(CRASH_LOG_PATH, 'utf8');
        fs.writeFileSync(CRASH_LOG_PATH, data.slice(-CRASH_LOG_MAX / 2));
      }
    } catch (_) {}
    const ts = new Date().toISOString();
    fs.appendFileSync(CRASH_LOG_PATH, `[${ts}] ${msg}\n`);
  } catch (_) { /* best-effort */ }
}

// ═══════════════════════════════════════════════════
//  Premium color palette (matching LiveUI)
// ═══════════════════════════════════════════════════
const PURPLE    = chalk.hex('#c084fc');
const PINK      = chalk.hex('#f472b6');
const CYAN_B    = chalk.hex('#22d3ee');
const GREEN_B   = chalk.hex('#4ade80');
const RED_B     = chalk.hex('#f87171');
const DIM       = chalk.hex('#6b7280');
const WHITE_B   = chalk.hex('#e5e7eb');
const ACCENT    = chalk.hex('#a78bfa');
const GOLD      = chalk.hex('#fbbf24');

// ═══════════════════════════════════════════════════
//  Gradient ASCII Logo
// ═══════════════════════════════════════════════════
const LOGO_RAW = [
  '  ____       _       _        ',
  ' |  _ \\ ___ (_) ___ (_)_ __   ',
  ' | |_) / _ \\| |/ _ \\| | \'_ \\  ',
  ' |  _ <  __/| | (_) | | | | | ',
  ' |_| \\_\\___|/ |\\___/|_|_| |_| ',
  '          |__/                 ',
];

const GRAD = [
  '#c084fc', '#b57efa', '#a978f0', '#9d72eb',
  '#916ce6', '#8566e1', '#7960dc', '#6d5ad7',
  '#6154d2', '#5550cd', '#494cc8', '#3d48c3',
  '#3144be', '#2540b9', '#1a3cb4', '#0e38af',
  '#0284c7', '#0891b2', '#0ea5e9', '#22d3ee',
];

function gradLine(line) {
  return line.split('').map((ch, i) => {
    const idx = Math.floor((i / line.length) * (GRAD.length - 1));
    return chalk.hex(GRAD[idx])(ch);
  }).join('');
}

// ═══════════════════════════════════════════════════
//  Exit handler
// ═══════════════════════════════════════════════════
class ExitError extends Error {
  constructor(code) { super('Exit'); this.code = code; }
}

function exitProcess(code = 1) {
  console.log(DIM('\n  Press Enter to close...'));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('', () => process.exit(code));
  throw new ExitError(code);
}

process.on('uncaughtException', (err) => {
  if (err instanceof ExitError) return;
  // Ignore EPIPE — means the terminal/pipe closed, not a real crash
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return;
  writeCrashLog(`FATAL: ${err.message}\n${err.stack}`);
  logger.error(null, `Fatal: ${err.message}`);
  try { exitProcess(1); } catch (e) {}
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  writeCrashLog(`UNHANDLED REJECTION: ${msg}`);
  logger.error(null, `Unhandled Rejection: ${msg}`);
});

// Prevent EPIPE from crashing the process
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// ═══════════════════════════════════════════════════
//  Resolve the real exe directory (works with caxa)
// ═══════════════════════════════════════════════════
function getExeDir() {
  // When packaged with caxa, process.execPath points to the internal node.exe
  // inside the temp extraction dir, not the actual .exe the user double-clicked.
  // process.cwd() is the most reliable way to find the real exe's folder.
  const candidates = [
    process.cwd(),
    path.dirname(process.execPath),
    path.join(__dirname, '..')
  ];
  return candidates;
}

// ═══════════════════════════════════════════════════
//  Load config
// ═══════════════════════════════════════════════════
const exeDirs = getExeDir();
const possiblePaths = exeDirs.map(d => path.join(d, 'config.json'));

let CONFIG_PATH = null;
for (const p of possiblePaths) {
  if (fs.existsSync(p)) { CONFIG_PATH = p; break; }
}

if (!CONFIG_PATH) {
  // Auto-create config.json from bundled config.example.json
  const exampleSources = [
    ...exeDirs.map(d => path.join(d, 'config.example.json')),
    path.join(__dirname, '..', 'config.example.json')
  ];
  const examplePath = exampleSources.find(p => fs.existsSync(p));
  const targetDir = process.cwd();
  const targetPath = path.join(targetDir, 'config.json');

  if (examplePath) {
    try {
      fs.copyFileSync(examplePath, targetPath);
      console.log('');
      logger.info(null, `Created ${WHITE_B('config.json')} from template.`);
      logger.info(null, GOLD('Please edit config.json with your account details, then run again.'));
      logger.info(null, DIM(`Location: ${targetPath}`));
    } catch (err) {
      logger.error(null, `Failed to create config.json: ${err.message}`);
    }
  } else {
    logger.error(null, 'config.json not found!');
    logger.info(null, DIM('Place config.json next to the executable.'));
  }
  exitProcess(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  logger.error(null, `Failed to parse config.json: ${err.message}`);
  exitProcess(1);
}

if (!config.accounts || config.accounts.length === 0) {
  logger.error(null, 'No accounts in config.json!');
  exitProcess(1);
}

const RAM_CONFIG = config.ram || { host: 'localhost', port: 7963, password: '' };

for (const account of config.accounts) {
  if (!account.name)          { logger.error(null, `Account missing "name"`);                    exitProcess(1); }
  if (!account.cookie)        { logger.error(null, `"${account.name}" missing "cookie"`);        exitProcess(1); }
  if (!account.placeId)       { logger.error(null, `"${account.name}" missing "placeId"`);       exitProcess(1); }
  if (!account.vipServerLink) { logger.error(null, `"${account.name}" missing "vipServerLink"`); exitProcess(1); }
}

// ═══════════════════════════════════════════════════
//  Animated Boot Sequence
// ═══════════════════════════════════════════════════
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function bootSequence() {
  console.clear();
  process.stdout.write('\x1B[?25l'); // hide cursor

  // Fade in logo line by line
  console.log('');
  for (const line of LOGO_RAW) {
    console.log(`  ${gradLine(line)}`);
    await sleep(40);
  }

  console.log('');
  console.log(`  ${PURPLE.bold('Roblox Auto Rejoin')} ${DIM('·')} ${ACCENT('ArcX')} ${DIM('v' + CURRENT_VERSION)}`);
  console.log(`  ${DIM('='.repeat(44))}`);
  await sleep(200);

  // Loading dots animation
  const loadMsg = '  Initializing';
  for (let i = 0; i < 3; i++) {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(`${DIM(loadMsg + '.'.repeat(i + 1))}`);
    await sleep(300);
  }
  readline.cursorTo(process.stdout, 0);
  readline.clearLine(process.stdout, 0);
  console.log(`  ${GREEN_B('+')} ${DIM('System ready')}`);
  console.log('');
  await sleep(200);
}

// ═══════════════════════════════════════════════════
//  Main Application
// ═══════════════════════════════════════════════════
async function main() {
  await bootSequence();

  // ── Auto-update check ──
  try {
    const updater = new AutoUpdater(logger);
    const release = await updater.checkForUpdate();
    if (release) {
      console.log(`  ${GOLD('⟳')} ${WHITE_B('Update available:')} ${GREEN_B(release.tag)} ${DIM('(current: v' + CURRENT_VERSION + ')')}`);
      if (release.notes) {
        const firstLine = release.notes.split('\n')[0].slice(0, 70);
        if (firstLine) console.log(`    ${DIM(firstLine)}`);
      }
      console.log(`  ${DIM('Downloading update...')}`);
      await updater.update((msg) => console.log(`  ${CYAN_B('>')} ${DIM(msg)}`), release);
      // If update() returns (download failed), continue normally
    } else {
      console.log(`  ${GREEN_B('✓')} ${DIM('Up to date (v' + CURRENT_VERSION + ')')}`);
    }
  } catch (_) {
    // Update check failed (no internet, etc.) — continue normally
    console.log(`  ${DIM('Update check skipped')}`);
  }
  console.log('');
  await sleep(300);

  // ── Initialize LiveUI ──
  const ui = new LiveUI(config.accounts.map(a => a.name));
  ui.start();

  // Route all Logger output through LiveUI (prevents console.log corruption)
  logger.setSink((level, msg) => ui.systemMessage(level, msg));

  // ── Create monitors (all start stopped) ──
  const monitors = config.accounts.map((acc, i) => {
    const mon = new AccountMonitor(acc, RAM_CONFIG, ui);
    mon._staggerIndex = i; // space out launches to prevent PID tracking races
    return mon;
  });

  ui.systemMessage('info', `${monitors.length} account(s) loaded. Type 0 + Enter to start all.`);

  // ── Periodic maintenance (runs every 5 minutes) ──
  setInterval(() => {
    try {
      // Prune stale PID claims
      ProcessKiller.pruneClaimedPids().catch(() => {});

      // Memory watchdog — log RSS, warn if too high
      const rss = process.memoryUsage().rss;
      const mb = (rss / 1024 / 1024).toFixed(1);
      if (rss > 200 * 1024 * 1024) {
        ui.systemMessage('warn', `High memory: ${mb} MB`);
        writeCrashLog(`WARN: High RSS ${mb} MB`);
      }
    } catch (_) {}
  }, 5 * 60 * 1000).unref();

  // ── Raw-mode input ──
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  let inputBuffer = '';

  process.stdin.on('keypress', (str, key) => {
    // Ctrl+C → graceful shutdown
    if (key && key.ctrl && key.name === 'c') {
      shutdown('SIGINT');
      return;
    }

    if (key && (key.name === 'return' || key.name === 'enter')) {
      handleInput(inputBuffer.trim(), monitors, ui);
      inputBuffer = '';
      ui.setInputBuffer(inputBuffer);
    } else if (key && key.name === 'backspace') {
      inputBuffer = inputBuffer.slice(0, -1);
      ui.setInputBuffer(inputBuffer);
    } else if (str && str.length === 1 && /[0-9 ,]/.test(str)) {
      inputBuffer += str;
      ui.setInputBuffer(inputBuffer);
    }
  });

  // ── Graceful shutdown (with double-call guard) ──
  let _shuttingDown = false;
  function shutdown(signal) {
    if (_shuttingDown) return;
    _shuttingDown = true;
    logger.clearSink(); // stop routing to UI
    if (ui) ui.stop();
    monitors.forEach(m => m.stop());
    try { process.stdout.write('\x1B[?25h'); } catch (_) {}
    process.exit(0);
  }

  process.on('SIGINT',   () => shutdown('SIGINT'));
  process.on('SIGTERM',  () => shutdown('SIGTERM'));
  process.on('SIGHUP',   () => shutdown('SIGHUP'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
}

// ═══════════════════════════════════════════════════
//  Toggle Handler
// ═══════════════════════════════════════════════════
function handleInput(input, monitors, ui) {
  if (!input) return;
  const parts = input.split(/[\s,]+/).filter(Boolean);

  if (parts.includes('0')) {
    // Toggle ALL: if any stopped → start them, else stop all
    const anyStopped = monitors.some(m => !m._running);
    if (anyStopped) {
      for (const m of monitors) {
        if (!m._running) {
          ui.systemMessage('info', `Starting ${m.name}...`);
          m.start().catch(e => ui.systemMessage('error', `[${m.name}] ${e.message}`));
        }
      }
    } else {
      for (const m of monitors) {
        if (m._running) m.stop();
      }
      ui.systemMessage('warn', 'All monitors stopped.');
    }
    return;
  }

  for (const p of parts) {
    const choice = parseInt(p, 10);
    if (choice > 0 && choice <= monitors.length) {
      const target = monitors[choice - 1];
      if (target._running) {
        target.stop();
        ui.systemMessage('warn', `Stopped ${target.name}.`);
      } else {
        ui.systemMessage('info', `Starting ${target.name}...`);
        target.start().catch(e => ui.systemMessage('error', `[${target.name}] ${e.message}`));
      }
    }
  }
}

// Launch!
main();
