// Soft, no-overshoot spring shared by both ends of the card→overlay
// bottle-image transition. Declared once so open and return feel identical.
export const COMMUNITY_IMAGE_LAYOUT_TRANSITION = {
  layout: { type: 'spring', stiffness: 260, damping: 30, mass: 0.9 },
} as const;

// Low-render budget (phone / iPad WebKit): a cheap transform-only tween instead
// of the spring. Duration is tuned against the overlay's fades (see
// CommunityFragranceOverlay): it must OUTLAST the 0.24s open fade so the morph
// is still travelling once the overlay is opaque (at 0.3s it settled under the
// fade and read as "it just appeared" on iOS), but it must also fit INSIDE the
// 0.5s exit fade so the bottle finishes landing on the card before the overlay
// disappears — otherwise the morph is cut off mid-flight on close and the
// card's own bottle pops in (the glitchy close). 0.45s satisfies both while
// staying a single transform animation inside WebKit's compositor budget.
export const COMMUNITY_IMAGE_LAYOUT_TRANSITION_LOW_RENDER = {
  layout: { type: 'tween', duration: 0.45, ease: [0.22, 1, 0.36, 1] },
} as const;
