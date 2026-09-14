#!/usr/bin/env python3
"""Comprehensive parity verifier: WOFF2 font subsets vs. decompressed SFNT (.ttf / .otf).

Verifies strict mathematical, metric, and structural parity across all 6 critical dimensions:
  1. Container & Identity: Magic header (00010000 / OTTO), sfntVersion, unitsPerEm, numGlyphs,
     checkSumAdjustment accounting, and name table (nameIDs 1, 2, 4, 6, 16, 17).
  2. Character Coverage: cmap subtable mappings and complete unicode codepoint set equality.
  3. Horizontal Metrics: hmtx advanceWidth/lsb per glyph, hhea advanceWidthMax/numberOfHMetrics,
     and OS/2 xAvgCharWidth.
  4. Vertical / Baseline Metrics: head unitsPerEm, hhea ascent/descent/lineGap,
     OS/2 sTypoAscender/sTypoDescender/sTypoLineGap/usWinAscent/usWinDescent.
  5. Glyph Outlines & Contours: glyf/loca (TrueType) and CFF (OpenType) table byte identity,
     plus RecordingPen verification of commands, coordinates, and contour/point counts.
  6. Layout & Auxiliary Tables: GPOS/GSUB/kern/GDEF and hint tables byte-for-byte identity;
     verification that head.checkSumAdjustment and head.modified are the only differing attributes.

Usage:
  python3 scripts/font-metrics-parity-check.py [--platform windows|macos|linux|android] [--json] [--fast]
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
sys.dont_write_bytecode = True  # never leave __pycache__ in the release tree
import time
from typing import Any

# Suppress harmless fontTools warnings about OS/2 table versions
logging.getLogger("fontTools").setLevel(logging.ERROR)

from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import RecordingPen

HERE = os.path.dirname(os.path.abspath(__file__))
APP_ROOT = os.path.dirname(HERE)
SUBSETS_ROOT = os.path.join(APP_ROOT, "assets", "font-subsets")
PLATFORMS = ["windows", "macos", "linux", "android"]

TARGET_NAME_IDS = [1, 2, 4, 6, 16, 17]


def get_name_records(font: TTFont) -> dict[str, str]:
    names: dict[str, str] = {}
    if "name" not in font:
        return names
    for rec in font["name"].names:
        if rec.nameID in TARGET_NAME_IDS:
            key = f"nameID_{rec.nameID}_plat_{rec.platformID}_enc_{rec.platEncID}_lang_{rec.langID}"
            try:
                names[key] = rec.toUnicode()
            except Exception:
                names[key] = repr(rec.string)
    return names


def get_cmap_data(font: TTFont) -> tuple[set[int], list[dict[str, Any]]]:
    all_codepoints: set[int] = set()
    subtables: list[dict[str, Any]] = []
    if "cmap" not in font:
        return all_codepoints, subtables
    for idx, table in enumerate(font["cmap"].tables):
        cp_keys = set(table.cmap.keys())
        all_codepoints.update(cp_keys)
        subtables.append({
            "subtable_index": idx,
            "platformID": table.platformID,
            "platEncID": table.platEncID,
            "format": table.format,
            "language": getattr(table, "language", None),
            "codepoint_count": len(cp_keys),
            "mapping": dict(table.cmap),
        })
    return all_codepoints, subtables


def count_contours_and_points(pen_value: list[tuple[str, tuple]]) -> tuple[int, int]:
    contour_count = 0
    point_count = 0
    for cmd, args in pen_value:
        if cmd in ("closePath", "endPath"):
            contour_count += 1
        else:
            point_count += len(args)
    return contour_count, point_count


def verify_pair(
    platform: str,
    base_name: str,
    woff2_path: str,
    sfnt_path: str,
    is_cff: bool,
    deep_pen_check: bool = True,
) -> dict[str, Any]:
    font_id = f"{platform}/{base_name}"
    failures: list[dict[str, Any]] = []
    metadata: dict[str, Any] = {}

    # Read raw header magic
    expected_magic = b"OTTO" if is_cff else b"\x00\x01\x00\x00"
    with open(sfnt_path, "rb") as f:
        raw_header = f.read(4)
    if raw_header != expected_magic:
        failures.append({
            "section": "container_identity",
            "field": "raw_header_magic",
            "woff2_val": expected_magic.hex(),
            "sfnt_val": raw_header.hex(),
            "detail": f"Expected raw SFNT header {expected_magic!r}, got {raw_header!r}",
        })

    f_w = TTFont(woff2_path)
    f_s = TTFont(sfnt_path)

    # 1. Container & Identity
    metadata["sfntVersion_woff2"] = f_w.sfntVersion
    metadata["sfntVersion_sfnt"] = f_s.sfntVersion
    if f_w.sfntVersion != f_s.sfntVersion:
        failures.append({
            "section": "container_identity",
            "field": "sfntVersion",
            "woff2_val": f_w.sfntVersion,
            "sfnt_val": f_s.sfntVersion,
        })

    num_glyphs_w = f_w["maxp"].numGlyphs if "maxp" in f_w else 0
    num_glyphs_s = f_s["maxp"].numGlyphs if "maxp" in f_s else 0
    metadata["numGlyphs"] = num_glyphs_w
    if num_glyphs_w != num_glyphs_s:
        failures.append({
            "section": "container_identity",
            "field": "numGlyphs",
            "woff2_val": num_glyphs_w,
            "sfnt_val": num_glyphs_s,
        })

    upem_w = f_w["head"].unitsPerEm if "head" in f_w else None
    upem_s = f_s["head"].unitsPerEm if "head" in f_s else None
    metadata["unitsPerEm"] = upem_w
    if upem_w != upem_s:
        failures.append({
            "section": "container_identity",
            "field": "unitsPerEm",
            "woff2_val": upem_w,
            "sfnt_val": upem_s,
        })

    chk_w = hex(f_w["head"].checkSumAdjustment) if "head" in f_w else None
    chk_s = hex(f_s["head"].checkSumAdjustment) if "head" in f_s else None
    metadata["checkSumAdjustment_woff2"] = chk_w
    metadata["checkSumAdjustment_sfnt"] = chk_s

    # Name records comparison (nameIDs 1, 2, 4, 6, 16, 17)
    names_w = get_name_records(f_w)
    names_s = get_name_records(f_s)
    if names_w != names_s:
        diff_keys = set(names_w.keys()) ^ set(names_s.keys())
        diff_details = {}
        for k in diff_keys:
            diff_details[k] = {"woff2": names_w.get(k), "sfnt": names_s.get(k)}
        for k in set(names_w.keys()) & set(names_s.keys()):
            if names_w[k] != names_s[k]:
                diff_details[k] = {"woff2": names_w[k], "sfnt": names_s[k]}
        failures.append({
            "section": "container_identity",
            "field": "name_table_records",
            "woff2_val": {k: names_w.get(k) for k in diff_details},
            "sfnt_val": {k: names_s.get(k) for k in diff_details},
            "detail": diff_details,
        })

    # 2. Character Coverage (cmap)
    cp_w, subtables_w = get_cmap_data(f_w)
    cp_s, subtables_s = get_cmap_data(f_s)
    metadata["codepoint_count"] = len(cp_w)
    if cp_w != cp_s:
        missing_in_sfnt = list(cp_w - cp_s)[:10]
        extra_in_sfnt = list(cp_s - cp_w)[:10]
        failures.append({
            "section": "character_coverage",
            "field": "cmap_codepoint_set",
            "woff2_val": f"{len(cp_w)} codepoints",
            "sfnt_val": f"{len(cp_s)} codepoints",
            "detail": {"missing_in_sfnt": missing_in_sfnt, "extra_in_sfnt": extra_in_sfnt},
        })
    if len(subtables_w) != len(subtables_s):
        failures.append({
            "section": "character_coverage",
            "field": "cmap_subtable_count",
            "woff2_val": len(subtables_w),
            "sfnt_val": len(subtables_s),
        })
    else:
        for idx in range(len(subtables_w)):
            st_w = subtables_w[idx]
            st_s = subtables_s[idx]
            if st_w["platformID"] != st_s["platformID"] or st_w["platEncID"] != st_s["platEncID"] or st_w["format"] != st_s["format"]:
                failures.append({
                    "section": "character_coverage",
                    "field": f"cmap_subtable_{idx}_header",
                    "woff2_val": (st_w["platformID"], st_w["platEncID"], st_w["format"]),
                    "sfnt_val": (st_s["platformID"], st_s["platEncID"], st_s["format"]),
                })
            if st_w["mapping"] != st_s["mapping"]:
                failures.append({
                    "section": "character_coverage",
                    "field": f"cmap_subtable_{idx}_mapping",
                    "woff2_val": f"{len(st_w['mapping'])} mappings",
                    "sfnt_val": f"{len(st_s['mapping'])} mappings",
                })

    # 3. Horizontal Metrics
    if "hmtx" in f_w and "hmtx" in f_s:
        metrics_w = f_w["hmtx"].metrics
        metrics_s = f_s["hmtx"].metrics
        if metrics_w != metrics_s:
            diff_glyphs = []
            for g in metrics_w:
                if g not in metrics_s or metrics_w[g] != metrics_s[g]:
                    diff_glyphs.append((g, metrics_w.get(g), metrics_s.get(g)))
            failures.append({
                "section": "horizontal_metrics",
                "field": "hmtx_glyph_metrics",
                "woff2_val": f"{len(metrics_w)} glyphs",
                "sfnt_val": f"{len(metrics_s)} glyphs",
                "detail": diff_glyphs[:5],
            })
    elif ("hmtx" in f_w) != ("hmtx" in f_s):
        failures.append({
            "section": "horizontal_metrics",
            "field": "hmtx_table_presence",
            "woff2_val": "hmtx" in f_w,
            "sfnt_val": "hmtx" in f_s,
        })

    if "hhea" in f_w and "hhea" in f_s:
        for field in ["advanceWidthMax", "numberOfHMetrics"]:
            vw = getattr(f_w["hhea"], field)
            vs = getattr(f_s["hhea"], field)
            if vw != vs:
                failures.append({
                    "section": "horizontal_metrics",
                    "field": f"hhea_{field}",
                    "woff2_val": vw,
                    "sfnt_val": vs,
                })
    elif ("hhea" in f_w) != ("hhea" in f_s):
        failures.append({
            "section": "horizontal_metrics",
            "field": "hhea_table_presence",
            "woff2_val": "hhea" in f_w,
            "sfnt_val": "hhea" in f_s,
        })

    if "OS/2" in f_w and "OS/2" in f_s:
        vw = f_w["OS/2"].xAvgCharWidth
        vs = f_s["OS/2"].xAvgCharWidth
        if vw != vs:
            failures.append({
                "section": "horizontal_metrics",
                "field": "OS/2_xAvgCharWidth",
                "woff2_val": vw,
                "sfnt_val": vs,
            })
    elif ("OS/2" in f_w) != ("OS/2" in f_s):
        failures.append({
            "section": "horizontal_metrics",
            "field": "OS/2_table_presence",
            "woff2_val": "OS/2" in f_w,
            "sfnt_val": "OS/2" in f_s,
        })

    # 4. Vertical / Baseline Metrics
    if "hhea" in f_w and "hhea" in f_s:
        for field in ["ascent", "descent", "lineGap"]:
            vw = getattr(f_w["hhea"], field)
            vs = getattr(f_s["hhea"], field)
            if vw != vs:
                failures.append({
                    "section": "vertical_baseline_metrics",
                    "field": f"hhea_{field}",
                    "woff2_val": vw,
                    "sfnt_val": vs,
                })

    if "OS/2" in f_w and "OS/2" in f_s:
        for field in ["sTypoAscender", "sTypoDescender", "sTypoLineGap", "usWinAscent", "usWinDescent"]:
            vw = getattr(f_w["OS/2"], field, None)
            vs = getattr(f_s["OS/2"], field, None)
            if vw != vs:
                failures.append({
                    "section": "vertical_baseline_metrics",
                    "field": f"OS/2_{field}",
                    "woff2_val": vw,
                    "sfnt_val": vs,
                })

    # 5. Glyph Outlines
    if is_cff:
        if "CFF " in f_w and "CFF " in f_s:
            bw = f_w.getTableData("CFF ")
            bs = f_s.getTableData("CFF ")
            if bw != bs:
                failures.append({
                    "section": "glyph_outlines",
                    "field": "CFF_table_bytes",
                    "woff2_val": len(bw),
                    "sfnt_val": len(bs),
                    "detail": "CFF table bytes differed",
                })
        elif ("CFF " in f_w) != ("CFF " in f_s):
            failures.append({
                "section": "glyph_outlines",
                "field": "CFF_presence",
                "woff2_val": "CFF " in f_w,
                "sfnt_val": "CFF " in f_s,
            })
    else:
        for tbl in ["glyf", "loca"]:
            if tbl in f_w and tbl in f_s:
                bw = f_w.getTableData(tbl)
                bs = f_s.getTableData(tbl)
                if bw != bs:
                    failures.append({
                        "section": "glyph_outlines",
                        "field": f"{tbl}_table_bytes",
                        "woff2_val": len(bw),
                        "sfnt_val": len(bs),
                        "detail": f"{tbl} table bytes differed",
                    })
            elif (tbl in f_w) != (tbl in f_s):
                failures.append({
                    "section": "glyph_outlines",
                    "field": f"{tbl}_presence",
                    "woff2_val": tbl in f_w,
                    "sfnt_val": tbl in f_s,
                })

    # Deep RecordingPen contour and coordinate check across all glyphs
    glyph_count_verified = 0
    if deep_pen_check:
        gs_w = f_w.getGlyphSet()
        gs_s = f_s.getGlyphSet()
        keys_w = set(gs_w.keys())
        keys_s = set(gs_s.keys())
        if keys_w != keys_s:
            failures.append({
                "section": "glyph_outlines",
                "field": "glyph_order_keys",
                "woff2_val": len(keys_w),
                "sfnt_val": len(keys_s),
            })
        else:
            for gname in gs_w.keys():
                glyph_count_verified += 1
                pen_w = RecordingPen()
                pen_s = RecordingPen()
                gs_w[gname].draw(pen_w)
                gs_s[gname].draw(pen_s)
                if pen_w.value != pen_s.value:
                    c_w, pt_w = count_contours_and_points(pen_w.value)
                    c_s, pt_s = count_contours_and_points(pen_s.value)
                    failures.append({
                        "section": "glyph_outlines",
                        "field": f"glyph_{gname}_outline_mismatch",
                        "woff2_val": f"contours={c_w}, points={pt_w}, commands={len(pen_w.value)}",
                        "sfnt_val": f"contours={c_s}, points={pt_s}, commands={len(pen_s.value)}",
                        "detail": f"Glyph {gname} path commands or coordinates differed",
                    })
                    break
    metadata["glyphs_drawn_verified"] = glyph_count_verified

    # 6. Layout & Auxiliary Tables
    layout_tables = ["GPOS", "GSUB", "kern", "GDEF"]
    for tbl in layout_tables:
        if tbl in f_w or tbl in f_s:
            if (tbl in f_w) != (tbl in f_s):
                failures.append({
                    "section": "layout_rendering",
                    "field": f"{tbl}_presence",
                    "woff2_val": tbl in f_w,
                    "sfnt_val": tbl in f_s,
                })
            else:
                bw = f_w.getTableData(tbl)
                bs = f_s.getTableData(tbl)
                if bw != bs:
                    failures.append({
                        "section": "layout_rendering",
                        "field": f"{tbl}_table_bytes",
                        "woff2_val": len(bw),
                        "sfnt_val": len(bs),
                    })

    # Verify all remaining tables and attribute head difference strictly
    all_tables = (set(f_w.keys()) | set(f_s.keys())) - {"GlyphOrder"}
    for tbl in all_tables:
        if (tbl in f_w) != (tbl in f_s):
            failures.append({
                "section": "table_inventory",
                "field": f"table_{tbl}_presence",
                "woff2_val": tbl in f_w,
                "sfnt_val": tbl in f_s,
            })
            continue
        bw = f_w.getTableData(tbl)
        bs = f_s.getTableData(tbl)
        if bw != bs:
            if tbl == "head":
                # Ensure only checkSumAdjustment and modified differ
                head_w = f_w["head"]
                head_s = f_s["head"]
                unauthorized_head_diffs = []
                for attr in [
                    "tableVersion", "fontRevision", "magicNumber", "flags", "unitsPerEm",
                    "created", "xMin", "yMin", "xMax", "yMax", "macStyle", "lowestRecPPEM",
                    "fontDirectionHint", "indexToLocFormat", "glyphDataFormat"
                ]:
                    vw = getattr(head_w, attr, None)
                    vs = getattr(head_s, attr, None)
                    if vw != vs:
                        unauthorized_head_diffs.append((attr, vw, vs))
                if unauthorized_head_diffs:
                    failures.append({
                        "section": "table_inventory",
                        "field": "head_unauthorized_attribute_diff",
                        "woff2_val": str(unauthorized_head_diffs),
                        "sfnt_val": "identical",
                    })
            else:
                failures.append({
                    "section": "table_inventory",
                    "field": f"unexpected_table_byte_diff_{tbl}",
                    "woff2_val": len(bw),
                    "sfnt_val": len(bs),
                })

    return {
        "font_id": font_id,
        "platform": platform,
        "base_name": base_name,
        "format": "OTF/CFF" if is_cff else "TTF",
        "ok": len(failures) == 0,
        "failures": failures,
        "metadata": metadata,
    }


def main():
    parser = argparse.ArgumentParser(description="Verify font metrics parity between WOFF2 and SFNT")
    parser.add_argument("--platform", choices=PLATFORMS, help="Check single platform")
    parser.add_argument("--json", action="store_true", help="Output JSON results")
    parser.add_argument("--fast", action="store_true", help="Skip deep glyph outline pen check")
    parser.add_argument("--verbose", action="store_true", help="Verbose progress")
    args = parser.parse_args()

    target_platforms = [args.platform] if args.platform else PLATFORMS
    start_time = time.time()

    pairs_to_check: list[tuple[str, str, str, str, bool]] = []
    for plat in target_platforms:
        plat_dir = os.path.join(SUBSETS_ROOT, plat)
        if not os.path.isdir(plat_dir):
            continue
        woff2_files = sorted([f for f in os.listdir(plat_dir) if f.endswith(".woff2")])
        for wf in woff2_files:
            base = wf[:-6]
            ttf_path = os.path.join(plat_dir, base + ".ttf")
            otf_path = os.path.join(plat_dir, base + ".otf")
            if os.path.exists(otf_path):
                pairs_to_check.append((plat, base, os.path.join(plat_dir, wf), otf_path, True))
            elif os.path.exists(ttf_path):
                pairs_to_check.append((plat, base, os.path.join(plat_dir, wf), ttf_path, False))
            else:
                pairs_to_check.append((plat, base, os.path.join(plat_dir, wf), "", False))

    results: list[dict[str, Any]] = []
    ok_count = 0
    fail_count = 0
    total_glyphs_drawn = 0

    if not args.json:
        print("================================================================================")
        print("     SFNT vs WOFF2 FONT SUBSETS STRICT METRICS & SHAPE PARITY AUDIT             ")
        print("================================================================================")
        print(f"Target platforms: {', '.join(target_platforms)}")
        print(f"Total font pairs to verify: {len(pairs_to_check)}")
        print(f"Deep outline pen check: {not args.fast}\n")

    for plat, base, woff2_p, sfnt_p, is_cff in pairs_to_check:
        if not sfnt_p or not os.path.exists(sfnt_p):
            res = {
                "font_id": f"{plat}/{base}",
                "platform": plat,
                "base_name": base,
                "format": "UNKNOWN",
                "ok": False,
                "failures": [{
                    "section": "container_identity",
                    "field": "file_existence",
                    "woff2_val": "exists",
                    "sfnt_val": "missing",
                    "detail": "Corresponding SFNT (.ttf or .otf) file not found",
                }],
                "metadata": {},
            }
            results.append(res)
            fail_count += 1
            if not args.json:
                print(f"  FAIL  {plat}/{base}: SFNT file missing")
            continue

        res = verify_pair(
            platform=plat,
            base_name=base,
            woff2_path=woff2_p,
            sfnt_path=sfnt_p,
            is_cff=is_cff,
            deep_pen_check=not args.fast,
        )
        results.append(res)
        if res["ok"]:
            ok_count += 1
            total_glyphs_drawn += res["metadata"].get("glyphs_drawn_verified", 0)
            if args.verbose and not args.json:
                print(f"  PASS  {res['font_id']:<40} [{res['format']}] ({res['metadata'].get('numGlyphs', 0)} glyphs, {res['metadata'].get('codepoint_count', 0)} codepoints)")
        else:
            fail_count += 1
            if not args.json:
                print(f"  FAIL  {res['font_id']:<40} [{res['format']}]")
                for fl in res["failures"]:
                    print(f"        -> [{fl['section']}] {fl['field']}: woff2={fl.get('woff2_val')} vs sfnt={fl.get('sfnt_val')}")

    elapsed = time.time() - start_time

    # Summary by platform
    platform_summary: dict[str, dict[str, int]] = {}
    for plat in target_platforms:
        plat_res = [r for r in results if r["platform"] == plat]
        platform_summary[plat] = {
            "total": len(plat_res),
            "ok": sum(1 for r in plat_res if r["ok"]),
            "fail": sum(1 for r in plat_res if not r["ok"]),
            "ttf": sum(1 for r in plat_res if r.get("format") == "TTF"),
            "otf": sum(1 for r in plat_res if r.get("format") == "OTF/CFF"),
        }

    summary_payload = {
        "pairs": len(pairs_to_check),
        "ok": ok_count,
        "fail": fail_count,
        "elapsed_seconds": round(elapsed, 2),
        "total_glyphs_drawn": total_glyphs_drawn,
        "deep_pen_check": not args.fast,
        "platforms": platform_summary,
        "results": results,
    }

    if args.json:
        print(json.dumps(summary_payload, indent=2))
        sys.exit(0 if fail_count == 0 else 1)

    print("\n--------------------------------------------------------------------------------")
    print(f"{'Platform':<14} {'Pairs':<10} {'OK':<10} {'FAIL':<10} {'TTF':<10} {'OTF/CFF':<10}")
    print("--------------------------------------------------------------------------------")
    for plat, st in platform_summary.items():
        print(f"{plat:<14} {st['total']:<10} {st['ok']:<10} {st['fail']:<10} {st['ttf']:<10} {st['otf']:<10}")
    print("--------------------------------------------------------------------------------")
    print(f"{'TOTAL':<14} {len(pairs_to_check):<10} {ok_count:<10} {fail_count:<10} {sum(s['ttf'] for s in platform_summary.values()):<10} {sum(s['otf'] for s in platform_summary.values()):<10}")
    print("--------------------------------------------------------------------------------\n")

    print(f"Audit Summary:")
    print(f"  pairs={len(pairs_to_check)} ok={ok_count} fail={fail_count}")
    print(f"  Total glyph outlines verified via RecordingPen: {total_glyphs_drawn:,}")
    print(f"  Elapsed verification time: {elapsed:.2f}s\n")

    if fail_count > 0:
        print(f"font-sfnt-woff2-metrics-parity-selftest: FAIL ({fail_count} failed)")
        sys.exit(1)
    else:
        print(f"font-sfnt-woff2-metrics-parity-selftest: OK {ok_count}/{ok_count}")
        sys.exit(0)


if __name__ == "__main__":
    main()
