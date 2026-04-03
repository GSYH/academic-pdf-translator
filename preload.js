const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pdfTranslatorApi', {
  pickPdfFile: () => ipcRenderer.invoke('pdf:pick-file'),
  readPdfFile: (filePath) => ipcRenderer.invoke('pdf:read-file', filePath),
});
