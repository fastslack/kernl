# dmgbuild settings for the Kernl installer window.
#
# Produces the disk image everyone recognises: a window with the app on the
# left, an Applications shortcut on the right, and an arrow between them. The
# previous `hdiutil create -srcfolder` produced a bare window with one icon in
# it and no indication of what to do with it.
#
# ── Why dmgbuild and not create-dmg ───────────────────────────────────────
# The window's geometry — its size, its background, where each icon sits, the
# hidden toolbar — is not metadata, it lives in a `.DS_Store` file inside the
# image. The usual way to write one is to mount the image and drive Finder
# over AppleScript, which needs a logged-in GUI session; on a CI runner that
# is flaky at best and hangs at worst. dmgbuild writes the .DS_Store directly
# with a binary encoder, so this runs headless and deterministically, which is
# the only way it can run at all in the release workflow.
#
# Invoked as:
#   dmgbuild -s packaging/macos/dmg-settings.py \
#            -D app=<path to Kernl.app> -D background=<path to .tiff> \
#            "Kernl" out.dmg
#
# ── Keeping this honest ───────────────────────────────────────────────────
# The coordinates below describe the same window as the artwork in
# make-dmg-background.py. They are two files that must agree and cannot check
# each other, so both derive from the same four numbers, named the same way,
# and the arrow in the artwork is drawn to stop clear of ICON_SIZE either
# side. Change one, change the other, and look at the result.

import os.path

# ── The window. Mirrored in make-dmg-background.py ───────────────────────
WINDOW = (660, 400)
ICON_Y = 185
LEFT_X = 165
RIGHT_X = 495
ICON_SIZE = 128

app_path = defines["app"]
app_name = os.path.basename(app_path)

# ── Contents ─────────────────────────────────────────────────────────────
# Exactly two things. Anything else — a README, a licence, an "uninstall"
# script — turns a one-gesture install into a thing to be read first.
files = [app_path]
symlinks = {"Applications": "/Applications"}

# ── Appearance ───────────────────────────────────────────────────────────
format = "UDZO"          # compressed, read-only: what a Mac user expects
compression_level = 9
size = None              # dmgbuild measures the payload itself

background = defines.get("background", "builtin-arrow")
window_rect = ((200, 180), WINDOW)
default_view = "icon-view"
icon_size = ICON_SIZE
text_size = 13
grid_offset = (0, 0)
label_pos = "bottom"

icon_locations = {
    app_name: (LEFT_X, ICON_Y),
    "Applications": (RIGHT_X, ICON_Y),
}

# Chrome off. A disk image with a sidebar and a path bar looks like a folder
# someone left open, not like an installer.
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
show_icon_preview = False

# Nothing hidden and nothing extra: the icon view is what this window is.
include_icon_view_settings = True
include_list_view_settings = False

# The volume gets the app's own icon, so the mounted disk on the desktop and
# in the sidebar is recognisably Kernl rather than a generic white drive.
badge_icon = defines.get("badge_icon", None)
