'use strict';

const PresenceChecker = require('./PresenceChecker');
const RejoinHandler   = require('./RejoinHandler');
const ProcessKiller   = require('./ProcessKiller');

const MAX_CONSECUTIVE_FAILS = 5;
const MAX_CRASH_RESTARTS    = 50;   // lifetime restart cap
const RESTART_BACKOFF_MS    = 10000; // 10s wait after unexpected crash

/**
 * Monitors a single Roblox account for disconnection and triggers an auto-rejoin.
 * Self-healing: if the loop dies unexpectedly, it auto-restarts with backoff.
 */
class AccountMonitor {
  constructor(accountConfig, ramConfig, ui) {
    this.name           = accountConfig.name;
    this.cookie         = accountConfig.cookie;
    this.placeId        = accountConfig.placeId;
    this.vipServerLink  = accountConfig.vipServerLink;
    this.checkInterval  = accountConfig.checkIntervalMs  || 30000;
    this.rejoinDelay    = accountConfig.rejoinDelayMs    || 5000;

    this.presence = new PresenceChecker(this.cookie);
    this.rejoiner = new RejoinHandler(ramConfig);
    this.ui = ui;

    this._running          = false;
    this._recentlyRejoin   = false;
    this._consecutiveFails = 0;
    this._wasPlaying       = false;
    this._trackedPid       = null;
    this._totalRejoins     = 0;
    this._crashRestarts    = 0;
    this._staggerIndex     = 0; // set externally for launch spacing
  }

  /**
   * Starts the monitor loop. Self-healing wrapper.
   */
  async start() {
    if (this._running) return; // prevent double-start
    this._running = true;
    this._consecutiveFails = 0;
    this.ui.update(this.name, 'loading', `Checking (${this.checkInterval / 1000}s)`);

    // Stagger accounts to avoid API burst and PID tracking races
    // Each account waits longer so launches don't overlap
    await this._sleep(Math.random() * 3000 + (this._staggerIndex || 0) * 2000);

    // Self-healing outer loop: if the inner loop crashes, restart it
    while (this._running) {
      try {
        await this._monitorLoop();
      } catch (err) {
        // Inner loop died unexpectedly
        this._crashRestarts++;
        this.ui.systemMessage('error', `[${this.name}] Monitor crashed: ${err.message} (restart #${this._crashRestarts})`);

        if (this._crashRestarts >= MAX_CRASH_RESTARTS) {
          this.ui.systemMessage('error', `[${this.name}] Too many crashes, stopping monitor`);
          this._running = false;
          this.ui.update(this.name, 'error', 'Crashed');
          return;
        }

        // Backoff before restart
        this.ui.update(this.name, 'error', 'Restarting...');
        await this._sleep(RESTART_BACKOFF_MS);
      }
    }
  }

  stop() {
    this._running = false;
    // Release tracked PID
    if (this._trackedPid) {
      ProcessKiller.releasePid(this._trackedPid);
      this._trackedPid = null;
    }
    this.ui.update(this.name, 'stopped', 'Idle');
  }

  /**
   * Inner monitor loop. Separated so self-healing wrapper can catch crashes.
   */
  async _monitorLoop() {
    while (this._running) {
      await this._tick();
      await this._sleep(this.checkInterval);
    }
  }

  async _tick() {
    if (this._recentlyRejoin) {
      this._recentlyRejoin = false;
      this.ui.update(this.name, 'loading', 'Cooldown');
      return;
    }

    try {
      const inGame = await this.presence.isInGame();
      this._consecutiveFails = 0;

      if (inGame) {
        this._wasPlaying = true;
        this.ui.update(this.name, 'playing', 'In game');

        // Re-track PID if lost (best-effort: claim first unclaimed Roblox PID)
        if (!this._trackedPid) {
          this._tryReclaimPid();
        }
      } else {
        if (this._wasPlaying) {
          this.ui.systemMessage('warn', `[${this.name}] Kick detected`);
        }
        this._wasPlaying = false;
        this.ui.update(this.name, 'rejoining', 'Reconnecting...');
        await this._rejoin();
      }
    } catch (err) {
      this._consecutiveFails++;
      const msg = err.response
        ? `API ${err.response.status}`
        : err.message || 'Unknown error';
      this.ui.systemMessage('error', `[${this.name}] Presence: ${msg}`);

      if (this._consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        this.ui.update(this.name, 'error', `${MAX_CONSECUTIVE_FAILS} fails, retry`);
        this._consecutiveFails = 0;
        // Extra backoff on repeated failures
        await this._sleep(this.checkInterval);
      } else {
        this.ui.update(this.name, 'error', 'Check failed');
      }
    }
  }

  async _rejoin() {
    try {
      // Release old PID from shared registry
      if (this._trackedPid) {
        ProcessKiller.releasePid(this._trackedPid);
      }
      const oldPid = this._trackedPid;
      this._trackedPid = null;

      const response = await this.rejoiner.launch(this.name, this.placeId, this.vipServerLink, oldPid);
      this._totalRejoins++;

      if (response.success || (response.status === 400 && !response.data)) {
        this.ui.update(this.name, 'rejoining', `Launched (#${this._totalRejoins})`);
        this._detectAndTrackPid(response.pidsBeforeLaunch);
      } else {
        this.ui.systemMessage('error', `[${this.name}] RAM HTTP ${response.status}`);
        this.ui.update(this.name, 'error', 'RAM Error');
      }

      this._recentlyRejoin = true;
      this.ui.update(this.name, 'rejoining', `Delay ${this.rejoinDelay / 1000}s`);
      await this._sleep(this.rejoinDelay);
    } catch (err) {
      const msg = err.code === 'ECONNREFUSED' ? 'RAM unreachable'
        : err.response ? `RAM HTTP ${err.response.status}`
        : err.message || 'Error';
      this.ui.systemMessage('error', `[${this.name}] ${msg}`);
      this.ui.update(this.name, 'error', msg.slice(0, 20));
    }
  }

  _detectAndTrackPid(pidsBeforeLaunch) {
    if (!pidsBeforeLaunch || !this._running) return;
    ProcessKiller.detectNewPid(pidsBeforeLaunch).then(pid => {
      if (pid && this._running) {
        this._trackedPid = pid;
        this.ui.systemMessage('info', `[${this.name}] Tracked PID ${pid}`);
      } else if (this._running) {
        this.ui.systemMessage('warn', `[${this.name}] Could not track Roblox PID (will retry)`);
      }
    }).catch(() => {});
  }

  /**
   * Best-effort: if we're in-game but lost PID tracking, try to claim
   * an unclaimed Roblox PID. Only claims if exactly one is available
   * to avoid grabbing another account's PID.
   */
  async _tryReclaimPid() {
    try {
      const pids = await ProcessKiller.getRobloxPids();
      const unclaimed = pids.filter(p => !ProcessKiller._claimedPids.has(p));
      if (unclaimed.length === 1) {
        const pid = unclaimed[0];
        ProcessKiller.claimPid(pid);
        this._trackedPid = pid;
        this.ui.systemMessage('info', `[${this.name}] Re-tracked PID ${pid}`);
      }
    } catch (_) {}
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = AccountMonitor;
