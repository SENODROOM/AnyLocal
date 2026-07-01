'use strict';

// Renders the incoming video stream onto the main canvas.
// Frames arrive as binary JPEG blobs over the video WebSocket (port 8765).
// The first decoded frame establishes the remote screen resolution, which the
// input layer needs to scale pointer coordinates correctly.

window.LANDesk = window.LANDesk || {};

LANDesk.stream = (function () {
  const canvas = document.getElementById('screen');
  const ctx = canvas.getContext('2d', { alpha: false });
  const statsEl = document.getElementById('statsOverlay');
  const msgEl   = document.getElementById('streamMsg');

  let ws = null;
  let remoteW = 0;
  let remoteH = 0;
  let frames = 0;
  let bytes = 0;
  let lastTick = performance.now();
  let statsTimer = null;
  let onResolution = null;
  let gotFrame = false;
  let noFrameTimer = null;

  // Overlay shown over the (black) canvas until the first frame arrives, or to
  // explain a stall so a blank screen is never a mystery.
  function showMsg(text, sub, spinning = true) {
    if (!msgEl) return;
    msgEl.hidden = false;
    msgEl.querySelector('.stream-msg-text').textContent = text;
    msgEl.querySelector('.stream-msg-sub').textContent = sub || '';
    msgEl.querySelector('.stream-spinner').style.display = spinning ? '' : 'none';
  }
  function hideMsg() { if (msgEl) msgEl.hidden = true; }

  function setStats(text) {
    if (statsEl) statsEl.textContent = text;
  }

  function startStats() {
    stopStats();
    statsTimer = setInterval(() => {
      const now = performance.now();
      const secs = (now - lastTick) / 1000;
      const fps = secs > 0 ? frames / secs : 0;
      const kbps = secs > 0 ? (bytes * 8) / 1000 / secs : 0;
      setStats(`${remoteW}x${remoteH}  ${fps.toFixed(0)} fps  ${(kbps / 1000).toFixed(1)} Mbps`);
      frames = 0; bytes = 0; lastTick = now;
    }, 1000);
  }
  function stopStats() {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
  }

  function drawFrame(data) {
    const blob = new Blob([data], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth && img.naturalWidth !== remoteW) {
        remoteW = img.naturalWidth;
        remoteH = img.naturalHeight;
        canvas.width = remoteW;
        canvas.height = remoteH;
        if (typeof onResolution === 'function') onResolution(remoteW, remoteH);
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  function connect(host, onOpen, onClose) {
    disconnect();
    frames = 0; bytes = 0; lastTick = performance.now();
    gotFrame = false;
    const addr = `ws://${host.address}:${host.port}`;
    ws = new WebSocket(addr);
    ws.binaryType = 'arraybuffer';

    showMsg('Connecting…', addr.replace('ws://', ''));

    ws.onopen = () => {
      console.log('[stream] connected', addr);
      startStats();
      showMsg('Connected — waiting for video…', 'The other PC is starting screen capture.');
      // If no frame arrives within a few seconds, the host side isn't capturing
      // (sidecar missing / Python deps not installed on that machine).
      clearTimeout(noFrameTimer);
      noFrameTimer = setTimeout(() => {
        if (!gotFrame) {
          showMsg(
            'No video from the other PC',
            'Its screen-capture helper isn’t running. On that PC, build the sidecar (npm run build-sidecar) or install Python deps.',
            false
          );
        }
      }, 6000);
      if (typeof onOpen === 'function') onOpen();
    };
    ws.onmessage = (e) => {
      frames++;
      bytes += e.data.byteLength || 0;
      if (!gotFrame) { gotFrame = true; clearTimeout(noFrameTimer); hideMsg(); }
      drawFrame(e.data);
    };
    ws.onclose = () => {
      console.log('[stream] closed');
      stopStats();
      setStats('');
      clearTimeout(noFrameTimer);
      if (!gotFrame) showMsg('Connection closed', 'The other PC dropped the video connection.', false);
      if (typeof onClose === 'function') onClose();
    };
    ws.onerror = (e) => {
      console.error('[stream] error', e.message || e);
      showMsg('Could not connect', 'Check that the other PC is reachable on the LAN.', false);
    };
  }

  function disconnect() {
    stopStats();
    setStats('');
    clearTimeout(noFrameTimer);
    hideMsg();
    if (ws) {
      try { ws.onclose = null; ws.close(); } catch (_) {}
    }
    ws = null;
    remoteW = remoteH = 0;
    gotFrame = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  return {
    connect,
    disconnect,
    get remoteW() { return remoteW; },
    get remoteH() { return remoteH; },
    set onResolution(fn) { onResolution = fn; },
    get connected() { return !!ws && ws.readyState === 1; },
    canvas
  };
})();
