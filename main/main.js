'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

const discovery = require('./discovery');
const { startVideoServer, broadcastFrame, stopVideoServer } = require('./wsVideoServer');
const { startInputServer, stopInputServer } = require('./wsInputServer');

const VIDEO_PORT = 8765;
const INPUT_PORT = 8766;

let mainWindow = null;
let tray = null;
let sidecar = null;
let hostMode = false;
let firewallConfigured = false;

// ---------------------------------------------------------------------------
// Sidecar resolution: prefer the bundled .exe, fall back to running the Python
// source directly so the app is testable in dev without a PyInstaller build.
// ---------------------------------------------------------------------------
function resolveSidecar() {
  const candidates = [
    path.join(process.resourcesPath || '', 'landesk-sidecar.exe'),
    path.join(__dirname, '..', 'python-sidecar', 'dist', 'landesk-sidecar.exe'),
    path.join(__dirname, '..', 'resources', 'landesk-sidecar.exe')
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return { type: 'exe', path: c };
  }
  // Dev fallback: run python source. On Windows prefer the "py" launcher, then
  // fall back to "python" (PATH). On other platforms use python3.
  const pySrc = path.join(__dirname, '..', 'python-sidecar', 'main.py');
  if (fs.existsSync(pySrc)) {
    if (process.platform === 'win32') {
      return { type: 'py', path: 'py', pyArgs: ['-3'], script: pySrc, altPath: 'python' };
    }
    return { type: 'py', path: 'python3', script: pySrc };
  }
  return null;
}

// ---------------------------------------------------------------------------
// stdout frame de-framing.  Protocol: [4-byte BE length][payload bytes] ...
// ---------------------------------------------------------------------------
function attachFrameParser(stream) {
  let buf = Buffer.alloc(0);
  stream.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // Extract every complete frame currently buffered.
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) break; // wait for the rest
      const frame = buf.subarray(4, 4 + len);
      broadcastFrame(Buffer.from(frame));
      buf = buf.subarray(4 + len);
    }
  });
}

// ---------------------------------------------------------------------------
// Windows Firewall: open our three ports on first Host Mode enable.
// ---------------------------------------------------------------------------
function configureFirewall() {
  if (firewallConfigured || process.platform !== 'win32') return;
  const rules = [
    `netsh advfirewall firewall add rule name="LANDesk Video" dir=in action=allow protocol=TCP localport=${VIDEO_PORT}`,
    `netsh advfirewall firewall add rule name="LANDesk Input" dir=in action=allow protocol=TCP localport=${INPUT_PORT}`,
    `netsh advfirewall firewall add rule name="LANDesk Discovery" dir=in action=allow protocol=UDP localport=${discovery.DISCOVERY_PORT}`
  ];
  for (const r of rules) {
    try {
      execSync(r, { stdio: 'ignore' });
    } catch (_) {
      // Likely no admin rights — Windows will show its own allow prompt instead.
    }
  }
  firewallConfigured = true;
}

// ---------------------------------------------------------------------------
// Host mode
// ---------------------------------------------------------------------------
function enableHostMode() {
  if (hostMode) return { ok: true, already: true };

  const resolved = resolveSidecar();
  if (!resolved) {
    const msg = 'Sidecar not found. Build it with "npm run build-sidecar" or install Python.';
    console.error('[host]', msg);
    if (mainWindow) mainWindow.webContents.send('host-error', msg);
    return { ok: false, error: msg };
  }

  configureFirewall();

  const args = resolved.type === 'py'
    ? [...(resolved.pyArgs || []), resolved.script, '--mode', 'host']
    : ['--mode', 'host'];

  let triedAlt = false;

  // Attach stdout/stderr/exit handlers to the current `sidecar` child.
  function wireSidecar() {
    sidecar.stderr.on('data', (d) => console.error('[sidecar]', d.toString().trim()));
    sidecar.on('exit', (code) => {
      console.log('[host] sidecar exited:', code);
      sidecar = null;
      if (hostMode) disableHostMode();
    });
    sidecar.on('error', (err) => {
      // If the "py" launcher is missing, retry once with plain "python".
      if (!triedAlt && resolved.type === 'py' && resolved.altPath) {
        triedAlt = true;
        console.warn('[host] "%s" failed (%s); retrying with "%s"', resolved.path, err.message, resolved.altPath);
        sidecar = spawn(resolved.altPath, [resolved.script, '--mode', 'host'], { stdio: ['pipe', 'pipe', 'pipe'] });
        wireSidecar();
        return;
      }
      console.error('[host] sidecar spawn error:', err.message);
      if (mainWindow) mainWindow.webContents.send('host-error', err.message);
    });
    attachFrameParser(sidecar.stdout);
  }

  sidecar = spawn(resolved.path, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  wireSidecar();

  startVideoServer(VIDEO_PORT);
  startInputServer(INPUT_PORT, () => sidecar);
  discovery.setHostReady(true, VIDEO_PORT, INPUT_PORT);

  hostMode = true;
  updateTrayMenu();
  if (mainWindow) mainWindow.webContents.send('host-state', { hostMode: true });
  console.log('[host] enabled');
  return { ok: true };
}

function disableHostMode() {
  hostMode = false;
  discovery.setHostReady(false);
  stopVideoServer();
  stopInputServer();
  if (sidecar) {
    try { sidecar.kill(); } catch (_) {}
    sidecar = null;
  }
  updateTrayMenu();
  if (mainWindow) mainWindow.webContents.send('host-state', { hostMode: false });
  console.log('[host] disabled');
}

// ---------------------------------------------------------------------------
// Window + tray
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d1117',
    icon: path.join(__dirname, '..', 'resources', 'icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('close', (e) => {
    // Keep running in the tray instead of quitting.
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function trayImage() {
  const icoPath = path.join(__dirname, '..', 'resources', 'tray-icon.ico');
  if (fs.existsSync(icoPath)) return icoPath;
  // 1x1 fallback so the app still runs without an icon asset.
  return nativeImage.createEmpty();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: () => { if (mainWindow) mainWindow.show(); } },
    {
      label: hostMode ? 'Disable Host Mode' : 'Enable Host Mode',
      click: () => (hostMode ? disableHostMode() : enableHostMode())
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
  tray.setToolTip(hostMode ? 'LANDesk — Host running' : 'LANDesk — Controller');
}

function createTray() {
  tray = new Tray(trayImage());
  updateTrayMenu();
  tray.on('double-click', () => { if (mainWindow) mainWindow.show(); });
}

// ---------------------------------------------------------------------------
// IPC bridge
// ---------------------------------------------------------------------------
function wireIpc() {
  ipcMain.handle('get-hosts',    () => discovery.getHosts());
  ipcMain.handle('enable-host',  () => enableHostMode());
  ipcMain.handle('disable-host', () => disableHostMode());
  ipcMain.handle('host-state',   () => ({ hostMode }));
  ipcMain.handle('get-self', () => ({
    name: os.hostname(),
    os: process.platform,
    videoPort: VIDEO_PORT,
    inputPort: INPUT_PORT
  }));

  // P2P direct-connect signalling ----------------------------------------
  ipcMain.handle('request-connect', (_e, host) => {
    discovery.sendConnectRequest(host.address, { name: os.hostname(), os: process.platform });
    return { ok: true };
  });

  ipcMain.handle('accept-connect', async (_e, fromInfo) => {
    const res = enableHostMode();
    // Give the sidecar ~500 ms to open its capture loop before we tell the
    // requester to open the stream.
    await new Promise(r => setTimeout(r, 500));
    discovery.sendConnectAccept(fromInfo.address, {
      name: os.hostname(),
      videoPort: VIDEO_PORT,
      inputPort: INPUT_PORT,
    });
    return res;
  });

  ipcMain.handle('deny-connect', (_e, fromInfo) => {
    discovery.sendConnectDeny(fromInfo.address, { name: os.hostname() });
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  app.whenReady().then(() => {
    wireIpc();
    createWindow();
    createTray();

    // Every instance broadcasts as a visible peer from the start (hostReady:false).
    // Enabling Host Mode flips it to hostReady:true with the WS ports.
    discovery.startBroadcasting({ name: os.hostname() });

    // Wire up P2P signalling callbacks before starting the listener.
    discovery.setRequestHandlers(
      (from) => { if (mainWindow) mainWindow.webContents.send('connect-request',  from); },
      (from) => { if (mainWindow) mainWindow.webContents.send('connect-accepted', from); },
      (from) => { if (mainWindow) mainWindow.webContents.send('connect-denied',   from); }
    );

    // Controller mode: listen for peer/host beacons and signalling.
    discovery.startListening(
      (host) => { if (mainWindow) mainWindow.webContents.send('host-found', host); },
      (host) => { if (mainWindow) mainWindow.webContents.send('host-lost',  host); }
    );

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Stay alive in tray; only quit explicitly.
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    disableHostMode();
    discovery.stopListening();
  });
}
