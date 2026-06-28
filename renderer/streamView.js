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

  let ws = null;
  let remoteW = 0;
  let remoteH = 0;
  let frames = 0;
  let bytes = 0;
  let lastTick = performance.now();
  let statsTimer = null;
  let onResolution = null;

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
    const addr = `ws://${host.address}:${host.port}`;
    ws = new WebSocket(addr);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      console.log('[stream] connected', addr);
      startStats();
      if (typeof onOpen === 'function') onOpen();
    };
    ws.onmessage = (e) => {
      frames++;
      bytes += e.data.byteLength || 0;
      drawFrame(e.data);
    };
    ws.onclose = () => {
      console.log('[stream] closed');
      stopStats();
      setStats('');
      if (typeof onClose === 'function') onClose();
    };
    ws.onerror = (e) => console.error('[stream] error', e.message || e);
  }

  function disconnect() {
    stopStats();
    setStats('');
    if (ws) {
      try { ws.onclose = null; ws.close(); } catch (_) {}
    }
    ws = null;
    remoteW = remoteH = 0;
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
