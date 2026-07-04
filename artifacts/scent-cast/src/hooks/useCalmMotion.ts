import { useReducedMotion } from "framer-motion";
import { useRenderBudget } from "@/hooks/useRenderBudget";

/**
 * Canonical "calm motion" gate for JS-driven animation.
 *
 * True when expensive motion (layout/FLIP animations, height collapses,
 * per-frame main-thread tweens) should be replaced with a plain crossfade:
 * OS reduce-motion, phone-class constrained touch devices, or iPad
 * Safari/standalone-PWA WebKit performance mode.
 *
 * This is the same formula App.tsx uses for `calmLayout` and ReviewsPanel used
 * for `reduced`, centralized so new components cannot forget a tier. Values are
 * reactive (via useRenderBudget), so the gate follows reduced-motion and
 * display-mode changes without a reload.
 *
 * Components with deliberately different tiering (e.g. Wardrobe's
 * `constrainedDetailMode`, which excludes iPads) should keep their local
 * formulas — this hook is the default, not a mandate.
 */
export function useCalmMotion(): boolean {
  const reduceMotion = useReducedMotion();
  const { lowMotionRenderMode, ipadSafariPerformanceMode } = useRenderBudget();
  return (reduceMotion ?? false) || lowMotionRenderMode || ipadSafariPerformanceMode;
}
