'use strict';

const { exec } = require('child_process');
const { promisify } = require('util');
const logger = require('./Logger');

const execAsync = promisify(exec);
const EXEC_OPTS = { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 1024 * 256 };

/**
 * Windows-specific utility to find and kill stuck Roblox processes.
 * All methods are async to avoid blocking the event loop.
 */
class ProcessKiller {
  // Shared registry: PIDs already claimed by an account.
  static _claimedPids = new Set();

  static claimPid(pid)   { ProcessKiller._claimedPids.add(pid); }
  static releasePid(pid) { ProcessKiller._claimedPids.delete(pid); }

  /**
   * Returns an array of PIDs for all running RobloxPlayerBeta.exe processes.
   * Async — does NOT block the event loop.
   */
  static async getRobloxPids() {
    const names = ['RobloxPlayerBeta.exe', 'RobloxPlayer.exe'];
    const pids = [];
    for (const name of names) {
      try {
        const { stdout } = await execAsync(
          `tasklist /FI "IMAGENAME eq ${name}" /FO CSV /NH`,
          EXEC_OPTS
        );
        for (const line of stdout.trim().split('\n')) {
          const match = line.match(/"(?:RobloxPlayerBeta|RobloxPlayer)\.exe","(\d+)"/i);
          if (match) {
            const pid = parseInt(match[1], 10);
            if (!pids.includes(pid)) pids.push(pid);
          }
        }
      } catch (_) {}
    }
    return pids;
  }

  /**
   * Kills a single process by PID. Async.
   */
  static async killPid(pid) {
    try {
      await execAsync(`taskkill /F /PID ${pid}`, EXEC_OPTS);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Checks if a specific PID is still running.
   */
  static async isPidAlive(pid) {
    try {
      const { stdout } = await execAsync(
        `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
        EXEC_OPTS
      );
      return stdout.includes(`"${pid}"`);
    } catch (_) {
      return false;
    }
  }

  /**
   * Force-kills a PID and verifies it is actually dead.
   * Retries up to maxRetries times with a short delay between attempts.
   */
  static async forceKillPid(pid, accountName, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      if (!(await ProcessKiller.isPidAlive(pid))) return true; // already dead
      logger.info(accountName, `Killing Roblox PID ${pid} (attempt ${i + 1})`);
      await ProcessKiller.killPid(pid);
      await new Promise(r => setTimeout(r, 1500));
    }
    const stillAlive = await ProcessKiller.isPidAlive(pid);
    if (stillAlive) {
      logger.info(accountName, `PID ${pid} still alive after ${maxRetries} kill attempts`);
    }
    return !stillAlive;
  }

  /**
   * Takes a snapshot of current Roblox PIDs. Async.
   */
  static async snapshotPids() {
    return new Set(await ProcessKiller.getRobloxPids());
  }

  /**
   * Kills PIDs that existed before AND still exist after a close attempt.
   */
  static async killStuckProcesses(beforePids, accountName) {
    const afterPids = await ProcessKiller.getRobloxPids();
    let killed = 0;
    for (const pid of afterPids) {
      if (beforePids.has(pid)) {
        logger.info(accountName, `Killing stuck Roblox PID ${pid}`);
        if (await ProcessKiller.killPid(pid)) killed++;
      }
    }
    return killed;
  }

  /**
   * Kills Roblox PIDs from a snapshot that are NOT claimed by any account.
   * Safe to call when one account disconnects — other accounts' PIDs are
   * in _claimedPids and will be skipped.
   */
  static async killUnclaimedPids(beforePids, accountName) {
    const afterPids = await ProcessKiller.getRobloxPids();
    for (const pid of afterPids) {
      if (beforePids.has(pid) && !ProcessKiller._claimedPids.has(pid)) {
        logger.info(accountName, `Killing unclaimed Roblox PID ${pid}`);
        await ProcessKiller.forceKillPid(pid, accountName);
        return 1; // Kill at most ONE unclaimed PID to avoid collateral damage
      }
    }
    return 0;
  }

  /**
   * Nuclear option: kills ALL RobloxPlayerBeta.exe processes.
   */
  static async killAllRoblox(accountName) {
    const pids = await ProcessKiller.getRobloxPids();
    let killed = 0;
    for (const pid of pids) {
      logger.info(accountName, `Force-killing Roblox PID ${pid}`);
      if (await ProcessKiller.killPid(pid)) killed++;
    }
    return killed;
  }

  /**
   * Detects which new Roblox PID appeared after a launch.
   * Polls until a new unclaimed PID is found or timeout.
   */
  static async detectNewPid(beforePids, maxWaitMs = 30000, pollMs = 2000) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, pollMs));
      const currentPids = await ProcessKiller.getRobloxPids();
      for (const pid of currentPids) {
        if (!beforePids.has(pid) && !ProcessKiller._claimedPids.has(pid)) {
          ProcessKiller.claimPid(pid);
          return pid;
        }
      }
    }
    return null;
  }

  /**
   * Periodic cleanup: remove claimed PIDs that are no longer running.
   * Prevents the registry from growing forever.
   */
  static async pruneClaimedPids() {
    if (ProcessKiller._claimedPids.size === 0) return;
    const alive = new Set(await ProcessKiller.getRobloxPids());
    for (const pid of ProcessKiller._claimedPids) {
      if (!alive.has(pid)) ProcessKiller._claimedPids.delete(pid);
    }
  }
}

module.exports = ProcessKiller;
