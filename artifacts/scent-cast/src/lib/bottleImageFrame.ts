import { type ClassValue } from "clsx";
import { cn } from "./utils";

export type BottleImageVariant = "featured" | "grid" | "detail" | "thumb" | "share";

/**
 * Bottle display sizing is entirely client-side CSS. `POST /api/wardrobe/rebuild`
 * rehydrates catalog/profile **data** (name, brand, image URL); it does not resize
 * bitmaps or change how images render in the UI.
 *
 * ## Resize-up behavior (how bottles get “as big as possible”)
 *
 * 1. **Outer slot** — Parent gives real pixels (`aspect-[3/4]`, fixed thumb box, etc.).
 *    Callers pass sizing via `className` on `<BottleImage />` (e.g. `absolute inset-0`).
 *
 * 2. **Artboard** (`bottleArtboardClass`) — A symmetric inset from the slot (same `%`
 *    for featured/grid/share so every card uses an identical inner rectangle). That
 *    rectangle is the maximum drawable area for artwork.
 *
 * 3. **Bitmap scaling** (`bottleImageFillClass`) — The `<img>` is `h-full w-full` so
 *    it claims the full artboard. `object-contain` then **scales the image up or down**
 *    so the entire picture fits: small source images **grow** until they hit the
 *    artboard edge; large sources **shrink**. No artificial `max-h: 70%` cap — the
 *    only limit is the artboard itself, so “resize up” is the default for small assets.
 *
 * 4. **One shared axis (uniform alignment)** — After scaling, we use `object-bottom`
 *    (not `object-center`). Every bottle sits on the **same horizontal baseline** at the
 *    bottom of the artboard, centered left–right. That matches a retail “shelf” and
 *    stops mismatched crops from floating at random vertical positions. (`object-center`
 *    looked inconsistent across SKUs.)
 *
 * 5. **Odd aspect ratios (wide flat lays vs ultra-tall skins)** — `object-contain`
 *    always fits the full bitmap in the artboard; one dimension “hits first”. Tall
 *    narrow PNGs letterbox left/right; panoramic shots letterbox top (extra space sits
 *    above the bottle). **Bottom** pinning keeps every SKU anchored on the same shelf
 *    line so layouts don’t drift. Hover scale uses **`origin-bottom`** so magnification
 *    grows upward from that line instead of floating around the visual centroid (bad
 *    for squat vs skinny bottles).
 *
 * 6. **What this cannot fix** — If a vendor JPEG has huge empty margins *inside* the
 *    file, the bottle will still look small until that file is trimmed or replaced
 *    server-side. CSS only sees the full bitmap box.
 */

/** Uniform inset + clip so scaled/hover paints don’t bleed into card chrome. */
const ARTBOARD_INSET: Record<BottleImageVariant, string> = {
  featured:
    "absolute inset-[6%] sm:inset-[7%] flex items-center justify-center overflow-hidden min-h-0 min-w-0 rounded-[0.125rem]",
  grid:
    "absolute inset-[6%] sm:inset-[7%] flex items-center justify-center overflow-hidden min-h-0 min-w-0 rounded-[0.125rem]",
  share:
    "absolute inset-[6%] sm:inset-[7%] flex items-center justify-center overflow-hidden min-h-0 min-w-0 rounded-[0.125rem]",
  detail: "absolute inset-3 sm:inset-4 flex items-center justify-center overflow-hidden min-h-0 min-w-0 rounded-sm",
  /** Slightly looser than 0.5px so round / non-rectangular pack shots don’t hug the border. */
  thumb: "absolute inset-[6%] flex items-center justify-center overflow-hidden min-h-0 min-w-0 rounded-[0.125rem]",
};

/**
 * Positions the bottle **artboard**: the rectangle inside the slot where the bitmap is
 * scaled. Parent slot must be `position: relative` with non-zero size. Pair with
 * {@link bottleImageFillClass} on the `<img>` so `object-contain` can resize up/down.
 */
export function bottleArtboardClass(variant: BottleImageVariant, ...extra: ClassValue[]): string {
  return cn(ARTBOARD_INSET[variant], ...extra);
}

/**
 * Fill the artboard: `object-contain` + `object-bottom` for the shared shelf line;
 * `origin-bottom` keeps Framer/hover `scale-*` growth anchored for odd silhouettes;
 * `transform-gpu` helps subpixel edges on non-rectangular or high-contrast pack art.
 */
export function bottleImageFillClass(...extra: ClassValue[]): string {
  return cn(
    "block h-full w-full max-h-full max-w-full min-h-0 min-w-0 object-contain object-bottom origin-bottom transform-gpu select-none",
    ...extra,
  );
}

/** Hero card: flex region that grows inside `aspect-[3/4]`; nest `<BottleImage className="min-h-0 w-full flex-1" />` */
export function bottleFeaturedSlotClass(...extra: ClassValue[]): string {
  return cn(
    "relative z-10 flex min-h-0 w-full flex-1 flex-col items-center justify-center px-3 pt-12 pb-2",
    ...extra,
  );
}
