const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });
}


ipcMain.handle('pdf:pick-file', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择 PDF 文件',
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });

  if (result.canceled || !result.filePaths.length) {
    return { canceled: true };
  }

  return {
    canceled: false,
    path: result.filePaths[0],
  };
});

ipcMain.handle('pdf:read-file', async (_event, filePath) => {
  if (!filePath) {
    throw new Error('filePath is required');
  }

  const resolved = path.resolve(filePath);
  const data = fs.readFileSync(resolved);

  return {
    path: resolved,
    name: path.basename(resolved),
    size: data.byteLength,
    bytesBase64: data.toString('base64'),
  };
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
