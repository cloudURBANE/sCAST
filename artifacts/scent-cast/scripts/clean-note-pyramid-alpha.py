#!/usr/bin/env python3
"""Carve the residual enclosed black "moat" out of the note-pyramid artwork alpha.

Background
----------
The brushed-gold pyramid art (`public/note-pyramid-gold.png`, 1026x1197) was baked
on a solid black backdrop. Commit 73c592e keyed the backdrop with a tool that left
white edge halos and smeared the gold texture. Commit 6e1993b rebuilt the alpha from
the clean pre-removal source by flood-filling only the *connected* near-black
background, leaving RGB byte-for-byte identical to the good source.

That connected flood-fill cannot reach the thin band of pure background-black that is
*enclosed* between each tier's bright gold rim outline and its inner gold face (a
"moat"). ~16k pixels of baked black therefore remained fully opaque. They read as a
thin dark frame on the dark UI, but they are genuine baked background and surface as
black fragments on any lighter surface / drop-shadow / hover.

What this step does
-------------------
Removes ONLY the enclosed near-black + near-neutral pixels, with a soft ramp for
anti-aliasing. RGB is left untouched, so the gold texture is preserved exactly, and
alpha is only ever *reduced* and only inside the dark+neutral zone, so no gold pixel
can be damaged: measured dark-gold chroma is >=18 (5th pct) while the black moat
chroma is <=11 (mean 4.2) -- a clean, non-overlapping gap.

Deterministic: same input -> same output. Idempotent: re-running on a cleaned asset
is a no-op (the moat is already gone).

Usage:  python clean-note-pyramid-alpha.py [input.png] [output.png]
Default in/out is ../public/note-pyramid-gold.png (in place).
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

# Keying thresholds (see module docstring for the measured separation).
MX_BLACK = 8.0      # max-channel at/below which a low-chroma pixel is fully background
MX_KEEP = 20.0      # max-channel at/above which a pixel is kept regardless of chroma
CHROMA_BLACK = 4.0  # chroma at/below which a dark pixel is fully background
CHROMA_KEEP = 14.0  # chroma at/above which a pixel is kept (gold floor is ~18)


def clean(in_path: Path, out_path: Path) -> None:
    im = Image.open(in_path).convert("RGBA")
    a = np.array(im)
    rgb = a[:, :, :3].astype(np.float32)
    alpha = a[:, :, 3].astype(np.float32)

    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    chroma = mx - mn

    # keep_factor in [0,1]: 0 = pure background black, 1 = gold/structure to preserve.
    # A pixel is kept if it is bright enough OR chromatic enough; the max() of the two
    # normalized ramps gives a soft anti-aliased transition from black -> gold.
    bright_ramp = (mx - MX_BLACK) / (MX_KEEP - MX_BLACK)
    chroma_ramp = (chroma - CHROMA_BLACK) / (CHROMA_KEEP - CHROMA_BLACK)
    keep = np.clip(np.maximum(bright_ramp, chroma_ramp), 0.0, 1.0)

    # Only ever reduce alpha (never re-add), so prior feathering stays intact.
    new_alpha = np.minimum(alpha, keep * 255.0)

    out = a.copy()
    out[:, :, 3] = np.rint(new_alpha).astype(np.uint8)
    # RGB untouched -> texture preserved byte-for-byte.
    assert np.array_equal(out[:, :, :3], a[:, :, :3])
    Image.fromarray(out, "RGBA").save(out_path)


def main() -> None:
    here = Path(__file__).resolve().parent
    default = here.parent / "public" / "note-pyramid-gold.png"
    in_path = Path(sys.argv[1]) if len(sys.argv) > 1 else default
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else in_path
    clean(in_path, out_path)
    print(f"cleaned {in_path} -> {out_path}")


if __name__ == "__main__":
    main()
