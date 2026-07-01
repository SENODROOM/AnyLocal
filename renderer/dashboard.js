'use strict';

// Dashboard: device discovery → cards, tab management, session lifecycle,
// host-mode toggle, quality / fullscreen controls, and P2P connect-request flow.

const { ipcRenderer } = require('electron');

window.LANDesk = window.LANDesk || {};

(function () {
  const deviceListEl   = document.getElementById('deviceList');
  const emptyHint      = document.getElementById('emptyHint');
  const hostCountEl    = document.getElementById('hostCount');
  const tabsEl         = document.getElementById('tabs');
  const selfInfoEl     = document.getElementById('selfInfo');
  const statusDot      = document.getElementById('statusDot');
  const toastContainer = document.getElementById('toastContainer');

  const placeholder   = document.getElementById('placeholder');
  const stage         = document.getElementById('stage');
  const qualityGroup  = document.getElementById('qualityGroup');
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const disconnectBtn = document.getElementById('disconnectBtn');

  const hosts       = new Map();  // key -> host
  const openTabs    = new Map();  // key -> host (live sessions)
  const pendingReqs = new Set();  // keys where we sent a request and are waiting
  let activeKey      = null;
  let currentQuality = 'med';

  const OS_ICON = { win32: '🪟', darwin: '🍎', linux: '🐧' };
  const OS_NAME = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

  // ----------------------------------------------------------------- latency
  function pingHost(host) {
    if (!host.hostReady) return;
    const start = performance.now();
    let done = false;
    try {
      const probe = new WebSocket(`ws://${host.address}:${host.inputPort || 8766}`);
      const finish = (val) => {
        if (done) return; done = true;
        try { probe.close(); } catch (_) {}
        host.latency = val;
        const card = deviceListEl.querySelector(`[data-key="${cssEscape(host.key)}"]`);
        if (card) updateCardLatency(card, val);
      };
      probe.onopen  = () => finish(Math.round(performance.now() - start));
      probe.onerror = () => finish(null);
      setTimeout(() => finish(host.latency ?? null), 1500);
    } catch (_) {}
  }

  function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  // ----------------------------------------------------------------- cards
  function renderDeviceList() {
    const list = Array.from(hosts.values());
    hostCountEl.textContent = String(list.length);
    hostCountEl.classList.toggle('live', list.length > 0);
    emptyHint.style.display = list.length ? 'none' : '';

    for (const el of Array.from(deviceListEl.querySelectorAll('.card'))) {
      if (!hosts.has(el.dataset.key)) el.remove();
    }
    for (const host of list) {
      let card = deviceListEl.querySelector(`[data-key="${cssEscape(host.key)}"]`);
      if (!card) {
        card = buildCard(host);
        deviceListEl.appendChild(card);
      }
      syncCardState(card, host);
    }
  }

  function buildCard(host) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.key = host.key;
    const icon = OS_ICON[host.os] || '💻';
    card.innerHTML = `
      <div class="card-row">
        <div class="card-name"><span class="os-icon">${icon}</span>${escapeHtml(host.name)}</div>
      </div>
      <div class="card-addr">${escapeHtml(host.address)}</div>
      <div class="card-meta">
        <span class="latency"><span class="ping-dot"></span><span class="ping-val">…</span></span>
        <span class="connect-pill"></span>
      </div>`;
    card.addEventListener('click', () => handleCardClick(host));
    return card;
  }

  function syncCardState(card, host) {
    const isConnected = openTabs.has(host.key);
    const isPending   = pendingReqs.has(host.key);

    card.classList.toggle('connected', isConnected);
    card.classList.toggle('pending',   isPending);

    const pill = card.querySelector('.connect-pill');
    if (!pill) return;

    if (isConnected) {
      pill.textContent  = '● Connected';
      pill.dataset.kind = 'active';
    } else if (isPending) {
      pill.textContent  = '◌ Connecting…';
      pill.dataset.kind = 'pending';
    } else {
      pill.textContent  = 'Connect →';
      pill.dataset.kind = 'connect';
      if (host.hostReady) {
        updateCardLatency(card, host.latency ?? null);
      } else {
        const dot = card.querySelector('.ping-dot');
        const txt = card.querySelector('.ping-val');
        if (dot) dot.style.visibility = 'hidden';
        if (txt) txt.textContent = 'ready';
      }
    }
  }

  function handleCardClick(host) {
    if (openTabs.has(host.key) || pendingReqs.has(host.key)) return;
    if (host.hostReady) {
      openSession(host);
    } else {
      // Ask the peer to share its screen. It auto-accepts and we open the
      // stream when the accept arrives (see 'connect-accepted' below).
      sendConnectRequest(host);
    }
  }

  function updateCardLatency(card, val) {
    const dot = card.querySelector('.ping-dot');
    const txt = card.querySelector('.ping-val');
    if (!dot || !txt) return;
    dot.style.visibility = '';
    if (val == null) {
      txt.textContent = 'offline?';
      dot.className = 'ping-dot bad';
      return;
    }
    txt.textContent = `${val} ms`;
    dot.className = 'ping-dot' + (val > 60 ? ' bad' : val > 25 ? ' high' : '');
  }

  // ----------------------------------------------------------------- P2P flow
  function sendConnectRequest(host) {
    pendingReqs.add(host.key);
    renderDeviceList();
    ipcRenderer.invoke('request-connect', host);
    // Auto-cancel if no response within 20 s.
    setTimeout(() => {
      if (pendingReqs.has(host.key)) {
        pendingReqs.delete(host.key);
        renderDeviceList();
        showStatusToast(`${host.name} did not respond`, 'warn');
      }
    }, 20000);
  }

  // Someone connected to THIS pc (auto-accepted). Just let the user know.
  ipcRenderer.on('incoming-connection', (_e, fromInfo) => {
    showStatusToast(`${escapeHtml(fromInfo.name)} connected to this PC`, 'info');
  });

  // Our request was accepted — open the stream automatically.
  ipcRenderer.on('connect-accepted', (_e, info) => {
    for (const key of pendingReqs) {
      const h = hosts.get(key);
      if (h && h.address === info.address) { pendingReqs.delete(key); break; }
    }
    const existing = Array.from(hosts.values()).find(h => h.address === info.address);
    const host = existing
      ? { ...existing, port: info.port, inputPort: info.inputPort, hostReady: true }
      : { key: `${info.address}:${info.name}`, name: info.name, address: info.address,
          port: info.port, inputPort: info.inputPort, hostReady: true, os: info.os || 'unknown' };
    hosts.set(host.key, host);
    renderDeviceList();
    openSession(host);
  });

  // Our request was denied.
  ipcRenderer.on('connect-denied', (_e, info) => {
    for (const key of pendingReqs) {
      const h = hosts.get(key);
      if (h && h.address === info.address) { pendingReqs.delete(key); break; }
    }
    renderDeviceList();
    showStatusToast(`${escapeHtml(info.name)} declined the request`, 'danger');
  });

  function showStatusToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-status toast-${type}`;
    toast.textContent = message;
    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return; dismissed = true;
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 280);
    };
    toast.addEventListener('click', dismiss);
    toastContainer.appendChild(toast);
    setTimeout(dismiss, 4000);
  }

  // ----------------------------------------------------------------- tabs
  function renderTabs() {
    tabsEl.innerHTML = '';
    for (const host of openTabs.values()) {
      const tab = document.createElement('div');
      tab.className = 'tab' + (host.key === activeKey ? ' active' : '');
      tab.innerHTML = `<span>${escapeHtml(host.name)}</span><span class="tab-close">✕</span>`;
      tab.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-close')) {
          closeSession(host.key);
        } else {
          activateSession(host.key);
        }
      });
      tabsEl.appendChild(tab);
    }
  }

  // ----------------------------------------------------------------- sessions
  function openSession(host) {
    if (!openTabs.has(host.key)) openTabs.set(host.key, host);
    activateSession(host.key);
    renderDeviceList();
  }

  function activateSession(key) {
    const host = openTabs.get(key);
    if (!host) return;
    activeKey = key;

    placeholder.hidden = false; // keep placeholder markup alive; stage covers it
    stage.hidden = false;
    placeholder.style.display = 'none';
    qualityGroup.hidden = false;
    fullscreenBtn.hidden = false;
    disconnectBtn.hidden = false;

    LANDesk.stream.connect(
      host,
      () => { statusDot.classList.add('live'); LANDesk.input.sendConfig(currentQuality); },
      () => { statusDot.classList.remove('live'); }
    );
    LANDesk.input.connect(host);
    LANDesk.stream.canvas.focus();

    renderTabs();
  }

  function closeSession(key) {
    openTabs.delete(key);
    if (activeKey === key) {
      LANDesk.stream.disconnect();
      LANDesk.input.disconnect();
      activeKey = null;
      const next = openTabs.keys().next();
      if (!next.done) {
        activateSession(next.value);
      } else {
        showPlaceholder();
      }
    }
    renderTabs();
    renderDeviceList();
  }

  function showPlaceholder() {
    placeholder.style.display = '';
    placeholder.hidden = false;
    stage.hidden = true;
    qualityGroup.hidden = true;
    fullscreenBtn.hidden = true;
    disconnectBtn.hidden = true;
    statusDot.classList.remove('live');
  }

  // ----------------------------------------------------------------- controls
  disconnectBtn.addEventListener('click', () => { if (activeKey) closeSession(activeKey); });

  fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) stage.requestFullscreen?.();
    else document.exitFullscreen?.();
  });

  qualityGroup.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      qualityGroup.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentQuality = btn.dataset.q;
      LANDesk.input.sendConfig(currentQuality);
    });
  });

  // ----------------------------------------------------------------- host state
  // Host mode is now enabled automatically when a peer connects to us; there is
  // no manual toggle. We only reflect the state in the status dot.
  ipcRenderer.on('host-state', (_e, { hostMode }) => {
    statusDot.classList.toggle('host', hostMode && !LANDesk.stream.connected);
  });

  ipcRenderer.on('host-error', (_e, msg) => showStatusToast('Host error: ' + msg, 'danger'));

  // ----------------------------------------------------------------- discovery
  ipcRenderer.on('host-found', (_e, host) => {
    const wasNew = !hosts.has(host.key);
    const prev = hosts.get(host.key);
    if (prev) host.latency = prev.latency;
    hosts.set(host.key, host);
    renderDeviceList();
    if (wasNew && host.hostReady) pingHost(host);
  });

  ipcRenderer.on('host-lost', (_e, host) => {
    hosts.delete(host.key);
    renderDeviceList();
  });

  setInterval(() => { for (const h of hosts.values()) if (h.hostReady) pingHost(h); }, 5000);

  // ----------------------------------------------------------------- util
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ----------------------------------------------------------------- init
  (async function init() {
    try {
      const self = await ipcRenderer.invoke('get-self');
      selfInfoEl.textContent = `${self.name} · ${OS_NAME[self.os] || self.os}`;
    } catch (_) {}
    try {
      const existing = await ipcRenderer.invoke('get-hosts');
      for (const h of existing) { hosts.set(h.key, h); if (h.hostReady) pingHost(h); }
      renderDeviceList();
    } catch (_) {}
  })();
})();
