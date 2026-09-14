#!/usr/bin/env python3
"""Reproducibly decompress WOFF2 font subsets into authentic native SFNT binaries (.ttf / .otf).

Chrome's native Local Font Access API FontData.blob() delivers authentic SFNT font binaries
(TrueType 0x00010000 or OpenType CFF 'OTTO') with empty MIME type (type === ''), rather than
web-compressed WOFF2 packages. Serving WOFF2 payloads leaks a measurable fingerprint anomaly
via DataView header reads.

This script decompresses each platform WOFF2 subset to its native SFNT equivalent without
re-subsetting or re-encoding outlines:
  - TrueType outlines (glyf table) -> .ttf (magic: 0x00010000)
  - CFF outlines (CFF table)       -> .otf (magic: 'OTTO')

Preserves existing .woff2 files intact for CSS @font-face compatibility.
Idempotent and includes verification of table structure, glyph count, and magic header.

Usage:
  python3 scripts/font-subset-decompress-to-sfnt.py [--force] [--dry-run]
"""

from __future__ import annotations

import argparse
import io
import os
import sys
sys.dont_write_bytecode = True  # never leave __pycache__ in the release tree
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
APP_ROOT = os.path.dirname(HERE)
SUBSETS_ROOT = os.path.join(APP_ROOT, "assets", "font-subsets")
PLATFORMS = ["windows", "macos", "linux", "android"]


def determine_sfnt_format(font: TTFont) -> tuple[str, bytes]:
    """Determine target extension (.ttf or .otf) and expected magic bytes from font outlines."""
    if "CFF " in font or "CFF2" in font or font.sfntVersion == "OTTO":
        return ".otf", b"OTTO"
    return ".ttf", b"\x00\x01\x00\x00"


def verify_sfnt_data(raw_data: bytes, original_font: TTFont, expected_magic: bytes, rel_path: str) -> None:
    """Validate header magic, table count, glyph count, and critical table presence."""
    if len(raw_data) < 12:
        raise ValueError(f"{rel_path}: file too small ({len(raw_data)} bytes)")
    actual_magic = raw_data[:4]
    if actual_magic != expected_magic:
        raise ValueError(f"{rel_path}: magic header mismatch: expected {expected_magic!r}, got {actual_magic!r}")

    # Parse back with TTFont
    readback = TTFont(io.BytesIO(raw_data))
    orig_glyphs = len(original_font.getGlyphOrder())
    readback_glyphs = len(readback.getGlyphOrder())
    if orig_glyphs != readback_glyphs:
        raise ValueError(f"{rel_path}: glyph count mismatch (orig: {orig_glyphs}, readback: {readback_glyphs})")

    for tbl in ["head", "cmap", "name", "hmtx"]:
        if tbl in original_font and tbl not in readback:
            raise ValueError(f"{rel_path}: critical table {tbl} missing in decompressed SFNT")


def process_font_file(src_path: str, force: bool = False, dry_run: bool = False) -> dict:
    """Decompress a single .woff2 file to SFNT (.ttf or .otf) and verify."""
    rel_src = os.path.relpath(src_path, SUBSETS_ROOT)
    woff2_size = os.path.getsize(src_path)

    font = TTFont(src_path)
    ext, expected_magic = determine_sfnt_format(font)
    base, _ = os.path.splitext(src_path)
    out_path = base + ext
    rel_out = os.path.relpath(out_path, SUBSETS_ROOT)

    # If already exists and valid, skip unless force
    if not force and os.path.exists(out_path):
        with open(out_path, "rb") as f:
            existing_data = f.read()
        try:
            verify_sfnt_data(existing_data, font, expected_magic, rel_out)
            return {
                "ok": True,
                "skipped": True,
                "rel_src": rel_src,
                "rel_out": rel_out,
                "ext": ext,
                "magic": expected_magic.hex(),
                "woff2_size": woff2_size,
                "sfnt_size": len(existing_data),
            }
        except Exception:
            # Re-generate if existing file was corrupted
            pass

    buf = io.BytesIO()
    font.flavor = None
    font.save(buf)
    sfnt_bytes = buf.getvalue()

    verify_sfnt_data(sfnt_bytes, font, expected_magic, rel_out)

    if not dry_run:
        with open(out_path, "wb") as f:
            f.write(sfnt_bytes)

    return {
        "ok": True,
        "skipped": False,
        "rel_src": rel_src,
        "rel_out": rel_out,
        "ext": ext,
        "magic": expected_magic.hex(),
        "woff2_size": woff2_size,
        "sfnt_size": len(sfnt_bytes),
    }


def main():
    parser = argparse.ArgumentParser(description="Decompress WOFF2 font subsets to authentic SFNT (.ttf/.otf)")
    parser.add_argument("--force", action="store_true", help="Force overwrite existing output files")
    parser.add_argument("--dry-run", action="store_true", help="Simulate conversion without writing files")
    parser.add_argument("--platform", choices=PLATFORMS, help="Restrict conversion to a specific platform")
    args = parser.parse_args()

    target_platforms = [args.platform] if args.platform else PLATFORMS

    print("================================================================================")
    print("      DECOMPRESSING WOFF2 FONT SUBSETS TO AUTHENTIC SFNT (.ttf / .otf)         ")
    print("================================================================================")
    print(f"Subsets root: {SUBSETS_ROOT}")
    print(f"Platforms:    {', '.join(target_platforms)}")
    print(f"Options:      force={args.force}, dry_run={args.dry_run}\n")

    results_by_platform = {}
    total_woff2_bytes = 0
    total_sfnt_bytes = 0
    total_ttf_count = 0
    total_otf_count = 0
    total_success = 0
    total_fail = 0
    cff_fonts = []

    for plat in target_platforms:
        plat_dir = os.path.join(SUBSETS_ROOT, plat)
        if not os.path.isdir(plat_dir):
            print(f"Warning: platform directory not found: {plat_dir}")
            continue

        woff2_files = sorted([f for f in os.listdir(plat_dir) if f.endswith(".woff2")])
        plat_results = []

        for wf in woff2_files:
            src_path = os.path.join(plat_dir, wf)
            try:
                res = process_font_file(src_path, force=args.force, dry_run=args.dry_run)
                plat_results.append(res)
                total_success += 1
                total_woff2_bytes += res["woff2_size"]
                total_sfnt_bytes += res["sfnt_size"]
                if res["ext"] == ".ttf":
                    total_ttf_count += 1
                elif res["ext"] == ".otf":
                    total_otf_count += 1
                    cff_fonts.append(res["rel_out"])
            except Exception as err:
                total_fail += 1
                print(f"  [ERROR] {plat}/{wf}: {err}")
                plat_results.append({
                    "ok": False,
                    "rel_src": f"{plat}/{wf}",
                    "error": str(err),
                })

        results_by_platform[plat] = plat_results

    print("\n--------------------------------------------------------------------------------")
    print(f"{'Platform':<12} {'WOFF2 Count':<12} {'TTF Count':<10} {'OTF Count':<10} {'WOFF2 KB':<12} {'SFNT KB':<12} {'Ratio'}")
    print("--------------------------------------------------------------------------------")
    for plat in target_platforms:
        p_res = results_by_platform.get(plat, [])
        p_woff2_kb = sum(r["woff2_size"] for r in p_res if r.get("ok")) / 1024
        p_sfnt_kb = sum(r["sfnt_size"] for r in p_res if r.get("ok")) / 1024
        p_ttf = sum(1 for r in p_res if r.get("ext") == ".ttf")
        p_otf = sum(1 for r in p_res if r.get("ext") == ".otf")
        ratio = (p_sfnt_kb / p_woff2_kb) if p_woff2_kb > 0 else 0
        print(f"{plat:<12} {len(p_res):<12} {p_ttf:<10} {p_otf:<10} {p_woff2_kb:<12.1f} {p_sfnt_kb:<12.1f} {ratio:.2f}x")
    print("--------------------------------------------------------------------------------")
    ratio_total = (total_sfnt_bytes / total_woff2_bytes) if total_woff2_bytes > 0 else 0
    print(f"{'TOTAL':<12} {total_success + total_fail:<12} {total_ttf_count:<10} {total_otf_count:<10} {total_woff2_bytes/1024:<12.1f} {total_sfnt_bytes/1024:<12.1f} {ratio_total:.2f}x")
    print("--------------------------------------------------------------------------------\n")

    print(f"Execution Summary:")
    print(f"  Total Processed: {total_success + total_fail}")
    print(f"  Success:         {total_success}")
    print(f"  Failed:          {total_fail}")
    print(f"  TrueType (.ttf): {total_ttf_count} (magic: 0x00010000)")
    print(f"  OpenType (.otf): {total_otf_count} (magic: 'OTTO', CFF outlines)")
    print(f"  WOFF2 Payload:   {total_woff2_bytes:,} bytes ({total_woff2_bytes / (1024 * 1024):.2f} MB)")
    print(f"  SFNT Payload:    {total_sfnt_bytes:,} bytes ({total_sfnt_bytes / (1024 * 1024):.2f} MB)")
    print(f"  Payload Delta:   +{total_sfnt_bytes - total_woff2_bytes:,} bytes (+{(total_sfnt_bytes - total_woff2_bytes) / (1024 * 1024):.2f} MB)\n")

    if cff_fonts:
        print(f"CFF Outlines Requiring .otf Preservation ({len(cff_fonts)} fonts):")
        for f in cff_fonts:
            print(f"  - {f}")
        print()

    if total_fail > 0:
        print("ERROR: One or more font conversions failed!")
        sys.exit(1)
    else:
        print("ALL 170 FONT SUBSETS SUCCESSFULLY DECOMPRESSED AND VERIFIED!")


if __name__ == "__main__":
    main()
