const { contextBridge, ipcRenderer } = require('electron');
let windowVisible = true;
ipcRenderer.on('orbis:windowVisibility', (_event, visible) => {
  windowVisible = visible;
});
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
  getPreferences: () => ipcRenderer.invoke('orbis:getPreferences'),
  setPreference: (key, value) => ipcRenderer.invoke('orbis:setPreference', key, value),
  openGraph: (id) => ipcRenderer.invoke('orbis:openGraph', id),
  downloadDocument: (id) => ipcRenderer.invoke('orbis:downloadDocument', id),
  openDocument: (id) => ipcRenderer.invoke('orbis:openDocument', id),
  removeDocument: (id) => ipcRenderer.invoke('orbis:removeDocument', id),
  onWindowVisibility: (callback) => {
    const handler = (_event, visible) => callback(visible);
    ipcRenderer.on('orbis:windowVisibility', handler);
    callback(windowVisible);
    return () => ipcRenderer.removeListener('orbis:windowVisibility', handler);
  },
  onDocumentsChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('orbis:documentsChanged', handler);
    return () => ipcRenderer.removeListener('orbis:documentsChanged', handler);
  },
  onBeforeClose: (callback) => {
    const handler = async () => {
      try {
        await callback();
        await ipcRenderer.invoke('orbis:closeReady');
      } catch (error) {
        await ipcRenderer.invoke('orbis:closeReady', String(error.message || error));
      }
    };
    ipcRenderer.on('orbis:beforeClose', handler);
    return () => ipcRenderer.removeListener('orbis:beforeClose', handler);
  },
  onLibraryChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('orbis:libraryChanged', handler);
    return () => ipcRenderer.removeListener('orbis:libraryChanged', handler);
  },
});
