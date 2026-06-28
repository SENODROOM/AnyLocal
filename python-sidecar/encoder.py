"""JPEG encoding for LANDesk frames.

The Electron renderer decodes each frame with an HTML <img> (drawImage on a
canvas), which natively understands JPEG. We therefore encode every quality
tier as JPEG — only the quality factor and capture cadence change between
Low / Med / High. (An H.264-over-MPEG-TS path is intentionally omitted because
a plain <img> cannot decode it; see README for the rationale.)
"""

import io

# quality tier -> (jpeg_quality, target_fps, scale)
QUALITY_TABLE = {
    "low":  {"jpeg": 55, "fps": 30, "scale": 0.75},
    "med":  {"jpeg": 75, "fps": 30, "scale": 1.0},
    "high": {"jpeg": 88, "fps": 60, "scale": 1.0},
}


def settings_for(quality):
    return QUALITY_TABLE.get(quality, QUALITY_TABLE["med"])


def encode_jpeg(img, jpeg_quality):
    """Encode a PIL.Image to JPEG bytes."""
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=jpeg_quality, optimize=False)
    return buf.getvalue()
