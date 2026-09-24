'use strict';
// Checks GitHub Releases for a newer version, downloads it in the background, and lets the user
// restart to install. Works for the installed (NSIS) build only; the portable .exe and dev runs
// can't update themselves, so they just report that.

const { app } = require('electron');

let autoUpdater = null;
let status = { state: 'idle', version: null, percent: null, message: null };
let notify = () => {};

function set(next) {
  status = { ...status, ...next };
  notify(status);
}

function canUpdate() {
  if (!app.isPackaged) return 'Updates are only available in the installed app.';
  if (process.platform !== 'win32') return 'Updates are only available on Windows.';
  if (process.env.PORTABLE_EXECUTABLE_DIR) return 'The portable version can\'t update itself. Download the new version from GitHub, or use the installer.';
  return null;
}

function init(onStatus) {
  notify = onStatus;
  const reason = canUpdate();
  if (reason) {
    set({ state: 'unsupported', message: reason });
    return;
  }
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => set({ state: 'checking', message: null }));
  autoUpdater.on('update-not-available', () => set({ state: 'current', message: null }));
  autoUpdater.on('update-available', (info) => set({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version, percent: 100 }));
  autoUpdater.on('error', (err) => set({ state: 'error', message: friendlyError(err) }));

  check();
  // Check again every 4 hours while the app stays open.
  setInterval(check, 4 * 60 * 60 * 1000).unref();
}

function friendlyError(err) {
  const msg = String((err && err.message) || err);
  if (/404|Cannot find latest|No published versions/i.test(msg)) return 'No release has been published on GitHub yet.';
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|net::/i.test(msg)) return 'Could not reach GitHub. Check the internet connection.';
  return msg.split('\n')[0].slice(0, 200);
}

function check() {
  if (!autoUpdater) return status;
  autoUpdater.checkForUpdates().catch((err) => set({ state: 'error', message: friendlyError(err) }));
  return status;
}

function install() {
  if (autoUpdater && status.state === 'ready') autoUpdater.quitAndInstall(false, true);
}

module.exports = { init, check, install, getStatus: () => status };
