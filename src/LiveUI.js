'use strict';

const chalk  = require('chalk');
const { execSync } = require('child_process');

// Ensure Windows console uses UTF-8
if (process.platform === 'win32') {
  try { execSync('chcp 65001', { stdio: 'ignore', windowsHide: true }); } catch (_) {}
}

// ---- Color palette (computed once) ----
const PURPLE  = chalk.hex('#c084fc');
const CYAN_B  = chalk.hex('#22d3ee');
const GREEN_B = chalk.hex('#4ade80');
const RED_B   = chalk.hex('#f87171');
const ORANGE  = chalk.hex('#fb923c');
const DIM     = chalk.hex('#6b7280');
const WHITE_B = chalk.hex('#e5e7eb');
const ACCENT  = chalk.hex('#a78bfa');
const GOLD    = chalk.hex('#fbbf24');
const SLATE   = chalk.hex('#94a3b8');

// ---- Pre-cached static strings (allocated once, reused every frame) ----
const S_ACCOUNTS  = SLATE('ACCOUNTS');
const S_ONLINE    = DIM('online');
const S_ACTIVE    = DIM('active');
const S_UPTIME    = DIM('uptime');
const S_DIV       = `  ${DIM('-'.repeat(52))}`;
const S_LOG_TITLE = `  ${DIM('ACTIVITY LOG')}`;
const S_PROMPT_L  = `  ${GOLD('>')} ${DIM('Toggle account (0=all):')} `;
const S_CURSOR_ON = GOLD('|');

// Pre-cached state icons (static states)
const ICON_PLAYING = GREEN_B('*');
const ICON_ERROR   = RED_B('x');
const ICON_STOPPED = DIM('o');

// Pre-cached state labels + padding
const LABELS = {
  playing:   GREEN_B('ONLINE')  + '  ',  // 6 chars + 2 pad = 8
  rejoining: ORANGE('REJOIN')   + '  ',  // 6 + 2
  loading:   CYAN_B('LOAD')     + '    ', // 4 + 4
  error:     RED_B('ERROR')     + '   ',  // 5 + 3
  stopped:   DIM('OFF')         + '     ', // 3 + 5
};

// Pre-cached log icons
const LOG_ICONS = {
  success: GREEN_B('+'),
  error:   RED_B('x'),
  warn:    ORANGE('!'),
  info:    CYAN_B('>'),
};

// Pre-cached spinner frames (colored)
const SPINNER_ORANGE = ['|', '/', '-', '\\'].map(c => ORANGE(c));
const SPINNER_CYAN   = ['|', '/', '-', '\\'].map(c => CYAN_B(c));

// Pre-compute all pulse bar frames (wave repeats every 16 frames at 0.5 step)
const PULSE_BAR_FRAMES = (() => {
  const wave = [' ', '.', '-', '=', '#', '=', '-', '.'];
  const width = 44;
  const frameCount = wave.length * 2; // 16 unique frames
  const frames = new Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let bar = '';
    for (let i = 0; i < width; i++) {
      const phase = Math.floor((f * 0.5 + i) % wave.length);
      const ch = wave[phase];
      if (ch === '#' || ch === '=') bar += ACCENT(ch);
      else if (ch === '-') bar += PURPLE(ch);
      else bar += DIM(ch);
    }
    frames[f] = `  ${bar}`;
  }
  return frames;
})();

// ---- Stdout safety: catch EPIPE/write errors ----
let _stdoutDead = false;
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') _stdoutDead = true;
});

class LiveUI {
  constructor(accountNames) {
    this.accounts = accountNames.map(name => ({
      name,
      status: 'Idle',
      state: 'stopped',
      _cachedName: PURPLE(name), // pre-color account name once
    }));

    // Pre-cache numbered prefixes: DIM('[1]'), DIM('[2]'), ...
    this._numPrefixes = accountNames.map((_, i) => DIM(`[${i + 1}]`));

    this.frameIndex  = 0;
    this.interval    = null;
    this.inputBuffer = '';
    this.logs        = [];
    this.maxLogs     = 5;
    this.startTime   = Date.now();

    // Hide cursor
    this._write('\x1B[?25l');
    process.on('exit', () => this._write('\x1B[?25h'));
  }

  // Safe stdout write — never throws
  _write(data) {
    if (_stdoutDead) return;
    try { process.stdout.write(data); } catch (_) { _stdoutDead = true; }
  }

  start() {
    if (this.interval) return;
    this._write('\x1b[2J\x1b[H');
    this.interval = setInterval(() => {
      this.frameIndex++;
      this.render();
    }, 200);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.render();
  }

  update(accountName, state, status) {
    const acc = this.accounts.find(a => a.name === accountName);
    if (acc) {
      if (state)  acc.state  = state;
      if (status) acc.status = status;
    }
  }

  setInputBuffer(buf) {
    this.inputBuffer = buf;
  }

  addLog(level, msg) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    this.logs.push({ ts, level, msg });
    if (this.logs.length > this.maxLogs) this.logs.shift();
  }

  systemMessage(level, msg) {
    this.addLog(level, msg);
  }

  getUptime() {
    const diff = Math.floor((Date.now() - this.startTime) / 1000);
    const h = String(Math.floor(diff / 3600)).padStart(2, '0');
    const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
    const s = String(diff % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  render() {
    if (_stdoutDead) return;

    try {
      const f = this.frameIndex;
      const lines = [];

      // Pulse bar (pre-computed)
      lines.push(PULSE_BAR_FRAMES[f % PULSE_BAR_FRAMES.length]);
      lines.push('');

      // Account summary
      let online = 0, active = 0;
      for (let i = 0; i < this.accounts.length; i++) {
        const s = this.accounts[i].state;
        if (s === 'playing') online++;
        if (s !== 'stopped') active++;
      }
      const total = this.accounts.length;
      lines.push(`  ${S_ACCOUNTS}  ${S_ONLINE} ${WHITE_B(online + '/' + total)}  ${S_ACTIVE} ${WHITE_B(active + '/' + total)}  ${S_UPTIME} ${WHITE_B(this.getUptime())}`);
      lines.push(S_DIV);

      // Account rows
      for (let i = 0; i < this.accounts.length; i++) {
        const acc = this.accounts[i];
        const num = this._numPrefixes[i];

        // Animated icons for spinning states, static for others
        let icon;
        switch (acc.state) {
          case 'playing':   icon = ICON_PLAYING; break;
          case 'rejoining': icon = SPINNER_ORANGE[f % 4]; break;
          case 'loading':   icon = SPINNER_CYAN[f % 4]; break;
          case 'error':     icon = ICON_ERROR; break;
          default:          icon = ICON_STOPPED; break;
        }

        const label  = LABELS[acc.state] || LABELS.stopped;
        const status = acc.state === 'playing' ? DIM(acc.status) : WHITE_B(acc.status);
        lines.push(`  ${num} ${icon} ${label}${acc._cachedName} ${DIM('-')} ${status}`);
      }

      lines.push('');

      // Log feed
      if (this.logs.length > 0) {
        lines.push(S_LOG_TITLE);
        lines.push(S_DIV);
        for (let i = 0; i < this.logs.length; i++) {
          const log = this.logs[i];
          lines.push(`  ${DIM(log.ts)} ${LOG_ICONS[log.level] || LOG_ICONS.info} ${DIM(log.msg)}`);
        }
        lines.push('');
      }

      // Input prompt
      lines.push(S_DIV);
      const cursor = f % 2 === 0 ? S_CURSOR_ON : ' ';
      lines.push(`${S_PROMPT_L}${WHITE_B(this.inputBuffer)}${cursor}`);

      // Single write: home + clear-each-line + clear-below
      this._write('\x1b[H' + lines.map(l => `\x1b[2K${l}`).join('\n') + '\n\x1b[J');
    } catch (_) {
      // Never let a render error kill the interval
    }
  }
}

module.exports = LiveUI;
