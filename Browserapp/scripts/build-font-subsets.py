#!/usr/bin/env python3
"""Build compact WOFF2 subsets for the font families shipped with the fingerprint layer.

The kernel font assets under kernels/*/wayfern_fonts are full system fonts (200 KB - 1.7 MB
each). Document-layer font registration needs the bytes inline, so the payload has to be
small. Subsetting to the printable Latin range keeps every advance width and kerning pair that
matters for text metrics while cutting each file by roughly 20x.

Metrics must stay bit-identical to the full font, so the legacy `kern` table is re-attached
(filtered to the glyphs that survived subsetting). Dropping it changes kerned pairs by several
pixels, which is itself a detectable inconsistency.

Usage: python3 scripts/build-font-subsets.py
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

# Printable ASCII + Latin-1 supplement + typographic punctuation. This is the range that
# font-metric probes use; every advance width in it is preserved exactly.
UNICODES = "U+0020-007E,U+00A0-00FF,U+2013-2014,U+2018-201D,U+2022,U+2026,U+20AC,U+2122"


def slugify(name: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", name.lower())).strip("-")


def build_one(src_path: str, dst_path: str) -> dict:
    src = TTFont(src_path, lazy=False)
    options = Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    options.drop_tables += ["DSIG"]
    options.notdef_outline = True
    options.recalc_bounds = False
    options.recalc_timestamp = False
    options.retain_gids = False

    subsetter = Subsetter(options=options)
    subsetter.populate(unicodes=parse_unicodes(UNICODES))
    subsetter.subset(src)

    # fontTools drops the legacy kern table whenever the font also has GPOS. Chrome still applies
    # it, so re-attach the pairs whose two glyphs both survived the subset.
    if "kern" in TTFont(src_path, lazy=True).keys() and "kern" not in src.keys():
        full = TTFont(src_path, lazy=False)
        present = set(src.getGlyphOrder())
        kern = full["kern"]
        kept = 0
        for sub in kern.kernTables:
            trimmed = {}
            for pair, value in sub.kernTable.items():
                if pair[0] in present and pair[1] in present:
                    trimmed[pair] = value
            kept += len(trimmed)
            sub.kernTable = trimmed
        if kept:
            src["kern"] = kern

    os.makedirs(os.path.dirname(dst_path), exist_ok=True)
    src.flavor = "woff2"
    src.save(dst_path)
    return {"bytes": os.path.getsize(dst_path)}


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


def main() -> int:
    with open(INDEX_SRC, "r", encoding="utf-8") as handle:
        source = json.load(handle)

    families = source.get("families", {})
    index: dict[str, dict] = {"metadata": {}, "platforms": {}}
    grand_total = 0

    for platform, entries in families.items():
        if not isinstance(entries, dict):
            continue
        built: dict[str, dict] = {}
        platform_bytes = 0
        for family, spec in sorted(entries.items()):
            src_rel = spec.get("relativePath") or ""
            src_path = os.path.join(ROOT, src_rel) if src_rel else ""
            if not src_path or not os.path.exists(src_path):
                print(f"  skip  {platform}/{family}: source missing ({src_rel})", file=sys.stderr)
                continue
            dst_rel = os.path.join("assets", "font-subsets", platform, slugify(family) + ".woff2")
            dst_path = os.path.join(ROOT, dst_rel)
            try:
                info = build_one(src_path, dst_path)
            except Exception as error:  # noqa: BLE001 - report and continue
                print(f"  fail  {platform}/{family}: {error}", file=sys.stderr)
                continue
            platform_bytes += info["bytes"]
            built[family] = {"file": slugify(family) + ".woff2", "bytes": info["bytes"]}
        index["platforms"][platform] = built
        grand_total += platform_bytes
        print(f"  built {platform}: {len(built)} families, {platform_bytes / 1024:.0f} KB", file=sys.stderr)

    index["metadata"] = {
        "unicodes": UNICODES,
        "note": "Subsets preserve the advance widths and kern pairs of the source fonts.",
        "totalBytes": grand_total,
    }
    os.makedirs(OUT_ROOT, exist_ok=True)
    with open(os.path.join(OUT_ROOT, "index.json"), "w", encoding="utf-8") as handle:
        json.dump(index, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    print(f"  total: {grand_total / 1024:.0f} KB", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
