'use strict';

// UDP discovery for LANDesk.
//  - Host mode broadcasts a JSON presence beacon every 2s on 255.255.255.255:54321
//  - Controller mode listens on 54321, tracks live hosts, expires stale ones (8s)

const dgram = require('dgram');
const os = require('os');

const DISCOVERY_PORT = 54321;
const BROADCAST_ADDR = '255.255.255.255';
const BROADCAST_INTERVAL = 2000;
const EXPIRY_MS = 8000;

let broadcastSocket = null;
let broadcastTimer = null;
let listenSocket = null;
let expiryTimer = null;

// Map<string key, hostInfo>
const hosts = new Map();

function localKey(addr, name) {
  return `${addr}:${name}`;
}

function startBroadcasting(opts = {}) {
  if (broadcastSocket) return; // already broadcasting

  const payload = {
    name: opts.name || os.hostname(),
    port: opts.videoPort || 8765,
    inputPort: opts.inputPort || 8766,
    os: process.platform,
    type: 'LANDesk-Host'
  };

  broadcastSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  broadcastSocket.on('error', (err) => {
    console.error('[discovery] broadcast error:', err.message);
  });

  broadcastSocket.bind(() => {
    broadcastSocket.setBroadcast(true);
    const send = () => {
      // payload may change (e.g. PIN) — re-stringify each tick
      const buf = Buffer.from(JSON.stringify({ ...payload, ...opts.dynamic }));
      broadcastSocket.send(buf, 0, buf.length, DISCOVERY_PORT, BROADCAST_ADDR, (err) => {
        if (err) console.error('[discovery] send failed:', err.message);
      });
    };
    send();
    broadcastTimer = setInterval(send, BROADCAST_INTERVAL);
  });

  console.log('[discovery] broadcasting as', payload.name);
}

function stopBroadcasting() {
  if (broadcastTimer) clearInterval(broadcastTimer);
  broadcastTimer = null;
  if (broadcastSocket) {
    try { broadcastSocket.close(); } catch (_) {}
  }
  broadcastSocket = null;
}

// onHost(hostInfo) called whenever a host appears or refreshes.
// onLost(hostInfo) called when a host expires.
function startListening(onHost, onLost) {
  if (listenSocket) return;

  listenSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  listenSocket.on('error', (err) => {
    console.error('[discovery] listen error:', err.message);
  });

  listenSocket.on('message', (msg, rinfo) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (_) {
      return; // not our packet
    }
    if (!data || data.type !== 'LANDesk-Host') return;

    const key = localKey(rinfo.address, data.name);
    const existing = hosts.get(key);
    const host = {
      key,
      name: data.name,
      address: rinfo.address,
      port: data.port || 8765,
      inputPort: data.inputPort || 8766,
      os: data.os || 'unknown',
      pinRequired: !!data.pinRequired,
      lastSeen: Date.now()
    };
    hosts.set(key, host);
    if (!existing && typeof onHost === 'function') {
      onHost(host);
    } else if (existing && typeof onHost === 'function') {
      // refresh (keeps lastSeen alive on renderer side)
      onHost(host);
    }
  });

  listenSocket.bind(DISCOVERY_PORT, () => {
    console.log('[discovery] listening on', DISCOVERY_PORT);
  });

  // expiry sweep
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
  startListening,
  stopListening,
  getHosts,
  DISCOVERY_PORT
};
