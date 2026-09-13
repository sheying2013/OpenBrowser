#!/usr/bin/env python3
"""Build compact WOFF2 subsets for the font families shipped with the fingerprint layer.

The kernel font assets under kernels/*/wayfern_fonts are full system fonts (200 KB - 1.7 MB
each, or up to 20 MB for TTCs). Document-layer font registration needs the bytes inline,
so the payload has to be small. Subsetting to the printable Latin range (and core icon glyphs)
keeps every advance width and kerning pair that matters for text metrics while cutting file
sizes significantly.

Supports single TrueType/OpenType fonts and TrueType Collections (TTC) via fontNumber indexing.
Metrics stay bit-identical to the full font, and legacy kern tables are re-attached
(filtered to the glyphs that survived subsetting).

Usage: python3 scripts/build-font-subsets.py [platform ...]
"""

from __future__ import annotations

import json
import os
import re
import sys

from fontTools.subset import Subsetter, Options
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
INDEX_SRC = os.path.join(ROOT, "automation", "data", "font-metric-families.json")
OUT_ROOT = os.path.join(ROOT, "assets", "font-subsets")

# Printable ASCII + Latin-1 supplement + typographic punctuation + core PUA icon markers.
# Subsetting to this range preserves advance widths and kerning pairs needed by font probes.
UNICODES = (
    "U+0020-007E,U+00A0-00FF,U+2013-2014,U+2018-201D,U+2022,U+2026,U+20AC,U+2122,"
    "U+E700-U+E800"
)


def resolve_pingfang_source() -> tuple[str, bool]:
    candidates = [
        os.path.join(ROOT, "kernels", "windows-x64", "wayfern_fonts", "macos", "PingFang.ttc"),
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Supplemental/PingFang.ttc",
        os.path.expanduser("~/Library/Application Support/com.electron.lark.font_workaround/PingFang.ttc"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c, True
    return "kernels/windows-x64/wayfern_fonts/macos/Hiragino Sans GB.ttc", False


# Additional persona families to reach complete declared family coverage.
ADDITIONAL_FAMILIES: dict[str, dict[str, dict]] = {
    "windows": {
        "Aldhabi": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/win11/aldhabi6_85.ttf",
            "fontNumber": 0,
        },
        "Cambria Math": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/win11/cambria6_99.ttc",
            "fontNumber": 1,
        },
        "HoloLens MDL2 Assets": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/win11/segmdl21_86.ttf",
            "fontNumber": 0,
        },
        "MS Gothic": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/win11/msgothic5_32.ttc",
            "fontNumber": 0,
        },
        "Malgun Gothic": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/win11/malgun6_69.ttf",
            "fontNumber": 0,
        },
        "Microsoft Himalaya": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/win11/himalaya5_23.ttf",
            "fontNumber": 0,
        },
        "Microsoft JhengHei": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/win11/msjh6_15.ttc",
            "fontNumber": 0,
        },
        "Microsoft YaHei": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/win11/msyh6_31.ttc",
            "fontNumber": 0,
        },
        "MingLiU-ExtB": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/win11/mingliub7_10.ttc",
            "fontNumber": 0,
        },
        "Nirmala UI": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/win11/segoeui5_67.ttf",
            "fontNumber": 0,
        },
        "Segoe Fluent Icons": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/win11/segoeicons1_44.ttf",
            "fontNumber": 0,
        },
        "Segoe MDL2 Assets": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/win11/segmdl21_86.ttf",
            "fontNumber": 0,
        },
        "Segoe UI Emoji": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/win11/seguiemj1_60.ttf",
            "fontNumber": 0,
        },
        "SimSun": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/win11/simsun5_23.ttc",
            "fontNumber": 0,
        },
        "Sitka": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/win11/sitkavf2_02.ttf",
            "fontNumber": 0,
        },
        "Yu Gothic": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/win11/yugothm1_95.ttc",
            "fontNumber": 0,
        },
    },
    "macos": {
        "American Typewriter": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/AmericanTypewriter.ttc",
            "fontNumber": 0,
        },
        "American Typewriter Semibold": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/AmericanTypewriter.ttc",
            "fontNumber": 3,
        },
        "Andale Mono": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Andale Mono.ttf",
            "fontNumber": 0,
        },
        "Apple SD Gothic Neo ExtraBold": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/AppleSDGothicNeo.ttc",
            "fontNumber": 14,
        },
        "Avenir": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Avenir.ttc",
            "fontNumber": 11,
        },
        "Avenir Next": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Avenir Next.ttc",
            "fontNumber": 7,
        },
        "Avenir Next Condensed": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Avenir Next Condensed.ttc",
            "fontNumber": 7,
        },
        "Baskerville": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Baskerville.ttc",
            "fontNumber": 0,
        },
        "Bodoni 72": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Bodoni 72.ttc",
            "fontNumber": 0,
        },
        "Bradley Hand": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Bradley Hand Bold.ttf",
            "fontNumber": 0,
        },
        "Chalkboard": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Chalkboard.ttc",
            "fontNumber": 0,
        },
        "Chalkboard SE": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/ChalkboardSE.ttc",
            "fontNumber": 1,
        },
        "Charter": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Charter.ttc",
            "fontNumber": 0,
        },
        "Cochin": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Cochin.ttc",
            "fontNumber": 0,
        },
        "Copperplate": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Copperplate.ttc",
            "fontNumber": 0,
        },
        "Courier": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Courier.ttc",
            "fontNumber": 0,
        },
        "Didot": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Didot.ttc",
            "fontNumber": 0,
        },
        "DIN Alternate": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/DIN Alternate Bold.ttf",
            "fontNumber": 0,
        },
        "DIN Condensed": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/DIN Condensed Bold.ttf",
            "fontNumber": 0,
        },
        "Futura": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Futura.ttc",
            "fontNumber": 0,
        },
        "Futura Bold": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Futura.ttc",
            "fontNumber": 2,
        },
        "Galvji": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Galvji.ttc",
            "fontNumber": 0,
        },
        "Gill Sans": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/GillSans.ttc",
            "fontNumber": 0,
        },
        "Helvetica": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Helvetica.ttc",
            "fontNumber": 0,
        },
        "Helvetica Neue": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/HelveticaNeue.ttc",
            "fontNumber": 0,
        },
        "Hiragino Sans": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/HiraginoSans-W3.ttc",
            "fontNumber": 0,
        },
        "Hoefler Text": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Hoefler Text.ttc",
            "fontNumber": 0,
        },
        "InaiMathi Bold": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/InaiMathi-MN.ttc",
            "fontNumber": 1,
        },
        "Kohinoor Devanagari Medium": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Kohinoor.ttc",
            "fontNumber": 1,
        },
        "Lucida Grande": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/LucidaGrande.ttc",
            "fontNumber": 0,
        },
        "Marker Felt": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/MarkerFelt.ttc",
            "fontNumber": 0,
        },
        "Menlo": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Menlo.ttc",
            "fontNumber": 0,
        },
        "Microsoft Sans Serif": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Microsoft Sans Serif.ttf",
            "fontNumber": 0,
        },
        "MuktaMahee Regular": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/MuktaMahee.ttc",
            "fontNumber": 0,
        },
        "Noteworthy": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Noteworthy.ttc",
            "fontNumber": 0,
        },
        "Noto Sans Canadian Aboriginal Regular": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/NotoSansCanadianAboriginal-Regular.otf",
            "fontNumber": 0,
        },
        "Noto Sans Gunjala Gondi Regular": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/NotoSansGunjalaGondi-Regular.otf",
            "fontNumber": 0,
        },
        "Noto Sans Masaram Gondi Regular": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/NotoSansMasaramGondi-Regular.otf",
            "fontNumber": 0,
        },
        "Noto Serif Yezidi Regular": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/NotoSerifYezidi-Regular.otf",
            "fontNumber": 0,
        },
        "Optima": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Optima.ttc",
            "fontNumber": 0,
        },
        "Palatino": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Palatino.ttc",
            "fontNumber": 0,
        },
        "Papyrus": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Papyrus.ttc",
            "fontNumber": 1,
        },
        "Phosphate": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Phosphate.ttc",
            "fontNumber": 0,
        },
        "Rockwell": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Rockwell.ttc",
            "fontNumber": 0,
        },
        "Savoye LET": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Savoye LET.ttc",
            "fontNumber": 0,
        },
        "SignPainter": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/SignPainter.ttc",
            "fontNumber": 0,
        },
        "SignPainter-HouseScript Semibold": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/SignPainter.ttc",
            "fontNumber": 1,
        },
        "Skia": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Skia.ttf",
            "fontNumber": 0,
        },
        "Snell Roundhand": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/SnellRoundhand.ttc",
            "fontNumber": 0,
        },
        "STIX Two Math Regular": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/STIXTwoMath.otf",
            "fontNumber": 0,
        },
        "STIX Two Text Regular": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/STIXTwoText.ttf",
            "fontNumber": 0,
        },
        "Times": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Times.ttc",
            "fontNumber": 0,
        },
        "Trattatello": {
            "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Trattatello.ttf",
            "fontNumber": 0,
        },
    },
}

# Dynamically wire genuine PingFang font source when present on host.
pf_source_path, pf_has_genuine = resolve_pingfang_source()
if pf_has_genuine:
    ADDITIONAL_FAMILIES["macos"]["PingFang SC"] = {
        "relativePath": pf_source_path,
        "fontNumber": 3,
        "exact": True,
    }
    ADDITIONAL_FAMILIES["macos"]["PingFang HK Light"] = {
        "relativePath": pf_source_path,
        "fontNumber": 12,
        "exact": True,
    }
else:
    ADDITIONAL_FAMILIES["macos"]["PingFang SC"] = {
        "relativePath": "kernels/windows-x64/wayfern_fonts/macos/Hiragino Sans GB.ttc",
        "fontNumber": 0,
        "aliasFor": "Hiragino Sans GB",
        "source": "kernels/windows-x64/wayfern_fonts/macos/Hiragino Sans GB.ttc#0",
        "exact": False,
    }
    ADDITIONAL_FAMILIES["macos"]["PingFang HK Light"] = {
        "relativePath": "kernels/windows-x64/wayfern_fonts/macos/STHeiti Light.ttc",
        "fontNumber": 0,
        "aliasFor": "Heiti TC Light",
        "source": "kernels/windows-x64/wayfern_fonts/macos/STHeiti Light.ttc#0",
        "exact": False,
    }


def slugify(name: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", name.lower())).strip("-")


STYLE_INDICATORS = {
    "regular", "bold", "italic", "light", "medium", "semibold",
    "extrabold", "black", "thin", "heavy", "oblique", "book", "demi", "plain"
}


def compute_unique_id(family: str) -> str:
    fam_lower = family.lower()
    has_style = any(w in fam_lower.split() or fam_lower.endswith(w) for w in STYLE_INDICATORS)
    return family if has_style else f"{family} Regular"


def sanitize_font_metadata(font: TTFont, target_family: str) -> None:
    """Ensure authentic, consistent name records for nameID 1, 2, 3, 4, 5, 6, 8 across platforms.

    Populates clean, family-aligned records across Macintosh (1, 0, 0), Unicode (0, 3, 0),
    and Windows (3, 1, 1033) platforms. Eliminates host operating system build strings,
    timestamps, and foreign foundry annotations from deep OpenType metadata.
    """
    fam = target_family
    sub = "Regular"
    full = target_family
    ps = target_family.replace(" ", "").replace("-", "")
    uid = compute_unique_id(target_family)
    mfr = target_family
    ver = "Version 1.000"

    if "name" in font:
        name_table = font["name"]
        # Clear legacy and raw host records to eliminate deep metadata leakage
        name_table.names = []

        for pid, eid, lid in [(1, 0, 0), (0, 3, 0), (3, 1, 1033)]:
            name_table.setName(fam, 1, pid, eid, lid)
            name_table.setName(sub, 2, pid, eid, lid)
            name_table.setName(uid, 3, pid, eid, lid)
            name_table.setName(full, 4, pid, eid, lid)
            name_table.setName(ver, 5, pid, eid, lid)
            name_table.setName(ps, 6, pid, eid, lid)
            name_table.setName(mfr, 8, pid, eid, lid)



def build_one(src_path: str, dst_path: str, font_number: int = 0, target_family: str = "") -> dict:
    src = TTFont(src_path, fontNumber=font_number, lazy=False)

    # Cache original name table records before subsetting to prevent metadata loss
    raw_names: dict[int, str] = {}
    if "name" in src:
        for r in sorted(src["name"].names, key=lambda rec: (0 if rec.langID in (1033, 0) else 1)):
            if r.nameID in (1, 2, 4, 6) and r.nameID not in raw_names:
                try:
                    val = r.toUnicode()
                    if val and val.strip():
                        raw_names[r.nameID] = val.strip()
                except Exception:
                    pass

    options = Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    options.drop_tables += ["DSIG"]
    options.notdef_outline = True
    options.recalc_bounds = False
    options.recalc_timestamp = False
    options.retain_gids = False
    options.name_legacy = True
    options.name_languages = ["*"]
    options.name_IDs = ["*"]

    subsetter = Subsetter(options=options)
    subsetter.populate(unicodes=parse_unicodes(UNICODES))
    subsetter.subset(src)

    # Re-attach filtered legacy kern table pairs when surviving glyphs are present.
    try:
        header = TTFont(src_path, fontNumber=font_number, lazy=True)
        if "kern" in header.keys() and "kern" not in src.keys():
            full_font = TTFont(src_path, fontNumber=font_number, lazy=False)
            present = set(src.getGlyphOrder())
            kern = full_font["kern"]
            kept = 0
            for sub in getattr(kern, "kernTables", []):
                if not hasattr(sub, "kernTable"):
                    continue
                trimmed = {}
                for pair, value in sub.kernTable.items():
                    if pair[0] in present and pair[1] in present:
                        trimmed[pair] = value
                kept += len(trimmed)
                sub.kernTable = trimmed
            if kept:
                src["kern"] = kern
    except Exception:
        pass

    fam = target_family
    sub = "Regular"
    full = target_family
    ps = target_family.replace(" ", "").replace("-", "")

    # Apply authentic, sanitized name records across all standard platforms
    sanitize_font_metadata(src, target_family)

    # Chromium OpenType Sanitizer (OTS) requires an OS/2 table for web fonts
    if "OS/2" not in src:
        from fontTools.ttLib import newTable
        os2 = newTable("OS/2")
        os2.version = 2
        os2.xAvgCharWidth = 600
        os2.usWeightClass = 400
        os2.usWidthClass = 5
        os2.fsType = 0
        os2.ySubscriptXSize = 650
        os2.ySubscriptYSize = 600
        os2.ySubscriptXOffset = 0
        os2.ySubscriptYOffset = 75
        os2.ySuperscriptXSize = 650
        os2.ySuperscriptYSize = 600
        os2.ySuperscriptXOffset = 0
        os2.ySuperscriptYOffset = 350
        os2.yStrikeoutSize = 50
        os2.yStrikeoutPosition = 300
        os2.sFamilyClass = 0
        from fontTools.ttLib.tables.O_S_2f_2 import Panose
        os2.panose = Panose()
        os2.ulUnicodeRange1 = 0
        os2.ulUnicodeRange2 = 0
        os2.ulUnicodeRange3 = 0
        os2.ulUnicodeRange4 = 0
        os2.achVendID = b"APP "
        os2.fsSelection = 0x40
        os2.usFirstCharIndex = 0x20
        os2.usLastCharIndex = 0x7E
        os2.sTypoAscender = 800
        os2.sTypoDescender = -200
        os2.sTypoLineGap = 200
        os2.usWinAscent = 800
        os2.usWinDescent = 200
        os2.ulCodePageRange1 = 1
        os2.ulCodePageRange2 = 0
        os2.sxHeight = 500
        os2.sCapHeight = 700
        os2.usDefaultChar = 0
        os2.usBreakChar = 0x20
        os2.usMaxContext = 0
        src["OS/2"] = os2
        try:
            os2.recalcAvgCharWidth(src)
            os2.recalcUnicodeRanges(src)
            os2.recalcCodePageRanges(src)
        except Exception:
            pass

    os.makedirs(os.path.dirname(dst_path), exist_ok=True)
    src.flavor = "woff2"
    src.save(dst_path)
    return {
        "bytes": os.path.getsize(dst_path),
        "family": fam,
        "subfamily": sub,
        "fullName": full,
        "postscriptName": ps,
    }


def parse_unicodes(spec: str) -> list[int]:
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip().replace("U+", "")
        if "-" in part:
            lo, hi = part.split("-")
            out.extend(range(int(lo, 16), int(hi, 16) + 1))
        else:
            out.append(int(part, 16))
    return out


def sanitize_all_subsets(out_root: str = OUT_ROOT) -> int:
    """Sanitize OpenType name metadata across all existing font subsets in assets/font-subsets."""
    index_path = os.path.join(out_root, "index.json")
    if not os.path.exists(index_path):
        print(f"Index file missing at {index_path}", file=sys.stderr)
        return 1

    with open(index_path, "r", encoding="utf-8") as handle:
        index = json.load(handle)

    updated_count = 0
    grand_total = 0

    for platform, families in index.get("platforms", {}).items():
        for fam, spec in families.items():
            fpath = os.path.join(out_root, platform, spec["file"])
            if not os.path.exists(fpath):
                print(f"  skip  {platform}/{fam}: file missing on disk ({fpath})", file=sys.stderr)
                continue
            font = TTFont(fpath)
            sanitize_font_metadata(font, fam)
            font.flavor = "woff2"
            font.save(fpath)
            new_size = os.path.getsize(fpath)
            spec["bytes"] = new_size
            grand_total += new_size
            updated_count += 1

    index["metadata"]["totalBytes"] = grand_total
    with open(index_path, "w", encoding="utf-8") as handle:
        json.dump(index, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")

    print(f"Sanitized deep metadata across {updated_count} font subsets; total bytes: {grand_total}", file=sys.stderr)
    return 0


def main() -> int:
    if "--sanitize-existing" in sys.argv:
        return sanitize_all_subsets()
    with open(INDEX_SRC, "r", encoding="utf-8") as handle:
        source = json.load(handle)

    families = source.get("families", {})

    # Merge additional families into the target platforms.
    for platform, extra_entries in ADDITIONAL_FAMILIES.items():
        target_platform = families.setdefault(platform, {})
        for fam, spec in extra_entries.items():
            target_platform[fam] = spec

    target_platforms = [p for p in sys.argv[1:] if not p.startswith("-")]

    index_path = os.path.join(OUT_ROOT, "index.json")
    index: dict[str, dict] = {"metadata": {}, "platforms": {}}
    if os.path.exists(index_path):
        try:
            with open(index_path, "r", encoding="utf-8") as handle:
                existing_index = json.load(handle)
                index["platforms"] = existing_index.get("platforms", {})
                if "metadata" in existing_index:
                    index["metadata"] = existing_index["metadata"]
        except Exception:
            pass

    for platform, entries in families.items():
        if not isinstance(entries, dict):
            continue
        if target_platforms and platform not in target_platforms:
            continue
        built: dict[str, dict] = {}
        platform_bytes = 0
        for family, spec in sorted(entries.items()):
            src_rel = spec.get("relativePath") or ""
            font_number = int(spec.get("fontNumber", 0))
            if "#" in src_rel:
                src_rel, fn_str = src_rel.split("#", 1)
                try:
                    font_number = int(fn_str)
                except ValueError:
                    pass
            src_path = src_rel if os.path.isabs(src_rel) else os.path.join(ROOT, src_rel)
            if not src_path or not os.path.exists(src_path):
                print(f"  skip  {platform}/{family}: source missing ({src_rel})", file=sys.stderr)
                continue
            dst_rel = os.path.join("assets", "font-subsets", platform, slugify(family) + ".woff2")
            dst_path = os.path.join(ROOT, dst_rel)
            try:
                info = build_one(src_path, dst_path, font_number=font_number, target_family=family)
            except Exception as error:  # noqa: BLE001 - report and continue
                print(f"  fail  {platform}/{family}: {error}", file=sys.stderr)
                continue
            platform_bytes += info["bytes"]
            is_exact = True if spec.get("exact", True) and "aliasFor" not in spec else False
            entry_dict = {
                "file": slugify(family) + ".woff2",
                "bytes": info["bytes"],
                "family": info.get("family", family),
                "fullName": info.get("fullName", family),
                "postscriptName": info.get("postscriptName", family.replace(" ", "")),
                "exact": is_exact,
            }
            if "aliasFor" in spec:
                entry_dict["aliasFor"] = spec["aliasFor"]
                entry_dict["exact"] = False
            if "source" in spec:
                entry_dict["source"] = spec["source"]
            built[family] = entry_dict
        index["platforms"][platform] = built
        print(f"  built {platform}: {len(built)} families, {platform_bytes / 1024:.0f} KB", file=sys.stderr)

    grand_total = sum(
        sum(item.get("bytes", 0) for item in p_data.values())
        for p_data in index["platforms"].values()
    )

    aliases_meta = {}
    for p_name, p_data in index["platforms"].items():
        for f_name, f_spec in p_data.items():
            if "aliasFor" in f_spec:
                aliases_meta[f_name] = {
                    "aliasFor": f_spec["aliasFor"],
                    "source": f_spec.get("source", ""),
                }

    index["metadata"] = {
        "unicodes": UNICODES,
        "note": "Subsets preserve the advance widths and kern pairs of the source fonts.",
        "totalBytes": grand_total,
    }
    if aliases_meta:
        index["metadata"]["aliasFor"] = aliases_meta
    elif "aliasFor" in index.get("metadata", {}):
        del index["metadata"]["aliasFor"]

    os.makedirs(OUT_ROOT, exist_ok=True)
    with open(index_path, "w", encoding="utf-8") as handle:
        json.dump(index, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    print(f"  total: {grand_total / 1024:.0f} KB", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
