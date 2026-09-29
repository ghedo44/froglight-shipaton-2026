"""Generate the web PWA icon set from the canonical Froglight logo geometry.

Source of truth: generate_froglight_logo.py.
Outputs land in ../apps/web/public/ and are committed; rerun this script
after any change to the master geometry.

Layout rules:
- "any" icons: transparent canvas, frog rendered at the largest integer
  pixels-per-module scale that fits, glows included.
- maskable icons: opaque deep-green field; hard geometry scaled so the
  frog's bounding-box corners stay inside the PWA safe zone (circle with
  diameter = 80% of the canvas side).
- apple-touch-icon: same field at 180x180, sized for the iOS squircle mask.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))

from generate_froglight_logo import (  # noqa: E402
    CHEST_CORE,
    CHEST_GLOW,
    EYE_CORES,
    EYE_GLOWS,
    PALETTE,
    FROG_GRID,
    merged_rects,
)

OUT = Path(__file__).resolve().parent.parent / "apps" / "web" / "public"

# Frog-only artwork: 2-module margin around the 25x24 module grid.
MARGIN = 2
GRID_W = 25 + MARGIN * 2
GRID_H = 24 + MARGIN * 2

HARD_RECTS = merged_rects(FROG_GRID, x_offset=MARGIN, y_offset=MARGIN)
EYE_GLOW_RECTS = [(x + MARGIN, y + MARGIN, w, h) for x, y, w, h in EYE_GLOWS]
EYE_CORE_RECTS = [(x + MARGIN, y + MARGIN, w, h) for x, y, w, h in EYE_CORES]
CHEST_GLOW_RECT = (
    CHEST_GLOW[0] + MARGIN,
    CHEST_GLOW[1] + MARGIN,
    CHEST_GLOW[2],
    CHEST_GLOW[3],
)
CHEST_CORE_RECT = (
    CHEST_CORE[0] + MARGIN,
    CHEST_CORE[1] + MARGIN,
    CHEST_CORE[2],
    CHEST_CORE[3],
)


def draw_module_rect(draw: ImageDraw.ImageDraw, rect, scale: int, fill: str) -> None:
    x, y, w, h = rect
    draw.rectangle(
        [x * scale, y * scale, (x + w) * scale - 1, (y + h) * scale - 1],
        fill=fill,
    )


def render(size: int, ppem: int, background: str | None) -> Image.Image:
    """Render the frog centered on a square canvas without resampling."""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if background is not None:
        image.paste(Image.new("RGBA", (size, size), background), (0, 0))

    art_w, art_h = GRID_W * ppem, GRID_H * ppem
    ox, oy = (size - art_w) // 2, (size - art_h) // 2

    # Glow layer first (soft raster-only blur behind the crisp geometry).
    glow = Image.new("RGBA", (art_w, art_h), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    for rect in EYE_GLOW_RECTS:
        draw_module_rect(glow_draw, rect, ppem, PALETTE["Y"] + "B0")
    glow = glow.filter(ImageFilter.GaussianBlur(radius=0.72 * ppem))
    chest = Image.new("RGBA", (art_w, art_h), (0, 0, 0, 0))
    draw_module_rect(ImageDraw.Draw(chest), CHEST_GLOW_RECT, ppem, PALETTE["Y"] + "A0")
    chest = chest.filter(ImageFilter.GaussianBlur(radius=1.05 * ppem))
    glow = Image.alpha_composite(glow, chest)
    image.alpha_composite(glow, (ox, oy))

    # Hard geometry plus deterministic bright cores.
    layer = Image.new("RGBA", (art_w, art_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for x, y, w, h, key in HARD_RECTS:
        draw_module_rect(draw, (x, y, w, h), ppem, PALETTE[key])
    for rect in EYE_CORE_RECTS:
        draw_module_rect(draw, rect, ppem, PALETTE["W"])
    draw_module_rect(draw, CHEST_CORE_RECT, ppem, PALETTE["W"])
    image.alpha_composite(layer, (ox, oy))
    return image


def main() -> None:
    icons = OUT / "icons"
    icons.mkdir(parents=True, exist_ok=True)

    # Transparent "any" icons: largest whole-pixel scale that fits.
    render(192, 6, None).save(icons / "icon-192.png")
    render(512, 17, None).save(icons / "icon-512.png")

    # Maskable: deep-green field, corners inside the 80% safe-zone circle.
    field = PALETTE["D"]
    render(192, 4, field).save(icons / "icon-maskable-192.png")
    render(512, 11, field).save(icons / "icon-maskable-512.png")

    # Apple touch icon: flattened by iOS, so no transparency.
    render(180, 5, field).save(OUT / "apple-touch-icon.png")

    # Vector + legacy favicons come straight from the canonical outputs.
    shutil.copyfile(Path(__file__).parent / "froglight-frog.svg", OUT / "favicon.svg")
    shutil.copyfile(Path(__file__).parent / "froglight-frog.ico", OUT / "favicon.ico")

    print(f"wrote PWA assets to {OUT}")


if __name__ == "__main__":
    main()
