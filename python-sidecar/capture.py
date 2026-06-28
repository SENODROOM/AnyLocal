"""Screen capture for LANDesk using mss + Pillow.

Captures the selected monitor, optionally downscales for the Low tier, and uses
ImageChops delta detection to skip frames when nothing on screen changed. A
periodic forced keyframe guarantees newly connected controllers receive a full
image even while the screen is static.
"""

import mss
from PIL import Image, ImageChops

from encoder import encode_jpeg, settings_for


class ScreenCapturer:
    def __init__(self, monitor_index=1):
        self.monitor_index = monitor_index
        self._prev = None
        self._sct = mss.mss()

    def monitor(self):
        mons = self._sct.monitors
        idx = self.monitor_index
        if idx < 1 or idx >= len(mons):
            idx = 1 if len(mons) > 1 else 0
        return mons[idx]

    def grab_image(self, scale=1.0):
        mon = self.monitor()
        raw = self._sct.grab(mon)
        img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
        if scale != 1.0:
            w = max(1, int(img.width * scale))
            h = max(1, int(img.height * scale))
            img = img.resize((w, h), Image.BILINEAR)
        return img

    def get_frame(self, quality="med", force=False):
        """Return JPEG bytes for the current screen, or None if unchanged.

        force=True bypasses delta detection (used for periodic keyframes).
        """
        cfg = settings_for(quality)
        img = self.grab_image(cfg["scale"])

        if not force and self._prev is not None and self._prev.size == img.size:
            diff = ImageChops.difference(img, self._prev)
            if diff.getbbox() is None:
                return None  # nothing changed

        self._prev = img
        return encode_jpeg(img, cfg["jpeg"])

    def reset(self):
        self._prev = None

    def close(self):
        try:
            self._sct.close()
        except Exception:
            pass
