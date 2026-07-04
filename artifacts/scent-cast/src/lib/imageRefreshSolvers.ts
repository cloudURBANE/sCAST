/**
 * Labels for wardrobe clarify flow — IDs must match ImageSolverId on the API
 * (artifacts/api-server/src/services/imageSolvers.ts). Removed ids
 * (abstract_query, dark_edge_bleed) were end-to-end no-ops and were pruned
 * (image selection audit Tier 3 #11); the API treats them as a plain refresh
 * if a stale client still sends one.
 */
export type WardrobeImageSolverId =
  | 'low_contrast'
  | 'box_interference'
  | 'group_shot'
  | 'watermark'
  | 'transparent_glass'
  | 'tester_bottle'
  | 'hand_interference'
  | 'studio_reflection'
  | 'liquid_splash'
  | 'gift_set'
  | 'orientation'
  | 'refill_format'
  | 'text_overlay'
  | 'dupe_interference'
  | 'decant'
  | 'cropped_image'
  | 'niche_scraping'
  | 'manual_fallback';

export const WARDROBE_REFRESH_COUNT_STORAGE_KEY = 'scentcast_wardrobe_refresh_v1';

export const WARDROBE_CLARIFY_SOLVERS: { id: WardrobeImageSolverId; label: string }[] = [
  { id: 'low_contrast', label: 'Hard to see / white-on-white' },
  { id: 'box_interference', label: 'Box or packaging dominates' },
  { id: 'group_shot', label: 'Multiple bottles / lineup' },
  { id: 'watermark', label: 'Stock photo / watermark' },
  { id: 'transparent_glass', label: 'Glass erased after background removal' },
  { id: 'tester_bottle', label: 'Tester / missing cap' },
  { id: 'hand_interference', label: 'Hand holding bottle' },
  { id: 'studio_reflection', label: 'Strong reflections / mirror' },
  { id: 'liquid_splash', label: 'Splash / liquid props' },
  { id: 'gift_set', label: 'Gift set / bundle' },
  { id: 'orientation', label: 'Tilted or lying bottle' },
  { id: 'refill_format', label: 'Refill / travel / odd format' },
  { id: 'text_overlay', label: 'Promotional text / ad' },
  { id: 'dupe_interference', label: 'Clone / dupe listing' },
  { id: 'decant', label: 'Decant / sample vial' },
  { id: 'cropped_image', label: 'Too cropped / macro only' },
  { id: 'niche_scraping', label: 'Sparse catalog — restrict retailers' },
  { id: 'manual_fallback', label: 'Skip AI trim — use raw image' },
];
