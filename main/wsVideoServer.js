'use strict';

// WebSocket video server (default port 8765).
// The Python sidecar feeds JPEG/H.264 frames into the Node main process via a
// length-prefixed stdout stream; main.js calls broadcastFrame() to fan them out
// to every connected controller. This module owns the socket lifecycle only.

const { WebSocketServer } = require('ws');
const { guard } = require('./lanGuard');

let wss = null;

function startVideoServer(port = 8765, opts = {}) {
  if (wss) return wss;

  wss = new WebSocketServer({ port });

  wss.on('connection', (ws, req) => {
    if (!guard(req, ws)) return;
    // Exclusive session: while hosting for a specific peer, only that peer may
    // attach. Anyone else is refused so a session can never be hijacked/crossed.
    if (typeof opts.allowFrom === 'function' && !opts.allowFrom(req.socket.remoteAddress)) {
      console.log('[video] refused non-session client:', req.socket.remoteAddress);
      try { ws.close(4003, 'busy'); } catch (_) { ws.terminate(); }
      return;
    }
    console.log('[video] client connected:', req.socket.remoteAddress);

    if (typeof opts.onClientCount === 'function') {
      opts.onClientCount(countClients());
    }

    ws.on('close', () => {
      console.log('[video] client disconnected');
      if (typeof opts.onClientCount === 'function') {
        opts.onClientCount(countClients());
      }
    });

    ws.on('error', (e) => console.error('[video] client error:', e.message));
  });

  wss.on('error', (e) => console.error('[video] server error:', e.message));

  console.log('[video] server listening on', port);
  return wss;
}

function countClients() {
  if (!wss) return 0;
  let n = 0;
  for (const c of wss.clients) if (c.readyState === 1) n++;
  return n;
}

// frame: Buffer of encoded image bytes (one full frame)
function broadcastFrame(frame) {
  if (!wss) return;
  for (const c of wss.clients) {
    if (c.readyState === 1) {
      c.send(frame, { binary: true });
    }
  }
}

function stopVideoServer() {
  if (wss) {
    // wss.close() alone leaves existing client sockets open, which would let a
    // controller sit on "waiting for video" forever after we stop hosting.
    for (const c of wss.clients) {
      try { c.terminate(); } catch (_) {}
    }
    try { wss.close(); } catch (_) {}
  }
  wss = null;
}

module.exports = { startVideoServer, broadcastFrame, stopVideoServer, countClients };
