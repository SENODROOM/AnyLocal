'use strict';

// Dashboard orchestration: device discovery → cards, tab management, session
// lifecycle (video + input), host-mode toggle, quality / fullscreen controls.

const { ipcRenderer } = require('electron');

window.LANDesk = window.LANDesk || {};

(function () {
  const deviceListEl = document.getElementById('deviceList');
  const emptyHint = document.getElementById('emptyHint');
  const hostCountEl = document.getElementById('hostCount');
  const tabsEl = document.getElementById('tabs');
  const hostModeBtn = document.getElementById('hostModeBtn');
  const selfInfoEl = document.getElementById('selfInfo');
  const statusDot = document.getElementById('statusDot');

  const placeholder = document.getElementById('placeholder');
  const stage = document.getElementById('stage');
  const qualityGroup = document.getElementById('qualityGroup');
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const disconnectBtn = document.getElementById('disconnectBtn');

  const hosts = new Map();      // key -> host
  const openTabs = new Map();   // key -> host (sessions opened as tabs)
  let activeKey = null;
  let currentQuality = 'med';

  const OS_ICON = { win32: '🪟', darwin: '🍎', linux: '🐧' };

  // ----------------------------------------------------------------- latency
  function pingHost(host) {
    // Connect-time to the input port is a cheap LAN RTT proxy (no data pushed).
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
      probe.onopen = () => finish(Math.round(performance.now() - start));
      probe.onerror = () => finish(null);
      setTimeout(() => finish(host.latency ?? null), 1500);
    } catch (_) { /* ignore */ }
  }

  function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  // ----------------------------------------------------------------- cards
  function renderDeviceList() {
    const list = Array.from(hosts.values());
    hostCountEl.textContent = String(list.length);
    emptyHint.style.display = list.length ? 'none' : 'block';

    // Remove cards for hosts that disappeared.
    for (const el of Array.from(deviceListEl.querySelectorAll('.card'))) {
      if (!hosts.has(el.dataset.key)) el.remove();
    }
    for (const host of list) {
      let card = deviceListEl.querySelector(`[data-key="${cssEscape(host.key)}"]`);
      if (!card) {
        card = buildCard(host);
        deviceListEl.appendChild(card);
      }
      card.classList.toggle('connected', openTabs.has(host.key));
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
      <div class="card-meta">
        <span class="latency"><span class="ping-dot"></span><span class="ping-val">…</span></span>
        <span class="connect-pill">Connect →</span>
      </div>`;
    card.addEventListener('click', () => openSession(host));
    updateCardLatency(card, host.latency ?? null);
    return card;
  }

  function updateCardLatency(card, val) {
    const dot = card.querySelector('.ping-dot');
    const txt = card.querySelector('.ping-val');
    if (val == null) {
      txt.textContent = 'offline?';
      dot.className = 'ping-dot bad';
      return;
    }
    txt.textContent = `${val} ms`;
    dot.className = 'ping-dot' + (val > 60 ? ' bad' : val > 25 ? ' high' : '');
  }

  // ----------------------------------------------------------------- tabs
  function renderTabs() {
    tabsEl.innerHTML = '';
    for (const host of openTabs.values()) {
      const tab = document.createElement('div');
      tab.className = 'tab' + (host.key === activeKey ? ' active' : '');
      tab.innerHTML = `<span>${escapeHtml(host.name)}</span><span class="close">✕</span>`;
      tab.addEventListener('click', (e) => {
        if (e.target.classList.contains('close')) {
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

    placeholder.hidden = true;
    stage.hidden = false;
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

  // ----------------------------------------------------------------- host mode
  let hostModeOn = false;
  hostModeBtn.addEventListener('click', async () => {
    if (!hostModeOn) {
      const res = await ipcRenderer.invoke('enable-host');
      if (!res || !res.ok) {
        alert('Could not enable host mode: ' + (res && res.error ? res.error : 'unknown'));
      }
    } else {
      await ipcRenderer.invoke('disable-host');
    }
  });

  ipcRenderer.on('host-state', (_e, { hostMode }) => {
    hostModeOn = hostMode;
    hostModeBtn.textContent = hostMode ? '■ Disable Host Mode' : '+ Enable Host Mode';
    hostModeBtn.classList.toggle('on', hostMode);
    statusDot.classList.toggle('host', hostMode && !LANDesk.stream.connected);
  });

  ipcRenderer.on('host-error', (_e, msg) => alert('Host error: ' + msg));

  // ----------------------------------------------------------------- discovery
  ipcRenderer.on('host-found', (_e, host) => {
    const wasNew = !hosts.has(host.key);
    const prev = hosts.get(host.key);
    if (prev) host.latency = prev.latency;
    hosts.set(host.key, host);
    renderDeviceList();
    if (wasNew) pingHost(host);
  });

  ipcRenderer.on('host-lost', (_e, host) => {
    hosts.delete(host.key);
    renderDeviceList();
  });

  // Periodically refresh latency for visible hosts.
  setInterval(() => { for (const h of hosts.values()) pingHost(h); }, 5000);

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
      selfInfoEl.textContent = `${self.name} · ${self.os}`;
    } catch (_) {}
    try {
      const existing = await ipcRenderer.invoke('get-hosts');
      for (const h of existing) { hosts.set(h.key, h); pingHost(h); }
      renderDeviceList();
    } catch (_) {}
  })();
})();
