// Shared Framer Motion timing tokens.
//
// These mirror the CSS custom properties in index.css so JS-driven motion and
// CSS-driven motion stay on the same curves. Import these instead of re-typing
// bezier arrays in components — hand-copied arrays are how the curves drift.

/** Mirror of CSS `--scent-ease-out` (cubic-bezier(0.22, 1, 0.36, 1)). */
export const SCENT_EASE_OUT = [0.22, 1, 0.36, 1] as const;

/**
 * Long-tail expo-style ease used for entrances/slide-ins (matches the
 * cubic-bezier(0.16, 1, 0.3, 1) already used by the bottom-nav CSS transition).
 */
export const SCENT_EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;
