'use strict';

const https = require('https');
const axios = require('axios');

// Shared HTTPS agent for all Roblox API calls.
// keepAlive reuses TLS connections, preventing socket exhaustion over long runs.
const robloxAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 6,
  maxFreeSockets: 2,
  timeout: 20000,
  freeSocketTimeout: 15000,
});

const REQ_TIMEOUT = 12000; // 12s per request

/**
 * Checks Roblox Presence API to determine if an account is currently in-game.
 * Uses the .ROBLOSECURITY cookie to authenticate.
 */
class PresenceChecker {
  constructor(cookie) {
    this.cookie = cookie;
    this._userId = null;
    // Pre-build header object once — avoids creating new strings every poll
    this._headers = Object.freeze({
      Cookie: `.ROBLOSECURITY=${cookie}`,
    });
  }

  /**
   * Resolves the Roblox User ID from the cookie.
   * Cached after first successful call.
   */
  async getUserId() {
    if (this._userId) return this._userId;

    const res = await axios.get('https://users.roblox.com/v1/users/authenticated', {
      headers: this._headers,
      timeout: REQ_TIMEOUT,
      httpsAgent: robloxAgent,
    });
    this._userId = res.data.id;
    return this._userId;
  }

  /**
   * Returns the user's current presence info.
   * userPresenceType: 0=Offline, 1=Online, 2=In-Game, 3=In Studio
   */
  async getPresence() {
    const userId = await this.getUserId();

    const res = await axios.post(
      'https://presence.roblox.com/v1/presence/users',
      { userIds: [userId] },
      {
        headers: this._headers,
        timeout: REQ_TIMEOUT,
        httpsAgent: robloxAgent,
      }
    );

    const presences = res.data.userPresences;
    if (!presences || presences.length === 0) {
      throw new Error('No presence data returned');
    }
    return presences[0];
  }

  /**
   * Returns true if the account is currently in-game.
   */
  async isInGame() {
    const presence = await this.getPresence();
    return presence.userPresenceType === 2;
  }
}

module.exports = PresenceChecker;
