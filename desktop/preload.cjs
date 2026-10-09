const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('orbis', {
  status: () => ipcRenderer.invoke('orbis:status'),
  configureGoogle: () => ipcRenderer.invoke('orbis:configureGoogle'),
  connect: () => ipcRenderer.invoke('orbis:connect'),
  disconnect: () => ipcRenderer.invoke('orbis:disconnect'),
  createVault: () => ipcRenderer.invoke('orbis:createVault'),
  unlock: (id, key) => ipcRenderer.invoke('orbis:unlock', id, key),
  recoveryKey: () => ipcRenderer.invoke('orbis:recoveryKey'),
  sync: (resolutions, heads) => ipcRenderer.invoke('orbis:sync', resolutions, heads),
  importLibrary: () => ipcRenderer.invoke('orbis:importLibrary'),
  openLibrary: () => ipcRenderer.invoke('orbis:openLibrary'),
  openGraph: (id) => ipcRenderer.invoke('orbis:openGraph', id),
  onLibraryChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('orbis:libraryChanged', handler);
    return () => ipcRenderer.removeListener('orbis:libraryChanged', handler);
  },
});
