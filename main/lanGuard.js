'use strict';

// LAN-only enforcement. Any socket whose remote address is not inside a
// private / loopback range is rejected before it can exchange data.

function cleanIp(ip) {
  if (!ip) return '';
  // Strip IPv4-mapped IPv6 prefix and zone identifiers.
  return ip.replace('::ffff:', '').replace(/%.*$/, '').trim();
}

function isLanIp(ip) {
  const clean = cleanIp(ip);
  if (clean === '::1') return true; // IPv6 loopback
  return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(clean);
}

// Attach a guard to a ws server. Closes any connection from a non-LAN peer.
function guard(req, ws) {
  const ip = req.socket.remoteAddress;
  if (!isLanIp(ip)) {
    try {
      ws.close(1008, 'Not on LAN');
    } catch (_) {
      /* socket already gone */
    }
    return false;
  }
  return true;
}

module.exports = { isLanIp, cleanIp, guard };
