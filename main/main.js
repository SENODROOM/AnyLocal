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
// Ask the Windows "py" launcher which interpreters exist and return their tags
// (e.g. "3.13", "3.12") EXCLUDING free-threaded builds ("3.13t"). Free-threaded
// Python has no prebuilt binary wheels for Pillow/mss, so the sidecar's C
// extensions fail to import there — we must never pick it. Highest version first.
function listPythonTags() {
  try {
    const out = execSync('py --list', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const tags = [];
    for (const line of out.split(/\r?\n/)) {
      // Lines look like:  -V:3.13t *   Python 3.13 (64-bit, freethreaded)
      const m = line.match(/-V:([0-9]+\.[0-9]+)(t?)\b/);
      if (!m) continue;
      if (m[2] === 't' || /freethreaded/i.test(line)) continue; // skip no-GIL builds
      if (!tags.includes(m[1])) tags.push(m[1]);
    }
    tags.sort((a, b) => parseFloat(b) - parseFloat(a));
    return tags;
  } catch (_) {
    return [];
  }
}

// Build the ordered list of launch commands to try for the Python-source dev
// fallback. Each entry is { cmd, pre } where `pre` are args before the script.
// The caller appends the script + mode args and tries the next entry if one
// exits immediately (e.g. a broken interpreter with missing deps).
function pythonLaunchCommands() {
  if (process.platform !== 'win32') {
    return [{ cmd: 'python3', pre: [] }, { cmd: 'python', pre: [] }];
  }
  const cmds = [];
  for (const tag of listPythonTags()) cmds.push({ cmd: 'py', pre: [`-${tag}`] });
  cmds.push({ cmd: 'python', pre: [] });      // PATH python (non-freethreaded, hopefully)
  cmds.push({ cmd: 'py', pre: ['-3'] });      // last resort: launcher default
  return cmds;
}

function resolveSidecar() {
  const candidates = [
    path.join(process.resourcesPath || '', 'landesk-sidecar.exe'),
    path.join(__dirname, '..', 'python-sidecar', 'dist', 'landesk-sidecar.exe'),
    path.join(__dirname, '..', 'resources', 'landesk-sidecar.exe')
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return { type: 'exe', path: c };
  }
  // Dev fallback: run python source, trying real (non-freethreaded) interpreters
  // in turn until one starts and keeps running.
  const pySrc = path.join(__dirname, '..', 'python-sidecar', 'main.py');
  if (fs.existsSync(pySrc)) {
    return { type: 'py', script: pySrc, commands: pythonLaunchCommands() };
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

  // Ordered launch attempts. For a bundled .exe there's exactly one; for the
  // Python-source fallback we try each real interpreter until one stays alive.
  const attempts = resolved.type === 'py'
    ? resolved.commands.map((c) => ({ cmd: c.cmd, args: [...c.pre, resolved.script, '--mode', 'host'] }))
    : [{ cmd: resolved.path, args: ['--mode', 'host'] }];

  let attemptIdx = 0;
  let lastStderr = '';

  function spawnAttempt() {
    const a = attempts[attemptIdx];
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(a.cmd, a.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return handleFailure(err.message, startedAt);
    }
    sidecar = child;

    child.stderr.on('data', (d) => {
      const s = d.toString().trim();
      lastStderr = s;
      console.error('[sidecar]', s);
    });

    child.on('error', (err) => {
      // Interpreter/executable not found — treat as a failed attempt.
      if (sidecar !== child) return;
      handleFailure(err.message, startedAt);
    });

    child.on('exit', (code) => {
      if (sidecar !== child) return; // superseded by a newer attempt
      console.log('[host] sidecar exited:', code);
      // A crash-on-startup (quick, non-zero exit) means this interpreter is
      // missing deps or broken — advance to the next candidate.
      const quick = Date.now() - startedAt < 4000;
      if (code !== 0 && quick && attemptIdx + 1 < attempts.length) {
        console.warn('[host] "%s" failed to start; trying next interpreter', a.cmd + ' ' + a.args.slice(0, 1).join(' '));
        return handleFailure(lastStderr || `exit ${code}`, startedAt, /*advance*/ true);
      }
      sidecar = null;
      if (hostMode) disableHostMode();
    });

    attachFrameParser(child.stdout);
  }

  function handleFailure(message, startedAt, forceAdvance) {
    if (forceAdvance || attemptIdx + 1 < attempts.length) {
      attemptIdx++;
      if (attemptIdx < attempts.length) { spawnAttempt(); return; }
    }
    console.error('[host] all sidecar launch attempts failed:', message);
    sidecar = null;
    const hint = /_imaging|No module named|ImportError|ModuleNotFound/i.test(message)
      ? 'Screen-capture Python deps are missing/broken. Run: py -3 -m pip install Pillow mss pynput'
      : message;
    if (mainWindow) mainWindow.webContents.send('host-error', hint);
    if (hostMode) disableHostMode();
  }

  spawnAttempt();

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
  // Controller asks a peer to share its screen. The peer auto-accepts (see
  // autoAcceptConnect) and streams back — no interaction needed on that side.
  ipcMain.handle('request-connect', (_e, host) => {
    discovery.sendConnectRequest(host.address, { name: os.hostname(), os: process.platform });
    return { ok: true };
  });
}

// Auto-accept an incoming connect request: enable host mode (if not already),
// let the sidecar warm up, then tell the requester to open the stream.
function autoAcceptConnect(fromInfo) {
  const res = enableHostMode();
  if (!res.ok) {
    console.error('[host] auto-accept failed to enable host mode:', res.error);
    return;
  }
  // Let the requester's UI show who just connected to them.
  if (mainWindow) mainWindow.webContents.send('incoming-connection', fromInfo);
  // Give the sidecar a moment to open its capture loop before the stream opens.
  setTimeout(() => {
    discovery.sendConnectAccept(fromInfo.address, {
      name: os.hostname(),
      videoPort: VIDEO_PORT,
      inputPort: INPUT_PORT,
    });
  }, res.already ? 0 : 500);
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
    // Incoming connect requests are AUTO-ACCEPTED: the app silently enables host
    // mode and streams back. No prompt on the target machine — connecting is a
    // single click on the controller. (LAN-only; non-private IPs are rejected by
    // lanGuard on the WebSocket upgrade.)
    discovery.setRequestHandlers(
      (from) => { autoAcceptConnect(from); },
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
