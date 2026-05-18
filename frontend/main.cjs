const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let mainWindow;
let backendProcess = null;

function startBackend() {
  let executable;
  let args = [];

  if (app.isPackaged) {
    // In AppImage, extraResources go into the 'resources' folder
    executable = path.join(process.resourcesPath, 'api');
    
    // Linux permission fix
    if (process.platform !== 'win32' && fs.existsSync(executable)) {
      try {
        fs.chmodSync(executable, '755');
      } catch (e) {
        console.error("Failed to set executable permissions", e);
      }
    }
  } else {
    // Development mode
    executable = 'python3';
    args = [path.join(__dirname, '../backend/app.py')];
  }

  if (app.isPackaged && !fs.existsSync(executable)) {
    dialog.showErrorBox("Backend Error", `Could not find api at: ${executable}`);
    return;
  }

  backendProcess = spawn(executable, args, {
    cwd: app.isPackaged ? process.resourcesPath : path.join(__dirname, '../backend'),
    env: { ...process.env, WERKZEUG_RUN_MAIN: 'true' }
  });

  backendProcess.stdout.on('data', (data) => console.log(`[Backend]: ${data}`));
  backendProcess.stderr.on('data', (data) => console.error(`[Backend Err]: ${data}`));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  startBackend();
  createWindow();
});

app.on('will-quit', () => {
  if (backendProcess) backendProcess.kill();
});
