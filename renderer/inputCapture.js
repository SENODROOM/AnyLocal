'use strict';

// Captures mouse + keyboard from the canvas and forwards them to the host over
// the dedicated input WebSocket (port 8766). Coordinates are scaled from the
// displayed canvas rect to the remote screen resolution reported by streamView.

window.LANDesk = window.LANDesk || {};

LANDesk.input = (function () {
  const canvas = LANDesk.stream.canvas;
  let ws = null;
  let active = false;
  let listenersBound = false;

  function send(evt) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(evt));
    }
  }

  function scaleX(clientX) {
    const r = canvas.getBoundingClientRect();
    const rw = LANDesk.stream.remoteW || canvas.width || 1;
    if (r.width === 0) return 0;
    return Math.round((clientX - r.left) * (rw / r.width));
  }
  function scaleY(clientY) {
    const r = canvas.getBoundingClientRect();
    const rh = LANDesk.stream.remoteH || canvas.height || 1;
    if (r.height === 0) return 0;
    return Math.round((clientY - r.top) * (rh / r.height));
  }

  function btnName(button) {
    if (button === 0) return 'left';
    if (button === 2) return 'right';
    return 'middle';
  }

  // --- handlers (named so they can be removed) ---
  const onMove = (e) => {
    if (!active) return;
    send({ type: 'mousemove', x: scaleX(e.clientX), y: scaleY(e.clientY) });
  };
  const onDown = (e) => {
    if (!active) return;
    e.preventDefault();
    canvas.focus();
    send({ type: 'click', btn: btnName(e.button), down: true, x: scaleX(e.clientX), y: scaleY(e.clientY) });
  };
  const onUp = (e) => {
    if (!active) return;
    e.preventDefault();
    send({ type: 'click', btn: btnName(e.button), down: false, x: scaleX(e.clientX), y: scaleY(e.clientY) });
  };
  const onContext = (e) => { if (active) e.preventDefault(); };
  const onWheel = (e) => {
    if (!active) return;
    e.preventDefault();
    send({ type: 'scroll', delta: e.deltaY > 0 ? -1 : 1 });
  };
  const onKeyDown = (e) => {
    if (!active || document.activeElement !== canvas) return;
    e.preventDefault();
    send({ type: 'keydown', key: e.key });
  };
  const onKeyUp = (e) => {
    if (!active || document.activeElement !== canvas) return;
    e.preventDefault();
    send({ type: 'keyup', key: e.key });
  };

  function bindListeners() {
    if (listenersBound) return;
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mouseup', onUp);
    canvas.addEventListener('contextmenu', onContext);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('focus', () => canvas.classList.add('focused'));
    canvas.addEventListener('blur', () => canvas.classList.remove('focused'));
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    listenersBound = true;
  }

  function connect(host) {
    disconnect();
    bindListeners();
    const addr = `ws://${host.address}:${host.inputPort || 8766}`;
    ws = new WebSocket(addr);
    ws.onopen = () => { active = true; console.log('[input] connected', addr); };
    ws.onclose = () => { active = false; console.log('[input] closed'); };
    ws.onerror = (e) => console.error('[input] error', e.message || e);
  }

  function disconnect() {
    active = false;
    if (ws) {
      try { ws.onclose = null; ws.close(); } catch (_) {}
    }
    ws = null;
    canvas.classList.remove('focused');
  }

  function sendConfig(quality) {
    send({ type: 'config', quality });
  }

  return { connect, disconnect, sendConfig };
})();
