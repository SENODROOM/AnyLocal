# LANDesk — LAN-Only Multi-Device Remote Desktop

A free, self-contained Windows app that lets you view and control your other
machines over the **local network only** — no internet, no relay servers, no
accounts. Auto-discovers hosts on the same Wi-Fi and streams their screens to a
single dashboard at LAN speed.

Built by **QuantumLogicsLabs**. Electron shell + Node networking + Python
screen/input sidecar.

---

## How it works

```
 Controller (your PC)                         Host (other PC)
 ┌───────────────────┐   UDP 54321 beacon   ┌────────────────────┐
 │ Electron dashboard │◀────discovery───────│ discovery broadcast │
 │  canvas <img>      │                      │                    │
 │   ▲  video frames  │◀═ WS 8765 (JPEG) ═══▶│ Node video server  │
 │   │  input events  │── WS 8766 (JSON) ───▶│ Node input server  │
 └───┼────────────────┘                      │      ▲   │         │
     │                                        │ stdout│   │stdin   │
     │                                        │   ┌───┴───▼─────┐  │
     │                                        │   │ Python      │  │
     └────────────────────────────────────── │   │ sidecar     │  │
                                              │   │ mss capture │  │
                                              │   │ pynput inject│ │
                                              │   └─────────────┘  │
                                              └────────────────────┘
```

- **Discovery** — UDP broadcast on `54321`, JSON beacon `{name, port, os, type:"LANDesk-Host"}`, every 2s. Hosts expire after 8s of silence.
- **Video** — WebSocket on `8765`, binary JPEG frames. The Python sidecar pipes
  length-prefixed frames to Node over stdout; Node fans them out to controllers.
- **Input** — a *separate* WebSocket on `8766` so input is never queued behind
  video. Each JSON event is written straight to the sidecar's stdin.
- **LAN-only** — every WebSocket connection from a non-private IP is rejected
  (`main/lanGuard.js`).

The same `.exe` is both Controller and Host. It starts as a Controller; click
**Enable Host Mode** (or use the tray menu) to also broadcast and accept control.

---

## Project layout

```
main/        Electron main process
  main.js          app entry, tray, window, sidecar spawn, stdout de-framing
  discovery.js     UDP broadcast + listen (port 54321)
  wsVideoServer.js video WebSocket (port 8765)
  wsInputServer.js input WebSocket (port 8766)
  lanGuard.js      private-IP enforcement
renderer/    UI (vanilla HTML/CSS/JS)
  index.html, styles.css
  dashboard.js     device cards, tabs, sessions, host-mode toggle
  streamView.js    canvas renderer + FPS/bitrate stats
  inputCapture.js  mouse/keyboard capture + coordinate scaling
python-sidecar/
  main.py          stdio protocol, capture loop, stdin event reader
  capture.py       mss capture + delta detection
  encoder.py       JPEG encode + quality tiers
  input_handler.py pynput mouse/keyboard injection
resources/    icons + (optional) ffmpeg.exe
```

---

## Run it (development)

Two machines on the same Wi-Fi. On **both**:

```bash
npm install
# Sidecar deps (host machine needs these; dev mode runs the .py directly)
pip install -r python-sidecar/requirements.txt
npm start
```

- On the machine you want to **control**: just leave it on the dashboard.
- On the machine to be **controlled**: click **Enable Host Mode**.

Within ~3s the host appears as a card on the controller. Click it to open a live
session. Use the quality buttons (Low / Med / High), Fullscreen, or Disconnect.

> In dev, no PyInstaller build is needed — `main.js` falls back to launching
> `python python-sidecar/main.py` automatically when the bundled `.exe` is absent.

---

## Build the portable .exe

```bash
# 1. Build the Python sidecar to a single .exe
npm run build-sidecar           # -> python-sidecar/dist/landesk-sidecar.exe

# 2. (optional) drop ffmpeg.exe + icons into resources/  (see resources/README.txt)

# 3. Package everything
npm run build                   # -> dist/LANDesk-portable.exe
```

`electron-builder.yml` targets a single portable NSIS `.exe` (no install).

---

## Quality tiers

| Tier | JPEG q | FPS | Scale |
|------|--------|-----|-------|
| Low  | 55     | 30  | 0.75  |
| Med  | 75     | 30  | 1.0   |
| High | 88     | 60  | 1.0   |

Delta detection (`ImageChops.difference`) skips unchanged frames; a keyframe is
forced at least once per second so late-joining controllers still get an image.

---

## Notes & deviations from the original blueprint

- **JPEG for all tiers (incl. High), not H.264.** The renderer decodes frames
  with an HTML `<img>`, which cannot decode raw H.264/MPEG-TS. Shipping H.264 to
  a `<canvas>` would require a JS H.264 decoder or MSE plumbing. JPEG keeps the
  whole pipeline correct and genuinely low-latency on a LAN. `ffmpeg.exe` is
  therefore optional and unused at runtime today.
- **Length-prefixed stdout framing.** The blueprint forwarded raw stdout chunks
  to clients, but pipe chunks don't align with frame boundaries. We prefix each
  frame with a 4-byte big-endian length and reassemble in `main.js`.
- **No `ws_bridge.py`.** Transport rides the existing stdio pipes, so the sidecar
  needs no sockets of its own.

---

## Security

- LAN-only: connections from non-private IPs are closed immediately.
- No telemetry, no accounts, no outbound internet calls.
- On first Host Mode enable, the app tries to add inbound firewall rules for
  ports 8765/8766/54321 via `netsh` (silently falls back to the Windows prompt
  if not elevated).

For controlling UAC/secure-desktop dialogs the sidecar must run elevated.

---

*LANDesk v1.0 · All traffic stays on your local network.*
