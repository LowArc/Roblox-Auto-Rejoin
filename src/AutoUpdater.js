'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { execSync, spawn } = require('child_process');

// ── GitHub Release Config ──
const GITHUB_OWNER = 'LowArc';
const GITHUB_REPO  = 'Roblox-Auto-Rejoin';
const RELEASE_API  = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const EXE_ASSET_NAME = 'RobloxAutoRejoin.exe'; // name of the exe in the GitHub release assets

// Current version (read from package.json at bundle time via caxa)
const CURRENT_VERSION = require('../package.json').version;

/**
 * Auto-updater that checks GitHub Releases for a newer version,
 * downloads the new exe, and hot-swaps it via a batch script.
 */
class AutoUpdater {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Returns the directory where the running exe lives.
   * For caxa builds: process.cwd() is the exe's folder.
   * For dev: uses __dirname parent.
   */
  _getExeDir() {
    return process.cwd();
  }

  /**
   * Returns the full path to the running exe.
   */
  _getExePath() {
    // When packaged with caxa, the real exe path can be found from
    // process.argv — the first arg that ends with .exe and is outside the temp dir
    const cwd = this._getExeDir();
    const exeInCwd = path.join(cwd, EXE_ASSET_NAME);
    if (fs.existsSync(exeInCwd)) return exeInCwd;
    // Fallback: try process.execPath parent
    return path.join(path.dirname(process.execPath), EXE_ASSET_NAME);
  }

  /**
   * Parses a version string like "v1.2.3" or "1.2.3" into [major, minor, patch].
   */
  _parseVersion(vStr) {
    const clean = vStr.replace(/^v/i, '').trim();
    const parts = clean.split('.').map(Number);
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  }

  /**
   * Returns true if remote version is newer than current.
   */
  _isNewer(remoteVersion) {
    const [rMaj, rMin, rPat] = this._parseVersion(remoteVersion);
    const [cMaj, cMin, cPat] = this._parseVersion(CURRENT_VERSION);
    if (rMaj !== cMaj) return rMaj > cMaj;
    if (rMin !== cMin) return rMin > cMin;
    return rPat > cPat;
  }

  /**
   * Fetches the latest release info from GitHub API.
   * Returns { tag, downloadUrl, size } or null if no update.
   */
  async checkForUpdate() {
    return new Promise((resolve) => {
      const options = {
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
        method: 'GET',
        headers: {
          'User-Agent': `${GITHUB_REPO}-AutoUpdater/${CURRENT_VERSION}`,
          'Accept': 'application/vnd.github.v3+json',
        },
        timeout: 10000,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode === 404) {
              // No releases yet
              resolve(null);
              return;
            }
            if (res.statusCode !== 200) {
              resolve(null);
              return;
            }

            const release = JSON.parse(data);
            const tag = release.tag_name;

            if (!this._isNewer(tag)) {
              resolve(null); // Already up to date
              return;
            }

            // Find the exe asset
            const asset = (release.assets || []).find(
              a => a.name.toLowerCase() === EXE_ASSET_NAME.toLowerCase()
            );

            if (!asset) {
              resolve(null); // No exe in this release
              return;
            }

            resolve({
              tag,
              downloadUrl: asset.browser_download_url,
              size: asset.size,
              notes: release.body || '',
            });
          } catch (_) {
            resolve(null);
          }
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });
  }

  /**
   * Downloads a file from a URL (follows redirects) to a local path.
   * Returns true on success.
   */
  async _download(url, destPath, expectedSize) {
    return new Promise((resolve) => {
      const file = fs.createWriteStream(destPath);
      let totalBytes = 0;

      const doRequest = (reqUrl) => {
        const parsedUrl = new URL(reqUrl);
        const client = parsedUrl.protocol === 'https:' ? https : http;

        client.get(reqUrl, {
          headers: {
            'User-Agent': `${GITHUB_REPO}-AutoUpdater/${CURRENT_VERSION}`,
          },
          timeout: 60000,
        }, (res) => {
          // Follow redirects (GitHub uses 302 to CDN)
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            doRequest(res.headers.location);
            return;
          }

          if (res.statusCode !== 200) {
            file.close();
            try { fs.unlinkSync(destPath); } catch (_) {}
            resolve(false);
            return;
          }

          res.on('data', (chunk) => {
            totalBytes += chunk.length;
          });

          res.pipe(file);

          file.on('finish', () => {
            file.close();
            // Verify file size if known
            if (expectedSize && totalBytes < expectedSize * 0.9) {
              try { fs.unlinkSync(destPath); } catch (_) {}
              resolve(false);
              return;
            }
            resolve(true);
          });
        }).on('error', () => {
          file.close();
          try { fs.unlinkSync(destPath); } catch (_) {}
          resolve(false);
        });
      };

      doRequest(url);
    });
  }

  /**
   * Creates a batch script that swaps the exe after this process exits.
   * The batch script:
   *   1. Waits for the current process to exit
   *   2. Replaces the old exe with the new one
   *   3. Starts the new exe
   *   4. Deletes itself
   */
  _createSwapScript(exePath, newExePath) {
    const batPath = path.join(path.dirname(exePath), '_update.bat');
    const exeName = path.basename(exePath);
    const newName = path.basename(newExePath);
    const dir = path.dirname(exePath);

    // The batch waits 2s for the process to exit, then swaps files
    const script = `@echo off
title Updating ${exeName}...
echo Updating, please wait...
timeout /t 3 /nobreak >nul
cd /d "${dir}"
del "${exeName}" >nul 2>&1
if exist "${exeName}" (
  timeout /t 2 /nobreak >nul
  del "${exeName}" >nul 2>&1
)
if exist "${exeName}" (
  echo ERROR: Could not replace the exe. Please close all instances and try again.
  pause
  exit /b 1
)
ren "${newName}" "${exeName}"
echo Update complete! Starting...
start "" "${exeName}"
del "%~f0" >nul 2>&1
exit
`;

    fs.writeFileSync(batPath, script, 'utf8');
    return batPath;
  }

  /**
   * Full update flow:
   *   1. Check for update
   *   2. Download new exe
   *   3. Create swap script
   *   4. Launch swap script and exit
   *
   * Returns: { updated: true/false, tag?, message? }
   */
  async update(logFn, preCheckedRelease = null) {
    const log = logFn || ((msg) => this.logger.info(null, msg));

    // Use pre-checked release or fetch fresh
    const release = preCheckedRelease || await this.checkForUpdate();

    if (!release) {
      log(`You're on the latest version (v${CURRENT_VERSION}).`);
      return { updated: false };
    }

    // Step 1: Download
    const exePath = this._getExePath();
    const newExePath = exePath + '.update';

    log(`Downloading update...`);
    const ok = await this._download(release.downloadUrl, newExePath, release.size);

    if (!ok) {
      log('Download failed. Skipping update.');
      return { updated: false, message: 'Download failed' };
    }

    // Verify the download is a valid PE file (starts with MZ)
    try {
      const header = Buffer.alloc(2);
      const fd = fs.openSync(newExePath, 'r');
      fs.readSync(fd, header, 0, 2, 0);
      fs.closeSync(fd);
      if (header.toString('ascii') !== 'MZ') {
        fs.unlinkSync(newExePath);
        log('Downloaded file is not a valid executable. Skipping.');
        return { updated: false, message: 'Invalid exe' };
      }
    } catch (_) {
      try { fs.unlinkSync(newExePath); } catch (_) {}
      log('Could not verify download. Skipping.');
      return { updated: false, message: 'Verify failed' };
    }

    const sizeMB = (fs.statSync(newExePath).size / 1024 / 1024).toFixed(1);
    log(`Downloaded ${sizeMB} MB. Applying update...`);

    // Step 3: Create swap script
    const batPath = this._createSwapScript(exePath, newExePath);

    // Step 4: Launch swap script and exit
    log(`Restarting to apply update to ${release.tag}...`);

    // Detach the batch process so it survives our exit
    const child = spawn('cmd.exe', ['/c', batPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      cwd: path.dirname(exePath),
    });
    child.unref();

    // Give the batch script a moment to start
    await new Promise(r => setTimeout(r, 500));

    // Exit current process — the batch script will swap the exe and restart
    process.exit(0);
  }
}

module.exports = { AutoUpdater, CURRENT_VERSION };
