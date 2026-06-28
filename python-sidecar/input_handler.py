"""Input injection for LANDesk using pynput.

Translates the JSON input events emitted by the browser renderer into mouse and
keyboard actions. Keyboard events carry the browser KeyboardEvent.key value, so
we map the named special keys onto pynput's Key enum and treat everything else
as a literal character.
"""

import json

from pynput.mouse import Controller as MouseController, Button
from pynput.keyboard import Controller as KeyboardController, Key, KeyCode

mouse = MouseController()
kbd = KeyboardController()

# Browser KeyboardEvent.key -> pynput Key
SPECIAL_KEYS = {
    "Enter": Key.enter,
    "Backspace": Key.backspace,
    "Tab": Key.tab,
    "Escape": Key.esc,
    " ": Key.space,
    "Shift": Key.shift,
    "Control": Key.ctrl,
    "Alt": Key.alt,
    "Meta": Key.cmd,
    "CapsLock": Key.caps_lock,
    "ArrowUp": Key.up,
    "ArrowDown": Key.down,
    "ArrowLeft": Key.left,
    "ArrowRight": Key.right,
    "Home": Key.home,
    "End": Key.end,
    "PageUp": Key.page_up,
    "PageDown": Key.page_down,
    "Delete": Key.delete,
    "Insert": Key.insert,
    "F1": Key.f1, "F2": Key.f2, "F3": Key.f3, "F4": Key.f4,
    "F5": Key.f5, "F6": Key.f6, "F7": Key.f7, "F8": Key.f8,
    "F9": Key.f9, "F10": Key.f10, "F11": Key.f11, "F12": Key.f12,
}

BUTTONS = {
    "left": Button.left,
    "right": Button.right,
    "middle": Button.middle,
}


def _to_key(name):
    if name in SPECIAL_KEYS:
        return SPECIAL_KEYS[name]
    if isinstance(name, str) and len(name) == 1:
        return name  # printable char; Controller accepts a str
    # Unknown multi-char name we don't map — try a KeyCode fallback.
    return None


def handle(raw):
    """Process one event. `raw` is a JSON string (one line)."""
    try:
        e = json.loads(raw)
    except Exception:
        return

    t = e.get("type")

    if t == "mousemove":
        try:
            mouse.position = (int(e["x"]), int(e["y"]))
        except Exception:
            pass

    elif t == "click":
        btn = BUTTONS.get(e.get("btn", "left"), Button.left)
        # Move first so the click lands where the cursor is.
        if "x" in e and "y" in e:
            try:
                mouse.position = (int(e["x"]), int(e["y"]))
            except Exception:
                pass
        try:
            if e.get("down"):
                mouse.press(btn)
            else:
                mouse.release(btn)
        except Exception:
            pass

    elif t == "scroll":
        try:
            mouse.scroll(0, int(e.get("delta", 1)))
        except Exception:
            pass

    elif t == "keydown":
        key = _to_key(e.get("key"))
        if key is not None:
            try:
                kbd.press(key)
            except Exception:
                pass

    elif t == "keyup":
        key = _to_key(e.get("key"))
        if key is not None:
            try:
                kbd.release(key)
            except Exception:
                pass
