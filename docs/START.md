# Starting LANDesk

## Prerequisites

Both machines must be on the same Wi-Fi or LAN.

### First-time setup

**Node dependencies** (run once):
```bash
npm install
```

**Python sidecar dependencies** (run once on any machine that will act as a Host):
```bash
pip install -r python-sidecar/requirements.txt
```

---

## Running in development

On **each machine** you want involved:

```bash
npm start
```

The app opens a dashboard window and sits in the system tray.

- On the machine you want to **view/control from** — do nothing. It is already in Controller mode and will scan for hosts automatically.
- On the machine you want to **be controlled** — click **Enable Host Mode** in the dashboard (or right-click the tray icon and select Enable Host Mode).

Within ~3 seconds the host appears as a card on the controller's dashboard. Click the card to open a live session.

---

## Running the packaged build

Download or build `LANDesk-portable.exe` (see below), then double-click it on each machine. No installation required.

To build it yourself:

```bash
# 1. Compile the Python sidecar
npm run build-sidecar        # -> python-sidecar/dist/landesk-sidecar.exe

# 2. Package everything into a single portable exe
npm run build                # -> dist/LANDesk-portable.exe
```

---

## In-session controls

| Control | Action |
|---------|--------|
| Quality buttons (Low / Med / High) | Change stream quality and frame rate |
| Fullscreen | Expand the stream canvas to fill the window |
| Disconnect | End the current session |

---

## Notes

- The app minimises to the tray when you close the window. To quit fully, right-click the tray icon and select **Quit**.
- On first Host Mode enable, the app attempts to add inbound Windows Firewall rules for ports 8765, 8766, and 54321 via `netsh`. If the app is not elevated, Windows will show its own allow prompt.
- To control UAC / secure-desktop dialogs on the host, run the app as Administrator.
