from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
import xml.etree.ElementTree as ET

OUT = Path(__file__).resolve().parent

# ---------------------------------------------------------------------------
# Froglight geometric logo
#
# Source-of-truth geometry:
# - frog: 25 x 24 square-module grid
# - wordmark: 38 x 8 square-module grid
# - every hard edge is aligned to an integer grid coordinate
# - no font files, Bézier curves, tracing, or non-uniform scaling
# ---------------------------------------------------------------------------

PALETTE = {
    "D": "#023727",  # deepest green: silhouette + wordmark
    "M": "#19683F",  # body green
    "G": "#318341",  # highlight green
    "L": "#7AB03D",  # lime
    "Y": "#BBCF32",  # yellow-lime
    "C": "#F7EE86",  # warm luminous square
    "W": "#FFFBE8",  # brightest light core
    "A": "#9BC83E",  # wordmark accent
}

# This matrix was reconstructed from the supplied reference on a regular
# square module grid. It preserves the stepped head, body, legs, toes,
# light-bearing arms, and asymmetric shading seen in the reference.
FROG_GRID = [
    "    DDDD         DDDD    ",
    "   DLLLLD       DLLLLD   ",
    "   DLDDDLD     DLDDDLD   ",
    "   DLM MLMMMMMMMLD MLD   ",
    "   DLDCDLMMMMMMMLDCDLD   ",
    "   DLDDDLMMMMMMMLDDDLD   ",
    "    LLLLMMMMMMMMMLLLL    ",
    "   DMMMMMMMMMDMMMMMDMD   ",
    "   DMMMDDDMMMMMDDMMMMD   ",
    "    DMMMMMDDDDDMMMMMD    ",
    "     DMMMMGGGGGGMMMD     ",
    "     DDMMGGGGGGGMDDD     ",
    "     DMMGGGLYLGGGMMD     ",
    "    GDGGGGLYYYLGGMMD     ",
    "DDDDDLMGGLYCCCYLGGLLDDDDD",
    "DMMDDLDGGYY   YYGMLLDDMMD",
    "DMMMDLLDGYY   YYGDLLDMMMD",
    " DMMDDLLDMYCCCYMDLMDDMMD ",
    "  DMMDDLLYMYYYMYLGDDMMD  ",
    "   DMDDLLDYYYLYDLMDMMD   ",
    "    DMDDDGDGLDDGDDMMD    ",
    " DMMMMDDDDGDDDGDDDDMMMMD ",
    "D    D DDDDDDDDDDD D M  D",
    "  DDD               D D  ",
]

# The wordmark is also geometric. It intentionally follows the lowercase
# pixel rhythm of the supplied reference rather than using an external font.
WORDMARK_GRID = [
    "DDDD                D  A      D       ",
    "D                   D         D    D  ",
    "D    DDDD DDD   DDD D  D  DDD DDD  DD ",
    "DDD  D  D D  D D  D D  D D  D D  D D  ",
    "D    D    D  D D  D D  D D  D D  D D  ",
    "D    D    DDD   DDD DD D  DDD D  D  D ",
    "                  D         D         ",
    "                DD        DD          ",
]

assert all(len(row) == 25 for row in FROG_GRID)
assert all(len(row) == 38 for row in WORDMARK_GRID)

# Explicit bright-core overlays. These replace the over-exposed white areas
# in the raster reference with deterministic geometric squares.
EYE_CORES = [
    (5, 3, 2, 2),
    (17, 3, 2, 2),
]
CHEST_CORE = (11, 15, 2, 2)

# Glow areas. They do not define geometry; they are soft visual effects behind
# the hard-edged square cores.
EYE_GLOWS = [
    (4, 2, 4, 4),
    (16, 2, 4, 4),
]
CHEST_GLOW = (9, 13, 7, 6)


def merged_rects(grid: list[str], x_offset: int = 0, y_offset: int = 0):
    """Merge adjacent cells of the same color into horizontal rectangles."""
    rects = []
    for y, row in enumerate(grid):
        x = 0
        while x < len(row):
            key = row[x]
            if key == " ":
                x += 1
                continue
            start = x
            x += 1
            while x < len(row) and row[x] == key:
                x += 1
            rects.append((start + x_offset, y + y_offset, x - start, 1, key))
    return rects


def svg_filter_defs():
    return """
    <defs>
      <filter id="eyeGlow" x="-100%" y="-100%" width="300%" height="300%">
        <feGaussianBlur stdDeviation="0.72"/>
      </filter>
      <filter id="chestGlow" x="-100%" y="-100%" width="300%" height="300%">
        <feGaussianBlur stdDeviation="1.05"/>
      </filter>
    </defs>
    """


def write_svg(
    path: Path,
    hard_rects,
    view_w: int,
    view_h: int,
    eye_glows=None,
    chest_glow=None,
    eye_cores=None,
    chest_core=None,
):
    eye_glows = eye_glows or []
    eye_cores = eye_cores or []

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        (
            f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'viewBox="0 0 {view_w} {view_h}" '
            f'preserveAspectRatio="xMidYMid meet" '
            f'shape-rendering="crispEdges">'
        ),
        "<title>Froglight geometric pixel logo</title>",
        (
            "<desc>Front-facing seated frog constructed from integer-aligned "
            "square modules with geometric light accents.</desc>"
        ),
        svg_filter_defs(),
    ]

    # Soft glow is behind all crisp geometry.
    for x, y, w, h in eye_glows:
        lines.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" '
            f'fill="{PALETTE["Y"]}" opacity="0.42" filter="url(#eyeGlow)"/>'
        )
    if chest_glow:
        x, y, w, h = chest_glow
        lines.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" '
            f'fill="{PALETTE["Y"]}" opacity="0.38" filter="url(#chestGlow)"/>'
        )

    lines.append('<g shape-rendering="crispEdges">')
    for x, y, w, h, key in hard_rects:
        lines.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" '
            f'fill="{PALETTE[key]}"/>'
        )

    # Deterministic crisp cores.
    for x, y, w, h in eye_cores:
        lines.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" '
            f'fill="{PALETTE["W"]}"/>'
        )
    if chest_core:
        x, y, w, h = chest_core
        lines.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" '
            f'fill="{PALETTE["W"]}"/>'
        )

    lines += ["</g>", "</svg>"]
    path.write_text("\n".join(lines), encoding="utf-8")
    ET.parse(path)


def draw_scaled_rect(draw: ImageDraw.ImageDraw, rect, scale: int, fill: str):
    x, y, w, h = rect
    draw.rectangle(
        [
            x * scale,
            y * scale,
            (x + w) * scale - 1,
            (y + h) * scale - 1,
        ],
        fill=fill,
    )


def render_png(
    path: Path,
    hard_rects,
    view_w: int,
    view_h: int,
    scale: int,
    eye_glows=None,
    chest_glow=None,
    eye_cores=None,
    chest_core=None,
):
    """Rasterize the same module geometry without any non-uniform scaling."""
    eye_glows = eye_glows or []
    eye_cores = eye_cores or []

    size = (view_w * scale, view_h * scale)

    # Transparent output.
    image = Image.new("RGBA", size, (0, 0, 0, 0))

    # Glow layer is deliberately raster-only blur around geometric source rects.
    glow = Image.new("RGBA", size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)

    for rect in eye_glows:
        draw_scaled_rect(glow_draw, rect, scale, PALETTE["Y"] + "B0")
    if eye_glows:
        glow = glow.filter(ImageFilter.GaussianBlur(radius=0.72 * scale))

    if chest_glow:
        chest_layer = Image.new("RGBA", size, (0, 0, 0, 0))
        chest_draw = ImageDraw.Draw(chest_layer)
        draw_scaled_rect(chest_draw, chest_glow, scale, PALETTE["Y"] + "A0")
        chest_layer = chest_layer.filter(
            ImageFilter.GaussianBlur(radius=1.05 * scale)
        )
        glow = Image.alpha_composite(glow, chest_layer)

    image = Image.alpha_composite(image, glow)

    # Crisp geometry.
    draw = ImageDraw.Draw(image)
    for x, y, w, h, key in hard_rects:
        draw_scaled_rect(draw, (x, y, w, h), scale, PALETTE[key])

    for rect in eye_cores:
        draw_scaled_rect(draw, rect, scale, PALETTE["W"])
    if chest_core:
        draw_scaled_rect(draw, chest_core, scale, PALETTE["W"])

    image.save(path)
    return image


def make_ico(source: Image.Image, path: Path):
    """Center the artwork without stretching and emit standard ICO sizes."""
    # Use a square transparent master. Preserve aspect ratio.
    master = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))

    max_w = 900
    max_h = 900
    ratio = min(max_w / source.width, max_h / source.height)
    target = (
        max(1, round(source.width * ratio)),
        max(1, round(source.height * ratio)),
    )

    # NEAREST keeps the geometric modules crisp.
    resized = source.resize(target, Image.Resampling.NEAREST)
    master.alpha_composite(
        resized,
        ((1024 - resized.width) // 2, (1024 - resized.height) // 2),
    )

    master.save(
        path,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48),
               (64, 64), (128, 128), (256, 256)],
    )


def main():
    # ---------------------------
    # Frog-only mark
    # ---------------------------
    frog_margin = 2
    frog_w = 25 + frog_margin * 2
    frog_h = 24 + frog_margin * 2

    frog_rects = merged_rects(
        FROG_GRID,
        x_offset=frog_margin,
        y_offset=frog_margin,
    )
    frog_eye_glows = [
        (x + frog_margin, y + frog_margin, w, h)
        for x, y, w, h in EYE_GLOWS
    ]
    frog_eye_cores = [
        (x + frog_margin, y + frog_margin, w, h)
        for x, y, w, h in EYE_CORES
    ]
    frog_chest_glow = (
        CHEST_GLOW[0] + frog_margin,
        CHEST_GLOW[1] + frog_margin,
        CHEST_GLOW[2],
        CHEST_GLOW[3],
    )
    frog_chest_core = (
        CHEST_CORE[0] + frog_margin,
        CHEST_CORE[1] + frog_margin,
        CHEST_CORE[2],
        CHEST_CORE[3],
    )

    frog_svg = OUT / "froglight-frog.svg"
    write_svg(
        frog_svg,
        frog_rects,
        frog_w,
        frog_h,
        eye_glows=frog_eye_glows,
        chest_glow=frog_chest_glow,
        eye_cores=frog_eye_cores,
        chest_core=frog_chest_core,
    )

    # 32 pixels per module: exact integer rasterization.
    frog_png = OUT / "froglight-frog.png"
    frog_image = render_png(
        frog_png,
        frog_rects,
        frog_w,
        frog_h,
        scale=32,
        eye_glows=frog_eye_glows,
        chest_glow=frog_chest_glow,
        eye_cores=frog_eye_cores,
        chest_core=frog_chest_core,
    )
    make_ico(frog_image, OUT / "froglight-frog.ico")

    # ---------------------------
    # Frog + wordmark lockup
    # ---------------------------
    lockup_w = 42
    frog_x = (lockup_w - 25) // 2
    frog_y = 1
    word_x = (lockup_w - 38) // 2
    word_y = 27
    lockup_h = 37

    lockup_rects = merged_rects(
        FROG_GRID,
        x_offset=frog_x,
        y_offset=frog_y,
    ) + merged_rects(
        WORDMARK_GRID,
        x_offset=word_x,
        y_offset=word_y,
    )

    lockup_eye_glows = [
        (x + frog_x, y + frog_y, w, h)
        for x, y, w, h in EYE_GLOWS
    ]
    lockup_eye_cores = [
        (x + frog_x, y + frog_y, w, h)
        for x, y, w, h in EYE_CORES
    ]
    lockup_chest_glow = (
        CHEST_GLOW[0] + frog_x,
        CHEST_GLOW[1] + frog_y,
        CHEST_GLOW[2],
        CHEST_GLOW[3],
    )
    lockup_chest_core = (
        CHEST_CORE[0] + frog_x,
        CHEST_CORE[1] + frog_y,
        CHEST_CORE[2],
        CHEST_CORE[3],
    )

    lockup_svg = OUT / "froglight-lockup.svg"
    write_svg(
        lockup_svg,
        lockup_rects,
        lockup_w,
        lockup_h,
        eye_glows=lockup_eye_glows,
        chest_glow=lockup_chest_glow,
        eye_cores=lockup_eye_cores,
        chest_core=lockup_chest_core,
    )

    # 24 pixels per module for a large transparent lockup PNG.
    lockup_png = OUT / "froglight-lockup.png"
    lockup_image = render_png(
        lockup_png,
        lockup_rects,
        lockup_w,
        lockup_h,
        scale=24,
        eye_glows=lockup_eye_glows,
        chest_glow=lockup_chest_glow,
        eye_cores=lockup_eye_cores,
        chest_core=lockup_chest_core,
    )
    make_ico(lockup_image, OUT / "froglight-lockup.ico")


if __name__ == "__main__":
    main()
