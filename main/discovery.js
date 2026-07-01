'use strict';

// UDP discovery for LANDesk.
//  - Every instance broadcasts a peer beacon (hostReady:false) from startup.
//  - Enabling Host Mode flips the beacon to hostReady:true with ports.
//  - Controller side listens on 54321, tracks live peers, expires stale ones (8s).
//  - Unicast messages on the same port carry connect-request / accept / deny.

const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');

// Unique per app launch — lets us ignore our own broadcast (which loops back on
// the same host) so a machine never lists itself as a connectable device.
const INSTANCE_ID = crypto.randomBytes(8).toString('hex');

const DISCOVERY_PORT     = 54321;
const BROADCAST_ADDR     = '255.255.255.255';
const BROADCAST_INTERVAL = 2000;
const EXPIRY_MS          = 8000;

const MSG_BEACON  = 'LANDesk-Host';
const MSG_REQUEST = 'LANDesk-Request';
const MSG_ACCEPT  = 'LANDesk-Accept';
const MSG_DENY    = 'LANDesk-Deny';
const MSG_BYE     = 'LANDesk-Bye';

let broadcastSocket = null;
let broadcastTimer  = null;
let listenSocket    = null;
let expiryTimer     = null;

// Dynamic portion of the beacon. `hostReady` = actively sharing (with ports);
// `busy` = already in a 1:1 control session so it can't be connected to.
let _state = { hostReady: false, busy: false, port: undefined, inputPort: undefined };
function buildExtra() {
  const e = { hostReady: _state.hostReady, busy: _state.busy };
  if (_state.hostReady) { e.port = _state.port; e.inputPort = _state.inputPort; }
  return e;
}

// P2P signalling callbacks set by setRequestHandlers().
let _onRequest = null;
let _onAccept  = null;
let _onDeny    = null;
let _onBye     = null;

// Map<string key, hostInfo>
const hosts = new Map();

function localKey(addr, name) {
  return `${addr}:${name}`;
}

// ---- Broadcast (always on after app start) --------------------------------

function startBroadcasting(opts = {}) {
  if (broadcastSocket) return;

  const basePayload = {
    name: opts.name || os.hostname(),
    os: process.platform,
    type: MSG_BEACON,
    id: INSTANCE_ID,
  };

  broadcastSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  broadcastSocket.on('error', (err) => {
    console.error('[discovery] broadcast error:', err.message);
  });

  broadcastSocket.bind(() => {
    broadcastSocket.setBroadcast(true);
    const send = () => {
      const buf = Buffer.from(JSON.stringify({ ...basePayload, ...buildExtra() }));
      broadcastSocket.send(buf, 0, buf.length, DISCOVERY_PORT, BROADCAST_ADDR, (err) => {
        if (err) console.error('[discovery] send failed:', err.message);
      });
    };
    send();
    broadcastTimer = setInterval(send, BROADCAST_INTERVAL);
  });

  console.log('[discovery] broadcasting as', basePayload.name);
}

// Called by main.js when Host Mode is toggled.
function setHostReady(ready, videoPort, inputPort) {
  _state.hostReady = !!ready;
  _state.port = ready ? videoPort : undefined;
  _state.inputPort = ready ? inputPort : undefined;
}

// Called by main.js when this machine enters/leaves a 1:1 control session so
// other peers show it as unavailable.
function setBusy(busy) {
  _state.busy = !!busy;
}

function stopBroadcasting() {
  if (broadcastTimer) clearInterval(broadcastTimer);
  broadcastTimer = null;
  if (broadcastSocket) {
    try { broadcastSocket.close(); } catch (_) {}
  }
  broadcastSocket = null;
}

// ---- Unicast signalling ---------------------------------------------------

function sendUnicast(address, payload) {
  const sock = dgram.createSocket('udp4');
  const buf = Buffer.from(JSON.stringify(payload));
  sock.send(buf, 0, buf.length, DISCOVERY_PORT, address, () => {
    try { sock.close(); } catch (_) {}
  });
}

function sendConnectRequest(targetAddress, selfInfo) {
  sendUnicast(targetAddress, { type: MSG_REQUEST, from: selfInfo.name, os: selfInfo.os });
}

function sendConnectAccept(targetAddress, selfInfo) {
  sendUnicast(targetAddress, {
    type: MSG_ACCEPT,
    from: selfInfo.name,
    port: selfInfo.videoPort,
    inputPort: selfInfo.inputPort,
  });
}

function sendConnectDeny(targetAddress, selfInfo) {
  sendUnicast(targetAddress, { type: MSG_DENY, from: selfInfo.name, reason: selfInfo.reason || 'declined' });
}

// End a live session — tells the other side to tear down cleanly and go idle.
function sendConnectBye(targetAddress, selfInfo) {
  sendUnicast(targetAddress, { type: MSG_BYE, from: selfInfo.name });
}

// Register callbacks for incoming signalling messages.
function setRequestHandlers(onRequest, onAccept, onDeny, onBye) {
  _onRequest = onRequest;
  _onAccept  = onAccept;
  _onDeny    = onDeny;
  _onBye     = onBye;
}

// ---- Listen --------------------------------------------------------------

function startListening(onHost, onLost) {
  if (listenSocket) return;

  listenSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  listenSocket.on('error', (err) => {
    console.error('[discovery] listen error:', err.message);
  });

  listenSocket.on('message', (msg, rinfo) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch (_) { return; }
    if (!data) return;

    // P2P signalling messages (unicast).
    if (data.type === MSG_REQUEST) {
      if (typeof _onRequest === 'function') {
        _onRequest({ name: data.from, os: data.os || 'unknown', address: rinfo.address });
      }
      return;
    }
    if (data.type === MSG_ACCEPT) {
      if (typeof _onAccept === 'function') {
        _onAccept({
          name: data.from,
          address: rinfo.address,
          port: data.port || 8765,
          inputPort: data.inputPort || 8766,
          hostReady: true,
        });
      }
      return;
    }
    if (data.type === MSG_DENY) {
      if (typeof _onDeny === 'function') {
        _onDeny({ name: data.from, address: rinfo.address, reason: data.reason || 'declined' });
      }
      return;
    }
    if (data.type === MSG_BYE) {
      if (typeof _onBye === 'function') {
        _onBye({ name: data.from, address: rinfo.address });
      }
      return;
    }

    // Peer / host beacons (broadcast). Ignore our own looped-back broadcast.
    if (data.type !== MSG_BEACON) return;
    if (data.id && data.id === INSTANCE_ID) return;

    const key = localKey(rinfo.address, data.name);
    const host = {
      key,
      name: data.name,
      address: rinfo.address,
      port: data.port || 8765,
      inputPort: data.inputPort || 8766,
      os: data.os || 'unknown',
      hostReady: !!data.hostReady,
      busy: !!data.busy,
      lastSeen: Date.now(),
    };
    hosts.set(key, host);
    if (typeof onHost === 'function') onHost(host);
  });

  listenSocket.bind(DISCOVERY_PORT, () => {
    console.log('[discovery] listening on', DISCOVERY_PORT);
  });

  expiryTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, host] of hosts) {
      if (now - host.lastSeen > EXPIRY_MS) {
        hosts.delete(key);
        if (typeof onLost === 'function') onLost(host);
      }
    }
  }, 2000);
}

function stopListening() {
  if (expiryTimer) clearInterval(expiryTimer);
  expiryTimer = null;
  if (listenSocket) {
    try { listenSocket.close(); } catch (_) {}
  }
  listenSocket = null;
  hosts.clear();
}

function getHosts() {
  return Array.from(hosts.values());
}

module.exports = {
  startBroadcasting,
  stopBroadcasting,
  setHostReady,
  setBusy,
  startListening,
  stopListening,
  setRequestHandlers,
  sendConnectRequest,
  sendConnectAccept,
  sendConnectDeny,
  sendConnectBye,
  getHosts,
  DISCOVERY_PORT,
};
