#!/usr/bin/env python3
"""Render the .dmg window background — run by hand, output committed.

Committed rather than generated during the build, and that is a lesson this
repo already paid for once: the old packager rendered the .icns at build time
and quietly ran `touch kernl.icns` when its tooling was missing, so every .app
ever built carried an empty file where its icon should be. The macOS runners
have neither ImageMagick nor Pillow. Anything drawn at build time on those
runners is something that can silently come out blank.

So: regenerate with

    python3 packaging/macos/make-dmg-background.py

and commit both PNGs. Pillow is the only dependency and it is not needed to
build a release.

Two files, because macOS picks between them by display:
  dmg-background.png      660x400   1x
  dmg-background@2x.png  1320x800   2x (Retina — every Mac made since 2012)

The layout is not decoration: the coordinates here and the icon positions in
dmg-settings.py describe the same window and drift apart silently. Both are
derived from WINDOW/ICON_Y/LEFT_X/RIGHT_X below, which is why those live at
the top of the file rather than inline.
"""

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ── The window, in 1x points. Mirrored in dmg-settings.py ────────────────
WINDOW = (660, 400)
ICON_Y = 185          # vertical centre of both icons
LEFT_X = 165          # centre of the Kernl icon
RIGHT_X = 495         # centre of the Applications symlink

# Sampled from packaging/icons/kernl-256.png so the window reads as part of
# the same object as the icon sitting on it, rather than a generic dark panel.
DEEP = (1, 15, 58)        # the icon's darkest field
INDIGO = (37, 23, 146)    # its outer body
VIOLET = (54, 15, 165)    # its lit edge
GLOW = (49, 78, 234)      # the rim light
MIST = (150, 165, 225)    # legible on all of the above


def vertical_gradient(size, top, bottom):
    """Top-to-bottom ramp. Drawn at 1x and scaled — banding is invisible."""
    w, h = size
    grad = Image.new("RGB", (1, h))
    px = grad.load()
    for y in range(h):
        t = y / max(1, h - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return grad.resize(size, Image.BICUBIC)


def radial_glow(size, centre, radius, colour, strength):
    """A soft pool of light. Cheap: draw small, blur, scale up."""
    w, h = size
    scale = 8
    small = Image.new("L", (w // scale, h // scale), 0)
    d = ImageDraw.Draw(small)
    cx, cy, r = centre[0] / scale, centre[1] / scale, radius / scale
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=round(255 * strength))
    small = small.filter(ImageFilter.GaussianBlur(r / 2))
    mask = small.resize((w, h), Image.BICUBIC)
    layer = Image.new("RGB", (w, h), colour)
    return layer, mask


def load_font(size):
    """Whatever sans this machine has. Falls back to the bitmap default."""
    for path in (
        "/usr/share/fonts/liberation-sans/LiberationSans-Regular.ttf",
        "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/TTF/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def render(scale):
    w, h = WINDOW[0] * scale, WINDOW[1] * scale
    img = vertical_gradient((w, h), VIOLET, DEEP)

    # A glow under each icon well, so the two 128pt icons sit on something
    # instead of floating on a flat field.
    for x in (LEFT_X, RIGHT_X):
        layer, mask = radial_glow(
            (w, h), (x * scale, ICON_Y * scale), 135 * scale, GLOW, 1.0
        )
        img = Image.composite(layer, img, mask.point(lambda v: int(v * 0.42)))

    d = ImageDraw.Draw(img)

    # ── The arrow ────────────────────────────────────────────────────────
    # Sits in the gap between the icon wells and says the whole thing: this
    # goes there. Stops well clear of both so a 128pt icon never covers it.
    y = ICON_Y * scale
    x0 = (LEFT_X + 105) * scale
    x1 = (RIGHT_X - 105) * scale
    shaft = max(1, round(5 * scale))
    head = round(19 * scale)

    d.line([(x0, y), (x1 - head, y)], fill=GLOW, width=shaft)
    d.polygon(
        [(x1, y), (x1 - head, y - head * 0.62), (x1 - head, y + head * 0.62)],
        fill=GLOW,
    )

    # ── Caption ──────────────────────────────────────────────────────────
    # Under the icons, not over them: the Finder draws each icon's own label
    # right below it, and anything at that height collides with the words
    # "Kernl" and "Applications".
    font = load_font(round(15 * scale))
    text = "Drag Kernl into Applications to install"
    tw = d.textlength(text, font=font)
    d.text(((w - tw) / 2, (ICON_Y + 125) * scale), text, font=font, fill=MIST)

    return img


if __name__ == "__main__":
    import pathlib

    here = pathlib.Path(__file__).parent
    for scale, name in ((1, "dmg-background.png"), (2, "dmg-background@2x.png")):
        out = here / name
        render(scale).save(out)
        print(f"wrote {out} ({WINDOW[0] * scale}x{WINDOW[1] * scale})")
