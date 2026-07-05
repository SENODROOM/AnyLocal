'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

const discovery = require('./discovery');
const { startVideoServer, broadcastFrame, stopVideoServer, countClients } = require('./wsVideoServer');
const { startInputServer, stopInputServer } = require('./wsInputServer');

// Node reports LAN peers as IPv6-mapped IPv4 ("::ffff:192.168.1.5") on the WS
// side, while UDP discovery reports plain IPv4 — normalize before comparing.
function normIp(addr) {
  return String(addr || '').replace(/^::ffff:/i, '');
}

const VIDEO_PORT = 8765;
const INPUT_PORT = 8766;

let mainWindow = null;
let tray = null;
let sidecar = null;
let hostMode = false;
let hostStopping = false;   // true while we deliberately tear the sidecar down
let firewallConfigured = false;

// -------------------------------------------------------------------------
// Exclusive 1:1 session state (AnyDesk-style). A machine is either:
//   'idle'       — free to connect or be connected to
//   'controller' — actively controlling `peer`
//   'host'       — being controlled by `peer`
// Whoever clicks Connect first wins; the other side is told the peer is busy.
// -------------------------------------------------------------------------
let session = { role: 'idle', peer: null, pending: false };
let detachTimer = null;       // fires when the controller's video socket is gone

function setSession(role, peer) {
  session = { role, peer: peer || null, pending: false };
  clearTimeout(detachTimer);
  detachTimer = null;
  discovery.setBusy(role !== 'idle');
  if (mainWindow) mainWindow.webContents.send('session-state', { role, peer: peer || null });
  updateTrayMenu();
}

// While hosting, only the session peer may attach to the video/input servers.
// Outside a session (manual tray host mode) any LAN client is allowed.
function sessionAllows(remoteAddr) {
  if (session.role !== 'host' || !session.peer) return true;
  return normIp(remoteAddr) === normIp(session.peer.address);
}

// The controller's *actual* video connection drives the truth on the host:
// attach → show the "being controlled" banner; detach (with a short grace for
// reconnects) → the session is over, stop sharing.
function onControllerCount(n) {
  if (session.role !== 'host') return;
  if (n > 0) {
    clearTimeout(detachTimer);
    detachTimer = null;
    if (mainWindow) mainWindow.webContents.send('being-controlled', session.peer);
  } else {
    clearTimeout(detachTimer);
    detachTimer = setTimeout(() => {
      if (session.role === 'host' && countClients() === 0) {
        const peer = session.peer;
        console.log('[session] controller detached — ending host session');
        endSession(false);
        if (mainWindow) mainWindow.webContents.send('session-ended', { peer, role: 'host', reason: 'detached' });
      }
    }, 4000);
  }
}

// Local user (or a timed-out request) ends the session cleanly.
function endSession(notifyPeer) {
  if (session.role === 'idle') return;
  const s = session;
  setSession('idle', null);                     // flip first so teardown paths no-op
  if (notifyPeer && s.peer) {
    discovery.sendConnectBye(s.peer.address, { name: os.hostname() });
  }
  if (s.role === 'host') disableHostMode();
}

// The host side lost its sidecar unexpectedly (crash): tell the controller.
function teardownHostSession(reason) {
  if (session.role !== 'host') return;
  const peer = session.peer;
  if (peer) discovery.sendConnectBye(peer.address, { name: os.hostname() });
  setSession('idle', null);
  if (mainWindow) mainWindow.webContents.send('session-ended', { peer, role: 'host', reason });
}

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
  const cmds = [];
  // A project virtualenv is where the sidecar deps (mss/pynput/Pillow) actually
  // live in dev — global interpreters usually don't have them, and picking one
  // of those makes the sidecar crash on import and kills the session right
  // after it connects. Always try the venv first.
  const venvPy = process.platform === 'win32'
    ? ['Scripts', 'python.exe']
    : ['bin', 'python'];
  for (const root of [
    path.join(__dirname, '..', '.venv'),
    path.join(__dirname, '..', 'python-sidecar', '.venv'),
  ]) {
    const py = path.join(root, ...venvPy);
    if (fs.existsSync(py)) cmds.push({ cmd: py, pre: [] });
  }
  if (process.platform !== 'win32') {
    cmds.push({ cmd: 'python3', pre: [] }, { cmd: 'python', pre: [] });
    return cmds;
  }
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
  hostStopping = false;

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
      // A deliberate teardown (disableHostMode) — don't try to "recover".
      if (hostStopping) { sidecar = null; return; }
      // A crash-on-startup (quick, non-zero exit) means this interpreter is
      // missing deps or broken — advance to the next candidate.
      const quick = Date.now() - startedAt < 4000;
      if (code !== 0 && quick && attemptIdx + 1 < attempts.length) {
        console.warn('[host] "%s" failed to start; trying next interpreter', a.cmd + ' ' + a.args.slice(0, 1).join(' '));
        return handleFailure(lastStderr || `exit ${code}`, startedAt, /*advance*/ true);
      }
      // Unexpected crash while hosting — drop host mode and end the session.
      sidecar = null;
      if (hostMode) disableHostMode();
      teardownHostSession('crash');
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
    teardownHostSession('error');
  }

  spawnAttempt();

  startVideoServer(VIDEO_PORT, {
    allowFrom: sessionAllows,
    onClientCount: onControllerCount,
  });
  startInputServer(INPUT_PORT, () => sidecar, { allowFrom: sessionAllows });
  discovery.setHostReady(true, VIDEO_PORT, INPUT_PORT);

  hostMode = true;
  updateTrayMenu();
  if (mainWindow) mainWindow.webContents.send('host-state', { hostMode: true });
  console.log('[host] enabled');
  return { ok: true };
}

function disableHostMode() {
  hostStopping = true;
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
  // The controller asks a peer to share its screen. Exclusive: refused locally
  // if we're already in a session (so we can't control two peers at once).
  // The REQUEST is re-sent every 2 s while pending — UDP on Wi-Fi drops packets,
  // and a single lost message must not wedge the connect flow.
  ipcMain.handle('request-connect', (_e, host) => {
    if (session.role === 'controller' && session.peer && session.peer.address === host.address) {
      discovery.sendConnectRequest(host.address, { name: os.hostname(), os: process.platform });
      return { ok: true };
    }
    if (session.role !== 'idle') {
      return { ok: false, error: 'You are already in a session. Disconnect first.' };
    }
    // Claim controller role immediately so a simultaneous incoming request from
    // the same peer is refused — whoever clicked first wins.
    setSession('controller', { name: host.name, address: host.address });
    session.pending = true;

    const sendReq = () =>
      discovery.sendConnectRequest(host.address, { name: os.hostname(), os: process.platform });
    sendReq();
    let tries = 0;
    const retry = setInterval(() => {
      const stillPending =
        session.role === 'controller' && session.pending &&
        session.peer && session.peer.address === host.address;
      if (!stillPending || ++tries >= 8) { clearInterval(retry); return; }
      sendReq();
    }, 2000);
    return { ok: true };
  });

  // Local user disconnected (or the request timed out): end the session and
  // notify the peer so it stops sharing / releases control. Always re-sync the
  // renderer's session state, even if we were already idle — this guarantees a
  // stuck banner or stale role in the UI gets cleared by the Stop button.
  ipcMain.handle('end-session', () => {
    endSession(true);
    if (mainWindow) mainWindow.webContents.send('session-state', { role: session.role, peer: session.peer });
    return { ok: true };
  });
}

// An incoming connect request. If we're free, become the HOST for that peer:
// start sharing our screen + accept its input. If we're busy, deny with 'busy'
// so the first-clicker keeps exclusive control.
function handleIncomingRequest(fromInfo) {
  console.log('[p2p] connect request from', fromInfo.name, fromInfo.address);

  // Retry from the controller we're already hosting for (its ACCEPT was likely
  // lost, or it re-clicked) — just accept again, don't treat it as a conflict.
  if (session.role === 'host' && session.peer && normIp(session.peer.address) === normIp(fromInfo.address)) {
    discovery.sendConnectAccept(fromInfo.address, {
      name: os.hostname(), videoPort: VIDEO_PORT, inputPort: INPUT_PORT,
    });
    return;
  }
  if (session.role !== 'idle') {
    discovery.sendConnectDeny(fromInfo.address, { name: os.hostname(), reason: 'busy' });
    return;
  }
  setSession('host', { name: fromInfo.name, address: fromInfo.address });

  const res = enableHostMode();
  if (!res.ok) {
    discovery.sendConnectDeny(fromInfo.address, { name: os.hostname(), reason: 'error' });
    setSession('idle', null);
    return;
  }

  // NOTE: the "being controlled" banner is NOT shown here. It is driven by the
  // controller's actual video connection (onControllerCount), so it can never
  // appear on a machine that isn't really being watched.

  // If the controller never attaches (app closed, network died), don't stay
  // locked as a busy host forever.
  detachTimer = setTimeout(() => {
    if (session.role === 'host' && countClients() === 0) {
      console.log('[session] controller never attached — ending host session');
      endSession(true);
    }
  }, 15000);

  // Give the sidecar a moment to open its capture loop before the stream opens.
  setTimeout(() => {
    // Guard: the session may have ended during warmup.
    if (session.role === 'host' && session.peer && session.peer.address === fromInfo.address) {
      discovery.sendConnectAccept(fromInfo.address, {
        name: os.hostname(),
        videoPort: VIDEO_PORT,
        inputPort: INPUT_PORT,
      });
    }
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
    // Incoming requests are auto-accepted ONLY when this machine is idle; if it
    // is already in a session the request is denied 'busy' so the first-clicker
    // keeps exclusive control. (LAN-only; non-private IPs rejected by lanGuard.)
    discovery.setRequestHandlers(
      // onRequest
      (from) => { handleIncomingRequest(from); },
      // onAccept — our outbound request succeeded; open the stream as controller.
      (from) => {
        if (session.role !== 'controller' || !session.peer || session.peer.address !== from.address) return;
        session.pending = false;
        if (mainWindow) mainWindow.webContents.send('connect-accepted', from);
      },
      // onDeny — peer refused (busy / error / declined).
      (from) => {
        if (session.role === 'controller' && session.peer && session.peer.address === from.address) {
          setSession('idle', null);
        }
        if (mainWindow) mainWindow.webContents.send('connect-denied', from);
      },
      // onBye — the other side ended the session; tear down and go idle.
      (from) => {
        if (!session.peer || session.peer.address !== from.address) return;
        const role = session.role;
        if (role === 'host') disableHostMode();
        setSession('idle', null);
        if (mainWindow) mainWindow.webContents.send('session-ended', { peer: from, role });
      }
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
    endSession(true);        // tell the peer we're leaving
    disableHostMode();
    discovery.stopListening();
  });
}
