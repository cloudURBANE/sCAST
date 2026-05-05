import { type ClassValue } from "clsx";
import { cn } from "./utils";

export type BottleImageVariant = "featured" | "grid" | "detail" | "thumb" | "share";

/**
 * Single source of truth for bottle artwork framing. Every variant maps the same idea:
 * cap height and width as a percentage of the **slot** (the centered flex region), so
 * different photos use the same bounding box before `object-contain` scales the bitmap.
 *
 * This is pure CSS (no decode, no layout thrash) — O(1) per frame. It dramatically
 * improves grid consistency. Photos that ship with huge transparent margins will still
 * look smaller until trimmed (server/canvas); that is a separate pipeline.
 */
const IMG_CAPS: Record<BottleImageVariant, string> = {
  featured: "max-h-[70%] max-w-[82%]",
  grid: "max-h-[76%] max-w-[86%]",
  detail: "max-h-[80%] max-w-[88%]",
  thumb: "max-h-[92%] max-w-[92%]",
  share: "max-h-[76%] max-w-[86%]",
};

const IMG_BASE =
  "block object-contain w-auto h-auto min-h-0 min-w-0 shrink-0";

/**
 * Apply to `<img>` (and compatible elements) for normalized bottle size inside a defined slot.
 */
export function bottleImageImgClass(variant: BottleImageVariant, ...extra: ClassValue[]): string {
  return cn(IMG_BASE, IMG_CAPS[variant], ...extra);
}

/** Hero card: flex region that grows inside `aspect-[3/4]` so %-max dimensions resolve. */
export function bottleFeaturedSlotClass(...extra: ClassValue[]): string {
  return cn(
    "relative z-10 flex flex-1 min-h-0 w-full items-center justify-center px-5 pt-12 pb-2",
    ...extra,
  );
}
