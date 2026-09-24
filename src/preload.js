'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  state: call('state'),
  import: call('import'),
  importPaths: call('importPaths'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  setDecision: call('setDecision'),
  acceptSuggestions: call('acceptSuggestions'),
  markSent: call('markSent'),
  loadRun: call('loadRun'),
  newRun: call('newRun'),
  deleteRun: call('deleteRun'),
  preview: call('preview'),
  copyEmail: call('copyEmail'),
  openDraft: call('openDraft'),
  openMailApp: call('openMailApp'),
  savePdf: call('savePdf'),
  viewOriginal: call('viewOriginal'),
  exportAll: call('exportAll'),
  setTheme: call('setTheme'),
  getTheme: call('getTheme'),
  openDataFolder: call('openDataFolder'),
  appInfo: call('appInfo'),
  checkForUpdates: call('checkForUpdates'),
  installUpdate: call('installUpdate'),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, status) => cb(status)),
});
