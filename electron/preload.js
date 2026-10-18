const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hs', {
  read: () => ipcRenderer.invoke('read'),
  metadata: () => ipcRenderer.invoke('metadata'),
  apply: (plan) => ipcRenderer.invoke('apply', plan),
  restore: () => ipcRenderer.invoke('restore'),
  donate: () => ipcRenderer.invoke('donate'),
  platform: process.platform,
});
