'use strict';

// WebSocket input server (default port 8766).
// Kept on a dedicated port so input events are never queued behind video frames.
// Each incoming JSON event is written straight to the sidecar's stdin as one line.

const { WebSocketServer } = require('ws');
const { guard } = require('./lanGuard');

let wss = null;

// getSidecar(): returns the live child_process for the running host sidecar (or null)
function startInputServer(port = 8766, getSidecar, opts = {}) {
  if (wss) return wss;

  wss = new WebSocketServer({ port });

  wss.on('connection', (ws, req) => {
    if (!guard(req, ws)) return;
    // Exclusive session: only the current session peer may inject input.
    if (typeof opts.allowFrom === 'function' && !opts.allowFrom(req.socket.remoteAddress)) {
      console.log('[input] refused non-session client:', req.socket.remoteAddress);
      try { ws.close(4003, 'busy'); } catch (_) { ws.terminate(); }
      return;
    }
    console.log('[input] client connected:', req.socket.remoteAddress);

    ws.on('message', (data) => {
      const sidecar = typeof getSidecar === 'function' ? getSidecar() : null;
      if (!sidecar || !sidecar.stdin.writable) return;

      // Validate it is JSON and a known event type before forwarding.
      let evt;
      try {
        evt = JSON.parse(data.toString());
      } catch (_) {
        return;
      }
      const allowed = ['mousemove', 'click', 'scroll', 'keydown', 'keyup', 'config'];
      if (!evt || !allowed.includes(evt.type)) return;

      sidecar.stdin.write(JSON.stringify(evt) + '\n');
    });

    ws.on('error', (e) => console.error('[input] client error:', e.message));
  });

  wss.on('error', (e) => console.error('[input] server error:', e.message));

  console.log('[input] server listening on', port);
  return wss;
}

function stopInputServer() {
  if (wss) {
    // Kill existing clients too — otherwise a controller keeps an open input
    // pipe after Stop control and mouse/keyboard injection appears to continue.
    for (const c of wss.clients) {
      try { c.terminate(); } catch (_) {}
    }
    try { wss.close(); } catch (_) {}
  }
  wss = null;
}

module.exports = { startInputServer, stopInputServer };
