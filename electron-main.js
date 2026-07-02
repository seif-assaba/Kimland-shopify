const { app, BrowserWindow, Menu, Tray, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let serverProcess;
let tray = null;
const DEFAULT_PORT = Number(process.env.PORT) || 3001;

// ========== CREATE WINDOW ==========
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false
    },
    icon: path.join(__dirname, 'assets/icon.ico'),
    title: 'Kimland → Shopify Sync',
    show: false
  });

  // Load the app
  mainWindow.loadURL(`http://127.0.0.1:${DEFAULT_PORT}`);

  // Show when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Create application menu
  createMenu();

  // Handle close
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (serverProcess) {
      serverProcess.kill();
    }
    app.quit();
  });
}

// ========== CREATE MENU ==========
function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open in Browser',
          click: () => {
            shell.openExternal(`http://127.0.0.1:${DEFAULT_PORT}`);
          }
        },
        { type: 'separator' },
        {
          label: 'Exit',
          click: () => {
            app.quit();
          }
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Documentation',
          click: () => {
            shell.openExternal('https://github.com/your-repo/kimland-shopify-sync');
          }
        },
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'About Kimland Shopify Sync',
              message: 'Kimland → Shopify Sync v1.0.0',
              detail: 'Professional product synchronization tool.\n\nCreated with ❤️ for Kimland sellers.',
              buttons: ['OK']
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ========== START SERVER ==========
function startServer() {
  console.log('🚀 Starting server...');
  
  const serverPath = path.join(__dirname, 'src', 'index.js');
  
  serverProcess = spawn(process.execPath, [serverPath], {
    stdio: 'pipe',
    env: { ...process.env, PORT: String(DEFAULT_PORT) },
    detached: false
  });

  serverProcess.stdout.on('data', (data) => {
    console.log(`[Server] ${data}`);
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`[Server Error] ${data}`);
  });

  serverProcess.on('error', (error) => {
    console.error('❌ Server error:', error);
  });

  serverProcess.on('exit', (code) => {
    console.log(`Server exited with code ${code}`);
  });
}

// ========== CREATE TRAY ==========
function createTray() {
  tray = new Tray(path.join(__dirname, 'assets/icon.ico'));
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show App',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
        }
      }
    },
    {
      label: 'Open in Browser',
      click: () => {
        shell.openExternal(`http://127.0.0.1:${DEFAULT_PORT}`);
      }
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        app.quit();
      }
    }
  ]);
  
  tray.setToolTip('Kimland Shopify Sync');
  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
    }
  });
}

// ========== APP LIFE CYCLE ==========
app.whenReady().then(() => {
  startServer();
  
  setTimeout(() => {
    createWindow();
    createTray();
  }, 4000);
});

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

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
});

// ========== IPC HANDLERS ==========
ipcMain.handle('get-version', () => {
  return app.getVersion();
});

ipcMain.handle('open-external', (event, url) => {
  shell.openExternal(url);
});

ipcMain.handle('show-save-dialog', async (event, options) => {
  const result = await dialog.showSaveDialog(options);
  return result;
});

ipcMain.handle('show-open-dialog', async (event, options) => {
  const result = await dialog.showOpenDialog(options);
  return result;
});