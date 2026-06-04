import { useEffect, useState } from "react";
import {
  isIpadStandalone,
  isLowRenderBudget,
  prefersReducedMotion,
} from "@/lib/platform";

export interface RenderBudget {
  /**
   * The session is a constrained surface (installed iPad PWA or reduced-motion):
   * drop per-frame backgrounds, route-transition animation, and duplicated
   * image surfaces.
   */
  lowMotionRenderMode: boolean;
  /** Specifically an installed iPad PWA. */
  isIpadStandalone: boolean;
  /** OS-level reduced-motion preference. */
  reducedMotion: boolean;
}

function readBudget(): RenderBudget {
  return {
    lowMotionRenderMode: isLowRenderBudget(),
    isIpadStandalone: isIpadStandalone(),
    reducedMotion: prefersReducedMotion(),
  };
}

/**
 * Reactively expose the render budget for the current session. The values are
 * computed once on mount (device class is stable) and re-evaluated when the
 * reduced-motion preference or display-mode changes so the app responds without
 * a reload.
 */
export function useRenderBudget(): RenderBudget {
  const [budget, setBudget] = useState<RenderBudget>(readBudget);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const queries = [
      window.matchMedia("(prefers-reduced-motion: reduce)"),
      window.matchMedia("(display-mode: standalone)"),
    ];
    const update = () => setBudget(readBudget());
    update();

    for (const query of queries) {
      if (typeof query.addEventListener === "function") {
        query.addEventListener("change", update);
      } else {
        query.addListener(update);
      }
    }

    return () => {
      for (const query of queries) {
        if (typeof query.removeEventListener === "function") {
          query.removeEventListener("change", update);
        } else {
          query.removeListener(update);
        }
      }
    };
  }, []);

  return budget;
}
