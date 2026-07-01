# LANDesk — LAN-Only Multi-Device Remote Desktop

A free, self-contained Windows app that lets you view and control your other
machines over the **local network only** — no internet, no relay servers, no
accounts. Every running instance is automatically visible to every other one;
connections are direct peer-to-peer over the LAN with no dedicated server required.

Built by **QuantumLogicsLabs**. Electron shell + Node networking + Python
screen/input sidecar.

---

## How it works

```
 Device A                                        Device B
 ┌──────────────────────┐  UDP 54321 beacon   ┌──────────────────────┐
 │ Electron dashboard   │◀───── discovery ────│ Electron dashboard   │
 │                      │────── discovery ───▶│                      │
 │  canvas (stream)     │◀═ WS 8765 (JPEG) ══│ Node video server    │
 │  input events        │══ WS 8766 (JSON) ══▶│ Node input server    │
 │                      │                     │      ▲   │           │
 │  OR                  │  UDP 54321 unicast  │ stdout│   │stdin     │
 │  connect-request  ──▶│──── Request ───────▶│  ┌────┴───▼──────┐  │
 │  connect-accepted ◀──│◀─── Accept ─────────│  │ Python        │  │
 └──────────────────────┘                     │  │ sidecar       │  │
                                              │  │ mss + pynput  │  │
                                              │  └───────────────┘  │
                                              └──────────────────────┘
```

- **Peer discovery** — every instance broadcasts a UDP beacon on port `54321` every 2 s (`hostReady: false` until screen sharing is active). All running instances appear in each other's device list automatically. Peers expire after 8 s of silence.
- **Direct connect** — if a peer already has Host Mode active (`hostReady: true`), click **Connect →** to open the stream immediately.
- **P2P request flow** — if a peer is visible but not yet sharing, click **Request →**. A UDP invite is sent directly to that device; the user sees a toast and clicks Accept. Their sidecar starts automatically and the stream opens on your end — no manual setup needed on either side.
- **Video** — WebSocket on `8765`, binary JPEG frames. The Python sidecar pipes length-prefixed frames to Node over stdout; Node fans them to all connected controllers.
- **Input** — a *separate* WebSocket on `8766` so input is never queued behind video. JSON events go straight to the sidecar's stdin.
- **LAN-only** — every WebSocket upgrade from a non-private IP is rejected (`main/lanGuard.js`).

### Simultaneous connections

A device can be in all three roles at once:

| Role | How |
|------|-----|
| Viewing multiple hosts | Open multiple tabs in the dashboard |
| Being viewed by multiple controllers | The video WS server fans frames to all clients |
| Viewer + host at the same time | Host Mode and the controller tabs are independent |

---

## Project layout

```
main/
  main.js          app entry, tray, window, sidecar spawn, stdout de-framing, P2P IPC
  discovery.js     UDP broadcast + listen + unicast signalling (port 54321)
  wsVideoServer.js video WebSocket (port 8765)
  wsInputServer.js input WebSocket (port 8766)
  lanGuard.js      private-IP enforcement
renderer/
  index.html, styles.css
  dashboard.js     device cards, tabs, sessions, P2P request flow, toast notifications
  streamView.js    canvas renderer + FPS/bitrate stats
  inputCapture.js  mouse/keyboard capture + coordinate scaling
python-sidecar/
  main.py          stdio protocol, capture loop, stdin event reader
  capture.py       mss capture + delta detection
  encoder.py       JPEG encode + quality tiers
  input_handler.py pynput mouse/keyboard injection
resources/         icons + (optional) ffmpeg.exe
docs/
  START.md         step-by-step startup guide
```

---

## Run it (development)

Two machines on the same Wi-Fi. On **both**:

```bash
npm install
# Sidecar deps needed on any machine that will share its screen
pip install -r python-sidecar/requirements.txt
npm start
```

Both apps open immediately and appear in each other's device list.

- To **view** another machine: click **Connect →** (if it's already sharing) or **Request →** (to send an invite).
- To **share your screen**: click **Enable Host Mode**, or simply accept an incoming request — Host Mode starts automatically on accept.

> In dev, no PyInstaller build is needed — `main.js` falls back to `python python-sidecar/main.py` when the bundled `.exe` is absent.

---

## Build the portable .exe

```bash
# 1. Build the Python sidecar to a single .exe
npm run build-sidecar           # -> python-sidecar/dist/landesk-sidecar.exe

# 2. (optional) drop ffmpeg.exe + icons into resources/

# 3. Package everything
npm run build                   # -> dist/LANDesk-portable.exe
```

`electron-builder.yml` targets a single portable NSIS `.exe` (no install).

---

## UDP message types (port 54321)

| Type | Direction | Purpose |
|------|-----------|---------|
| `LANDesk-Host` | Broadcast | Peer presence beacon, sent every 2 s. `hostReady: false` = visible peer; `hostReady: true` = actively sharing (includes `port` / `inputPort`). |
| `LANDesk-Request` | Unicast A → B | A wants to view B's screen. |
| `LANDesk-Accept` | Unicast B → A | B accepted; includes `port` + `inputPort` for the stream. |
| `LANDesk-Deny` | Unicast B → A | B declined. |

---

## Quality tiers

| Tier | JPEG q | FPS | Scale |
|------|--------|-----|-------|
| Low  | 55     | 30  | 0.75× |
| Med  | 75     | 30  | 1.0×  |
| High | 88     | 60  | 1.0×  |

Delta detection (`ImageChops.difference`) skips unchanged frames; a keyframe is
forced at least once per second so late-joining controllers get an image immediately.

---

## Notes

- **JPEG for all tiers (incl. High), not H.264.** The renderer decodes frames with an HTML `<img>`, which cannot decode raw H.264/MPEG-TS. JPEG keeps the pipeline correct and genuinely low-latency on a LAN. `ffmpeg.exe` is optional and unused at runtime.
- **Length-prefixed stdout framing.** Pipe chunks don't align with frame boundaries, so each frame is prefixed with a 4-byte big-endian length and reassembled in `main.js`.
- **No `ws_bridge.py`.** Transport rides the existing stdio pipes; the sidecar needs no sockets of its own.

---

## Security

- LAN-only: WebSocket upgrades from non-private IPs are closed immediately.
- No telemetry, no accounts, no outbound internet calls.
- On first Host Mode enable, the app attempts to add inbound firewall rules for ports 8765 / 8766 / 54321 via `netsh` (silently falls back to the Windows prompt if not elevated).
- For controlling UAC / secure-desktop dialogs the sidecar must run elevated.

---

*LANDesk v1.1 · All traffic stays on your local network.*
