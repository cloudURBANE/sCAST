// Soft, no-overshoot spring shared by both ends of the card→overlay
// bottle-image transition. Declared once so open and return feel identical.
export const COMMUNITY_IMAGE_LAYOUT_TRANSITION = {
  layout: { type: 'spring', stiffness: 260, damping: 30, mass: 0.9 },
} as const;
