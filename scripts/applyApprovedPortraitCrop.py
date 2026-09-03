#!/usr/bin/env python3
"""Apply the approved bottom-anchored crop to one generated teacher portrait.

Does not call APIs. Does not modify the source file. Does not change teacher pixels.
Scale = 1.0. Visible bottom = 1372. x = round(485 - sprite_width / 2).
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from PIL import Image

CANVAS = (1080, 1920)
WELL_CX = 485
PHOTO_AREA_BOTTOM = 1372
ALPHA_T = 16
SCALE = 1.0
KEEP_TOP_RATIO = 0.60


def crop_portrait(src: Image.Image) -> tuple[Image.Image, dict]:
    rgba = src.convert("RGBA")
    if rgba.size != CANVAS:
        raise ValueError(f"expected {CANVAS[0]}x{CANVAS[1]}, got {rgba.size[0]}x{rgba.size[1]}")
    keep_h = round(CANVAS[1] * KEEP_TOP_RATIO)
    if keep_h <= 0 or keep_h >= CANVAS[1]:
        raise ValueError(f"invalid keep-top height {keep_h}")
    # Remove the BOTTOM 40% of the generated canvas. Keep the TOP 60%.
    # Do not crop from the top or sides of the canvas; do not scale.
    kept = rgba.crop((0, 0, CANVAS[0], keep_h))
    alpha = kept.split()[-1].point(lambda p: 255 if p >= ALPHA_T else 0)
    bbox = alpha.getbbox()
    if not bbox:
        raise ValueError("empty teacher silhouette after top-60 crop")
    sprite = kept.crop(bbox)
    sw, sh = sprite.size
    x = round(WELL_CX - sw / 2)
    y = PHOTO_AREA_BOTTOM - sh
    if y < 0:
        raise ValueError(f"sprite height {sh} exceeds photo-area bottom {PHOTO_AREA_BOTTOM}")
    canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    canvas.paste(sprite, (x, y), sprite)
    vis = canvas.split()[-1].point(lambda p: 255 if p >= ALPHA_T else 0).getbbox()
    if not vis:
        raise ValueError("cropped canvas is empty")
    hist = canvas.split()[-1].histogram()
    src_hash = hashlib.sha256(sprite.tobytes()).hexdigest()
    out_sprite = canvas.crop(vis)
    out_hash = hashlib.sha256(out_sprite.tobytes()).hexdigest()
    if src_hash != out_hash:
        raise ValueError("teacher pixels changed during crop")
    if vis[3] != PHOTO_AREA_BOTTOM:
        raise ValueError(f"visible bottom {vis[3]} != {PHOTO_AREA_BOTTOM}")
    if vis[0] != x or vis[1] != y:
        raise ValueError(f"paste mismatch x,y expected {(x, y)} got {(vis[0], vis[1])}")
    return canvas, {
        "scale": SCALE,
        "keep_top_ratio": KEEP_TOP_RATIO,
        "canvas_keep_height": keep_h,
        "canvas_removed_bottom_px": CANVAS[1] - keep_h,
        "x": x,
        "y": y,
        "sprite_width": sw,
        "sprite_height": sh,
        "source_bbox": list(bbox),
        "visible_bottom": vis[3],
        "visible_top": vis[1],
        "visible_left": vis[0],
        "visible_right": vis[2],
        "clear": hist[0],
        "opaque255": hist[255],
        "partial": sum(hist[1:255]),
        "size": list(canvas.size),
        "mode": canvas.mode,
        "pixels_unchanged": True,
        "second_translation": False,
    }


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: applyApprovedPortraitCrop.py input.png output.png", file=sys.stderr)
        return 2
    src_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2])
    if src_path.resolve() == out_path.resolve():
        print("refusing to overwrite source portrait", file=sys.stderr)
        return 2
    src = Image.open(src_path)
    cropped, geometry = crop_portrait(src)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(".png.tmp")
    cropped.save(tmp, format="PNG", compress_level=1)
    tmp.replace(out_path)
    print(json.dumps(geometry))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
