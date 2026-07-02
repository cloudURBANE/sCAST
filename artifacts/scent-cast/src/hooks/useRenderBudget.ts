import { useEffect, useState } from "react";
import {
  isIpadDevice,
  isIpadSafariPerformanceMode,
  isIpadStandalone,
  isLowRenderBudget,
  isTouchPerformanceMode,
  prefersReducedMotion,
} from "@/lib/platform";

export interface RenderBudget {
  /**
   * The session is a constrained surface (phone-class touch device or
   * reduced-motion): drop per-frame backgrounds, use cheaper route-transition
   * motion, and avoid duplicated image surfaces. iPads are desktop-class and
   * stay out of this path unless the user enables reduced motion.
   */
  lowMotionRenderMode: boolean;
  /** Any iPadOS device (browser or installed PWA). */
  isIpad: boolean;
  /** Specifically an installed iPad PWA. */
  isIpadStandalone: boolean;
  /** iPad Safari/WebKit-specific compositor pressure guard. */
  ipadSafariPerformanceMode: boolean;
  /** Touch browsers that should receive compositor-relief CSS. */
  touchPerformanceMode: boolean;
  /** OS-level reduced-motion preference. */
  reducedMotion: boolean;
}

function readBudget(): RenderBudget {
  return {
    lowMotionRenderMode: isLowRenderBudget(),
    isIpad: isIpadDevice(),
    isIpadStandalone: isIpadStandalone(),
    ipadSafariPerformanceMode: isIpadSafariPerformanceMode(),
    touchPerformanceMode: isTouchPerformanceMode(),
    reducedMotion: prefersReducedMotion(),
  };
}

function sameBudget(a: RenderBudget, b: RenderBudget): boolean {
  return (
    a.lowMotionRenderMode === b.lowMotionRenderMode &&
    a.isIpad === b.isIpad &&
    a.isIpadStandalone === b.isIpadStandalone &&
    a.ipadSafariPerformanceMode === b.ipadSafariPerformanceMode &&
    a.touchPerformanceMode === b.touchPerformanceMode &&
    a.reducedMotion === b.reducedMotion
  );
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
      window.matchMedia("(pointer: coarse)"),
    ];
    const update = () => {
      const nextBudget = readBudget();
      setBudget((current) => (sameBudget(current, nextBudget) ? current : nextBudget));
    };
    update();

    // `resize` fires repeatedly during iOS address-bar show/hide and window
    // drags. Only the viewport-size-dependent budget input (the 920px
    // shortest-side threshold) can change here, so coalesce bursts into a single
    // trailing rAF probe instead of running readBudget()'s platform probes on
    // every event. matchMedia `change` events are rare and stay immediate.
    let rafId: number | null = null;
    const scheduleUpdate = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        update();
      });
    };

    for (const query of queries) {
      if (typeof query.addEventListener === "function") {
        query.addEventListener("change", update);
      } else {
        query.addListener(update);
      }
    }
    window.addEventListener("resize", scheduleUpdate, { passive: true });

    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", scheduleUpdate);
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
