"""LANDesk Python sidecar entry point.

Run by the Electron main process as a child:  landesk-sidecar(.exe) --mode host

Protocol with Node:
  * Frames OUT  -> stdout, length-prefixed:  [4-byte big-endian length][JPEG bytes]
  * Events IN   <- stdin, newline-delimited JSON (input + config control events)

Keeping the transport on the existing stdio pipes means the sidecar needs no
network sockets of its own; Node owns the WebSocket servers and fans frames out
to controllers while writing incoming input straight to our stdin.
"""

import argparse
import struct
import sys
import threading
import time

import input_handler
from capture import ScreenCapturer

# Shared, thread-safe-ish state mutated by the stdin reader thread.
_state = {
    "quality": "med",
    "monitor": 1,
    "running": True,
}
_state_lock = threading.Lock()

# Force a full keyframe at least this often so new/late clients get an image.
KEYFRAME_INTERVAL = 1.0

FPS_BY_QUALITY = {"low": 30, "med": 30, "high": 60}


def write_frame(frame_bytes):
    """Write one length-prefixed frame to stdout in binary."""
    out = sys.stdout.buffer
    out.write(struct.pack(">I", len(frame_bytes)))
    out.write(frame_bytes)
    out.flush()


def stdin_reader():
    """Read newline-delimited JSON events; dispatch input vs config."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        # Peek the type cheaply without a second json.loads in the hot path.
        if '"config"' in line:
            _handle_config(line)
        else:
            input_handler.handle(line)
    # stdin closed -> parent gone; shut down.
    with _state_lock:
        _state["running"] = False


def _handle_config(line):
    import json
    try:
        e = json.loads(line)
    except Exception:
        return
    if e.get("type") != "config":
        # Not actually a config event (the substring matched a value) — route it.
        input_handler.handle(line)
        return
    with _state_lock:
        if e.get("quality") in ("low", "med", "high"):
            _state["quality"] = e["quality"]
        if isinstance(e.get("monitor"), int):
            _state["monitor"] = e["monitor"]


def run_host():
    cap = ScreenCapturer(monitor_index=_state["monitor"])
    last_keyframe = 0.0
    current_monitor = _state["monitor"]

    try:
        while True:
            with _state_lock:
                if not _state["running"]:
                    break
                quality = _state["quality"]
                monitor = _state["monitor"]

            if monitor != current_monitor:
                current_monitor = monitor
                cap.monitor_index = monitor
                cap.reset()

            now = time.time()
            force = (now - last_keyframe) >= KEYFRAME_INTERVAL

            try:
                frame = cap.get_frame(quality=quality, force=force)
            except Exception as ex:
                sys.stderr.write(f"[sidecar] capture error: {ex}\n")
                sys.stderr.flush()
                time.sleep(0.2)
                continue

            if frame is not None:
                try:
                    write_frame(frame)
                except (BrokenPipeError, OSError):
                    break  # Node closed the pipe
                if force:
                    last_keyframe = now

            fps = FPS_BY_QUALITY.get(quality, 30)
            time.sleep(max(0.0, 1.0 / fps))
    finally:
        cap.close()


def main():
    parser = argparse.ArgumentParser(prog="landesk-sidecar")
    parser.add_argument("--mode", default="host", choices=["host"])
    parser.add_argument("--monitor", type=int, default=1)
    args = parser.parse_args()

    _state["monitor"] = args.monitor

    # Reader thread feeds input/config; main thread streams frames.
    t = threading.Thread(target=stdin_reader, daemon=True)
    t.start()

    if args.mode == "host":
        run_host()


if __name__ == "__main__":
    main()
