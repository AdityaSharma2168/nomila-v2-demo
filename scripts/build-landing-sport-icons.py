"""
build-landing-sport-icons.py — writes landing/sport-icons.js: each sport's icon as inline SVG path data, so the landing
page's sport grid draws the same icons as the app's (client/components/onboarding/SportTile.tsx) without loading an icon
font. Run after adding a sport or changing an icon in shared/sports.ts:

    python scripts/build-landing-sport-icons.py [--node-modules PATH]

Needs Python fontTools (`pip install fonttools`) and node_modules (for @expo/vector-icons; default ./node_modules, or
pass the folder of another checkout). scripts/sports.test.ts fails while a sport in shared/sports.ts has no icon here.

  { mdi: name }      the glyph's outline from the MaterialCommunityIcons font the app draws with (glyphmap name → code
                     point → TrueType outline), flipped from the font's y-up em (512 units, ascent 448) into y-down 24.
  { custom: name }   the app's own drawn glyph: the exact elements of CustomGlyph in SportTile.tsx (CUSTOM below; the
                     test checks each path still appears there), flattened into one path (rects and circles become
                     paths, the lacrosse head's rotate(45) is applied) and wound so one nonzero fill keeps the holes
                     that the app draws with fill-rule evenodd.

Every icon is { viewBox: "0 0 24 24", d } and is drawn with fill="currentColor".
"""
import argparse
import json
import math
import os
import re
import sys

from fontTools.misc.transform import Transform
from fontTools.pens.areaPen import AreaPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.reverseContourPen import ReverseContourPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path
from fontTools.ttLib import TTFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
VECTOR_ICONS = "@expo/vector-icons/build/vendor/react-native-vector-icons"


def rect(x, y, w, h):
    return f"M{x} {y}h{w}v{h}h{-w}z"


def circle(cx, cy, r):
    return f"M{cx - r} {cy}a{r} {r} 0 1 0 {2 * r} 0a{r} {r} 0 1 0 {-2 * r} 0z"


# CustomGlyph in client/components/onboarding/SportTile.tsx, element by element: (d, evenodd, transform or None).
LACROSSE_HEAD = Transform().translate(16.2, 7.8).rotate(math.radians(45)).translate(-16.2, -7.8)
CUSTOM = {
    "lacrosse": [
        ("M16.2 1.6c2.6 0 4.5 2.6 4.5 5.8 0 2.9-1.6 5.3-3.4 6.2l-.3 1.6h-1.6l-.3-1.6c-1.8-.9-3.4-3.3-3.4-6.2 0-3.2 1.9-5.8 4.5-5.8zm0 2c-1.3 0-2.5 1.6-2.5 3.8s1.2 3.8 2.5 3.8 2.5-1.6 2.5-3.8-1.2-3.8-2.5-3.8z", True, LACROSSE_HEAD),
        (rect(15.6, 3.4, 1.2, 8), False, LACROSSE_HEAD),
        (rect(13.4, 6.4, 5.6, 1.2), False, LACROSSE_HEAD),
        ("M11.8 10.8l1.5 1.5-7.9 7.9a1.1 1.1 0 0 1-1.5-1.5z", False, None),
        (circle(18.3, 18.4, 2.6), False, None),
    ],
    "artistic_swimming": [
        ("M9.6 14 5.4 3.6c-.2-.6.1-1.2.7-1.4.5-.2 1.1.1 1.3.6l5 11.2z", False, None),
        ("M14.4 14l4.2-10.4c.2-.6-.1-1.2-.7-1.4-.5-.2-1.1.1-1.3.6l-5 11.2z", False, None),
        ("M2 15.6c1.6-.7 3.3-1.1 5-1.1 2 0 3.6 1 5 1s3-1 5-1c1.7 0 3.4.4 5 1.1v2.2c-1.6-.7-3.3-1.1-5-1.1-2 0-3.6 1-5 1s-3-1-5-1c-1.7 0-3.4.4-5 1.1z", False, None),
        ("M2 19.6c1.6-.7 3.3-1.1 5-1.1 2 0 3.6 1 5 1s3-1 5-1c1.7 0 3.4.4 5 1.1v2.2c-1.6-.7-3.3-1.1-5-1.1-2 0-3.6 1-5 1s-3-1-5-1c-1.7 0-3.4.4-5 1.1z", False, None),
    ],
    "pickleball": [
        ("M13.4 1.9c1.2-1.2 3.2-1.2 4.4 0l4.3 4.3c1.2 1.2 1.2 3.2 0 4.4l-5.6 5.6c-1.2 1.2-3.2 1.2-4.4 0l-.8-.8-4.9 4.9-.3.3a1.6 1.6 0 0 1-2.3-2.3l.3-.3 4.9-4.9-.8-.8c-1.2-1.2-1.2-3.2 0-4.4z", False, None),
        ("M5.5 1.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM4.4 3.6a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm2.4.6a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM5 6.1a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z", True, None),
    ],
}


def num(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def contours(recording):
    """Split a RecordingPen's operations into one RecordingPen per contour."""
    out, cur = [], None
    for op, args in recording.value:
        if op == "moveTo":
            cur = RecordingPen()
            out.append(cur)
        cur.value.append((op, args))
    return out


def area(contour):
    pen = AreaPen()
    contour.replay(pen)
    return pen.value


def custom_path(name):
    """One nonzero-fill path: solid contours wound one way, evenodd holes (every subpath after an evenodd path's first)
    the other, so a hole stays open and a solid laid over a hole or its rim still fills."""
    svg = SVGPathPen(None, ntos=num)
    sign = None
    for d, evenodd, transform in CUSTOM[name]:
        rec = RecordingPen()
        parse_path(d, TransformPen(rec, transform) if transform else rec)
        for i, c in enumerate(contours(rec)):
            a = area(c)
            if sign is None:
                sign = 1 if a > 0 else -1
            want = -sign if (evenodd and i > 0) else sign
            c.replay(ReverseContourPen(svg) if (a > 0) != (want > 0) else svg)
    return svg.getCommands()


def mdi_path(font, glyphmap, name):
    cmap, glyphs = font.getBestCmap(), font.getGlyphSet()
    upm, ascent = font["head"].unitsPerEm, font["hhea"].ascent
    s = 24 / upm
    svg = SVGPathPen(glyphs, ntos=num)
    glyphs[cmap[glyphmap[name]]].draw(TransformPen(svg, Transform(s, 0, 0, -s, 0, ascent * s)))
    return svg.getCommands()


def sports():
    src = open(os.path.join(ROOT, "shared", "sports.ts"), encoding="utf8").read()
    body = src.split("export const SPORTS", 1)[1].split("];", 1)[0]
    rows = re.findall(r'\{\s*id:\s*"([a-z0-9_]+)",\s*label:\s*"[^"]*",\s*icon:\s*\{\s*(mdi|custom):\s*"([^"]+)"\s*\}\s*\}', body)
    if len(rows) != len(re.findall(r"\bid:", body)):
        sys.exit("could not read every row of SPORTS in shared/sports.ts (has the row shape changed?)")
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--node-modules", default=os.path.join(ROOT, "node_modules"))
    nm = ap.parse_args().node_modules
    font = TTFont(os.path.join(nm, VECTOR_ICONS, "Fonts", "MaterialCommunityIcons.ttf"))
    glyphmap = json.load(open(os.path.join(nm, VECTOR_ICONS, "glyphmaps", "MaterialCommunityIcons.json"), encoding="utf8"))
    lines = []
    for sid, kind, name in sports():
        d = mdi_path(font, glyphmap, name) if kind == "mdi" else custom_path(name)
        lines.append(f"  {sid}: {{ viewBox: \"0 0 24 24\", d: {json.dumps(d)} }},  // {kind}: {name}")
    out = os.path.join(ROOT, "landing", "sport-icons.js")
    with open(out, "w", encoding="utf8", newline="\n") as f:
        f.write(
            "// GENERATED by scripts/build-landing-sport-icons.py from shared/sports.ts (each sport's `icon`): the app's sport\n"
            "// icons as inline SVG path data (MaterialCommunityIcons outlines + SportTile.tsx's drawn glyphs). Do not edit:\n"
            "// run `python scripts/build-landing-sport-icons.py [--node-modules PATH]` (needs fontTools). Draw with fill=\"currentColor\".\n"
            "export const SPORT_ICONS = {\n" + "\n".join(lines) + "\n};\n"
        )
    print(f"wrote {out} ({len(lines)} icons)")


if __name__ == "__main__":
    main()
