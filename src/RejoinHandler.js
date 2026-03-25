'use strict';

const http  = require('http');
const axios = require('axios');
const logger = require('./Logger');
const ProcessKiller = require('./ProcessKiller');

// Shared HTTP agent: reuses TCP connections, limits open sockets,
// auto-cleans idle connections. Prevents socket leaks over long runs.
const keepAliveAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 4,
  maxFreeSockets: 2,
  timeout: 15000,
  freeSocketTimeout: 10000,
});

/**
 * Communicates with the Roblox Account Manager (RAM) local HTTP API
 * to trigger account launches / rejoins into VIP servers.
 */
class RejoinHandler {
  /**
   * @param {object} ramConfig  - { host, port, password }
   */
  constructor(ramConfig) {
    this.host     = ramConfig.host || 'localhost';
    this.port     = ramConfig.port || 7963;
    this.password = ramConfig.password || '';
  }

  /**
   * Extracts or returns the PlaceId.
   * Supports legacy /games/ links or uses the config value.
   */
  parsePlaceIdFromLink(vipServerLink, configPlaceId) {
    if (configPlaceId) return configPlaceId;

    try {
      const url = new URL(vipServerLink);
      if (url.hostname.includes('roblox.com') && url.pathname.includes('/games/')) {
        const parts = url.pathname.split('/').filter(Boolean);
        const gamesIdx = parts.indexOf('games');
        if (gamesIdx !== -1 && parts[gamesIdx + 1]) {
          return parts[gamesIdx + 1];
        }
      }
    } catch (_) {}
    return configPlaceId || null;
  }

  /**
   * Closes the Roblox window for a specific account via RAM's CloseAccount API.
   * Only affects that one account — all other active Roblox windows are untouched.
   * Returns true if RAM confirmed the close, false if the account wasn't running.
   */
  async closeAccountWindow(accountName) {
    const params = new URLSearchParams({ Account: accountName });
    if (this.password) params.set('Password', this.password);

    const url = `http://${this.host}:${this.port}/CloseAccount?${params.toString()}`;

    try {
      const res = await axios.get(url, {
        timeout: 5000,
        validateStatus: () => true,
        httpAgent: keepAliveAgent,
      });
      const ok = res.status === 200;
      if (ok) logger.info(accountName, 'Closed stale Roblox window via RAM.');
      return ok;
    } catch (_) {
      return false;
    }
  }

  /**
   * Sends a LaunchAccount request to the RAM local API.
   *
   * @param {string} accountName    - The account name as it appears in RAM
   * @param {string} placeId        - Roblox place ID
   * @param {string} vipServerLink  - Full VIP server URL
   */
  async launch(accountName, placeId, vipServerLink, trackedPid = null) {
    // Snapshot PIDs before any close attempt so we can find orphaned windows
    const pidsBeforeClose = await ProcessKiller.snapshotPids();

    // Always try RAM CloseAccount first (graceful, account-specific)
    await this.closeAccountWindow(accountName);

    // If we have a tracked PID, force-kill it and verify it's dead
    if (trackedPid) {
      await ProcessKiller.forceKillPid(trackedPid, accountName);
    }

    // Brief wait for the old window to fully close
    await new Promise(r => setTimeout(r, 2000));

    // Fallback: kill any surviving Roblox PIDs that are NOT claimed by
    // another active account. This catches disconnected windows even when
    // PID tracking was lost (the caller already released the old PID).
    await ProcessKiller.killUnclaimedPids(pidsBeforeClose, accountName);

    // Snapshot PIDs right before launching so caller can detect the new PID
    const pidsBeforeLaunch = await ProcessKiller.snapshotPids();

    // If it's a share link, ensure we are sending the full URL as RAM often parses it
    let jobId = vipServerLink;

    const params = new URLSearchParams({
      Account: accountName,
      PlaceId:  placeId,
      JobId:    jobId,
      JoinVIP:  'true',
    });

    if (this.password) {
      params.set('Password', this.password);
    }

    const url = `http://${this.host}:${this.port}/LaunchAccount?${params.toString()}`;

    logger.info(accountName, `Sending rejoin request → RAM API`);

    try {
      const res = await axios.get(url, {
        timeout: 10000,
        validateStatus: () => true,
        httpAgent: keepAliveAgent,
      });

      const success = res.status === 200;
      return { success, status: res.status, data: res.data, pidsBeforeLaunch };
    } catch (err) {
      throw err;
    }
  }
}

module.exports = RejoinHandler;
