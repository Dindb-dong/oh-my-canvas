const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['workspace','activate-document','show-library','close-document','runtime-command','runtime-ready','cancel-close','pick-files','library','snapshot','create','open','rename','duplicate','delete','commit','bootstrap','undo','redo','flush','import','export','export-file','thumbnail','mcp-info','host','invite','join','leave','cursor','preferences']);
contextBridge.exposeInMainWorld('omc', {
  invoke: (action, data) => {
    if (!allowed.has(action)) return Promise.reject(Error('Unknown action'));
    return ipcRenderer.invoke('omc:invoke',action,data);
  },
  on: (callback) => {
    const handler = (_, message) => callback(message);
    ipcRenderer.on('omc:event', handler);
    return () => ipcRenderer.removeListener('omc:event', handler);
  },
  toolResult: (id, result) => ipcRenderer.send('omc:tool-result',id,result),
  readyToClose: () => ipcRenderer.invoke('omc:ready-to-close'),
});
