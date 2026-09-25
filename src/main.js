'use strict';
const electron = require('electron');
const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, nativeTheme, safeStorage } = electron;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('./core/store');
const { Service } = require('./core/service');
const { safeFileName } = require('./core/exporter');
const updater = require('./updater');

let win;
let store;
let service;

function createWindow() {
  const settings = store.getSettings();
  nativeTheme.themeSource = settings.theme === 'light' ? 'light' : 'dark';
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    title: 'Route Sheet Distributor',
    backgroundColor: settings.theme === 'light' ? '#f4f6f9' : '#0f1319',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Links never open inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

const tmpDir = () => {
  const d = path.join(os.tmpdir(), 'route-sheet-distributor');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

/** Puts the route sheet on the clipboard as rich HTML (keeps table formatting when pasted) plus plain text. */
async function copyRich(html, text) {
  if (electron.ClipboardItem) {
    // Electron 44+: async, W3C-style clipboard.
    await clipboard.write([new electron.ClipboardItem({ 'text/html': html, 'text/plain': text })]);
  } else {
    clipboard.write({ html, text });
  }
}

/** Wraps a handler so errors come back to the renderer as { error } instead of rejecting. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      const result = await fn(...args);
      return { ok: true, result, state: service.state() };
    } catch (err) {
      console.error(channel, err);
      return { ok: false, error: err.message || String(err), state: service.state() };
    }
  });
}

function registerIpc() {
  handle('state', () => null);

  handle('import', async (kind) => {
    const filters = {
      associates: [{ name: 'Associate Data', extensions: ['csv'] }],
      routes: [{ name: 'Routes export', extensions: ['xlsx', 'csv'] }],
      pdf: [{ name: 'Route sheet PDF', extensions: ['pdf'] }],
    }[kind];
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
    if (r.canceled || !r.filePaths[0]) return null;
    return service.importFile(r.filePaths[0], null, kind);
  });

  handle('importPaths', async (paths) => {
    // Import PDFs first so a routes file dropped alongside lands in the same run.
    const order = { '.pdf': 0, '.xlsx': 1, '.csv': 2 };
    const sorted = [...paths].sort((a, b) => (order[path.extname(a).toLowerCase()] ?? 3) - (order[path.extname(b).toLowerCase()] ?? 3));
    const results = [];
    for (const p of sorted) results.push(await service.importFile(p));
    return results;
  });

  handle('setDecision', (routeCode, decision) => service.setDecision(routeCode, decision));
  handle('acceptSuggestions', () => service.acceptSuggestions());
  handle('markSent', (routeCode, how) => service.markSent(routeCode, how));
  handle('loadRun', (id) => service.loadRun(id));
  handle('newRun', () => service.newRun());
  handle('deleteRun', async (id) => {
    const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Delete this saved run?', detail: 'Its route sheets, decisions and sent marks will be removed from this computer.' });
    if (r.response !== 0) return false;
    service.deleteRun(id);
    return true;
  });

  handle('preview', (routeCode) => service.preview(routeCode));

  handle('copyEmail', async (routeCode) => {
    const e = await service.emailFor(routeCode);
    await copyRich(e.html, e.text);
    service.markSent(routeCode, 'copied');
    return { subject: e.subject, to: e.recipients.map((r) => r.email).filter(Boolean) };
  });

  handle('openDraft', async (routeCode) => {
    const e = await service.emailFor(routeCode);
    const file = path.join(tmpDir(), safeFileName(`${routeCode} route sheet.eml`));
    fs.writeFileSync(file, e.eml);
    const err = await shell.openPath(file);
    if (err) throw new Error(`Windows could not open the email draft: ${err}`);
    service.markSent(routeCode, 'draft');
    return true;
  });

  handle('openMailApp', async (routeCode) => {
    const e = await service.emailFor(routeCode);
    await copyRich(e.html, e.text);
    const to = e.recipients.map((r) => r.email).filter(Boolean).join(',');
    await shell.openExternal(`mailto:${encodeURIComponent(to).replace(/%2C/g, ',')}?subject=${encodeURIComponent(e.subject)}`);
    service.markSent(routeCode, 'mail-app');
    return true;
  });

  handle('savePdf', async (routeCode) => {
    const e = await service.emailFor(routeCode);
    const r = await dialog.showSaveDialog(win, { defaultPath: e.pdfName, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, await service.sheetPdf(routeCode));
    return r.filePath;
  });

  handle('viewOriginal', async (routeCode) => {
    const file = path.join(tmpDir(), safeFileName(`${routeCode} original page.pdf`));
    fs.writeFileSync(file, await service.sheetPdf(routeCode));
    const err = await shell.openPath(file);
    if (err) throw new Error(err);
    return true;
  });

  handle('exportAll', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose where to save the email drafts and PDFs', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const out = await service.exportAll(r.filePaths[0]);
    shell.openPath(out.folder);
    return out;
  });

  handle('emailSettings', () => service.emailSettings());
  handle('saveEmailSettings', (input) => service.saveEmailSettings(input));
  handle('testEmail', (to) => service.sendTestEmail(to));

  const SENT_HOW = { emailed: 'Emailed', copied: 'Copied', draft: 'Draft opened', 'mail-app': 'Mail app opened', manual: 'Marked sent' };
  const progress = (p) => { if (win && !win.isDestroyed()) win.webContents.send('email-progress', p); };

  handle('sendEmail', async (routeCode) => {
    const sent = service.run.sent[routeCode];
    if (sent) {
      const r = await dialog.showMessageBox(win, {
        type: 'question', buttons: ['Send again', 'Cancel'], defaultId: 1, cancelId: 1,
        message: `${routeCode} is already marked as sent. Send it again?`,
        detail: `${SENT_HOW[sent.how] || 'Marked sent'} on ${new Date(sent.at).toLocaleString()}. The driver will get a second email.`,
      });
      if (r.response !== 0) return null;
    }
    const out = await service.emailRoutes([routeCode], progress);
    if (out.skipped.length) throw new Error(out.skipped[0].reason);
    if (out.failed.length) throw new Error(`${routeCode} was not sent: ${out.failed[0].error}`);
    return out;
  });

  handle('emailAll', async () => {
    const codes = service.unsentRoutes();
    const ready = service.distribution().routes.filter((r) => r.state === 'ready');
    const alreadySent = ready.filter((r) => service.run.sent[r.routeCode]).length;
    const cantSend = ready.filter((r) => !service.run.sent[r.routeCode] && service.sendProblem(r)).length;
    if (!codes.length) throw new Error(alreadySent ? 'Every route sheet that is ready is already marked as sent.' : 'No route sheets are ready to email.');
    const left = [
      alreadySent ? `${alreadySent} already marked as sent` : null,
      cantSend ? `${cantSend} with no usable email address` : null,
    ].filter(Boolean);
    const r = await dialog.showMessageBox(win, {
      type: 'question', buttons: [`Send ${codes.length} emails`, 'Cancel'], defaultId: 1, cancelId: 1,
      message: `Email ${codes.length} route sheet${codes.length === 1 ? '' : 's'} now?`,
      detail: `Each driver gets their own email from ${service.emailConfig().fromAddress} with their route sheet and its PDF page.`
        + (left.length ? `\n\nLeft out: ${left.join(', ')}.` : ''),
    });
    if (r.response !== 0) return null;
    return service.emailRoutes(codes, progress);
  });

  handle('setTheme', (theme) => {
    store.setSettings({ theme });
    nativeTheme.themeSource = theme === 'light' ? 'light' : 'dark';
    return theme;
  });
  handle('getTheme', () => store.getSettings().theme || 'dark');
  handle('openDataFolder', () => shell.openPath(store.dir));
  handle('appInfo', () => ({ version: app.getVersion(), update: updater.getStatus() }));
  handle('checkForUpdates', () => updater.check());
  handle('installUpdate', () => updater.install());
}

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'data'));
  // The email App Password is encrypted with Electron safeStorage (Windows DPAPI, tied to this
  // Windows user), so it is never written to settings.json in plain text.
  service = new Service(store, {
    secrets: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (blob) => safeStorage.decryptString(Buffer.from(blob, 'base64')),
    },
  });
  registerIpc();
  createWindow();
  updater.init((status) => {
    if (win && !win.isDestroyed()) win.webContents.send('update-status', status);
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
