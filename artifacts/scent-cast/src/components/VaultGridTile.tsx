import React from 'react';
import { m, type Transition } from 'framer-motion';
import { SCENT_EASE_OUT_EXPO } from '@/lib/motion';
import { VaultCard } from '@/components/VaultCard';
import { BottleImage } from '@/components/BottleImage';
import { betaVideoUrlForFragrance } from '@/lib/bottleVideoBeta';
import type { Fragrance } from '@/components/Wardrobe';

/**
 * One interactive card in the Wardrobe vault grid, extracted out of
 * {@link Wardrobe} and wrapped in {@link React.memo} so a single Wardrobe state
 * change (a search keystroke, a syncing flag, an unrelated modal toggle) no
 * longer re-renders every visible bottle. The tile re-renders only when its own
 * props change identity, so the parent must pass STABLE `onOpen` / `onPrefetch`
 * `useCallback` refs (it does) and the static Framer Motion descriptors below
 * are module constants — never reallocated per render.
 */

/** Static entrance-animation descriptors — hoisted so they aren't reallocated
 *  per card per render (each was an inline object literal at the call site). */
const TILE_INITIAL = { opacity: 0, y: 10 } as const;
const TILE_WHILE_IN_VIEW = { opacity: 1, y: 0 } as const;
const TILE_VIEWPORT = { once: true, margin: '0px 0px 15% 0px' } as const;
const TILE_TRANSITION: Transition = { duration: 0.28, ease: SCENT_EASE_OUT_EXPO };

/** Resolve the human-facing name/brand even if the row predates the flat shape. */
function entryName(item: { name?: string; product?: { name?: string } }): string {
  return item?.name || item?.product?.name || '';
}
function entryBrand(item: { brand?: string; product?: { brand?: string } }): string {
  return item?.brand || item?.product?.brand || '';
}

interface VaultGridTileProps {
  item: Fragrance;
  compact: boolean;
  /** Eager-load + high fetch priority for the first few above-the-fold tiles. */
  prioritizeImage: boolean;
  /** When true, the card mounts in its final position with no entrance motion. */
  motionDisabled: boolean;
  /** Shared layout transition for the bottle morph into the detail modal. */
  bottleMorphTransition: Transition;
  /** Optional per-item syncing predicate (stable ref from the parent). */
  isImageSyncing?: (item: Pick<Fragrance, 'id' | '_dbId'>) => boolean;
  /** Report a terminal bottle load against the exact row + source that rendered. */
  onImageLoad?: (item: Fragrance, imageUrl: string) => void;
  /** Report a terminal bottle failure against the exact row + source that rendered. */
  onImageError?: (item: Fragrance, imageUrl: string) => void;
  /** Stable handler — opens the detail modal for this item. */
  onOpen: (item: Fragrance) => void;
  /** Stable handler — prefetches reviews on hover for this item. */
  onPrefetch: (item: Fragrance) => void;
}

function VaultGridTileComponent({
  item,
  compact,
  prioritizeImage,
  motionDisabled,
  bottleMorphTransition,
  isImageSyncing,
  onImageLoad,
  onImageError,
  onOpen,
  onPrefetch,
}: VaultGridTileProps) {
  const name = entryName(item);
  const imageUrl = item.imageUrl?.trim() ?? '';
  const handleClick = React.useCallback(() => onOpen(item), [onOpen, item]);
  const handleMouseEnter = React.useCallback(() => onPrefetch(item), [onPrefetch, item]);
  const handleImageLoad = React.useCallback(() => {
    if (imageUrl) onImageLoad?.(item, imageUrl);
  }, [imageUrl, item, onImageLoad]);
  const handleImageError = React.useCallback(() => {
    if (imageUrl) onImageError?.(item, imageUrl);
  }, [imageUrl, item, onImageError]);
  const handleKeyDown = React.useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen(item);
    }
  }, [onOpen, item]);

  // On touch/perf devices the visible animation is the Framer `layoutId` morph,
  // which drives the OUTER wrapper's transform every frame. A `transition-transform`
  // (and the hover-only `scent-hover-scale`) on the INNER <img> makes WebKit
  // re-evaluate/repaint that child layer against the animating parent every frame —
  // a competing transform transition inside a layout-animated ancestor, the classic
  // iOS Safari morph-jitter source. Drop them here so only the morph animates; the
  // hover scale is inert on touch anyway. Desktop keeps the full hover treatment.
  const imgClassName = motionDisabled
    ? 'brightness-[1.1]'
    : 'scent-hover-scale brightness-[1.1] transition-transform duration-500 motion-reduce:transition-none';

  return (
    <m.div
      initial={motionDisabled ? false : TILE_INITIAL}
      whileInView={motionDisabled ? undefined : TILE_WHILE_IN_VIEW}
      viewport={motionDisabled ? undefined : TILE_VIEWPORT}
      transition={motionDisabled ? undefined : TILE_TRANSITION}
      className="group cursor-pointer relative h-full min-w-0 rounded-scent outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
      role="button"
      tabIndex={0}
      aria-label={entryBrand(item) ? `${name} by ${entryBrand(item)}` : name}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={handleMouseEnter}
      onFocus={handleMouseEnter}
    >
      <VaultCard tone="wardrobe" compact={compact} brand={entryBrand(item)} name={name}>
        {/* Shared-bottle morph source: this fills the square image slot and
            carries the layoutId that the detail modal's bottle reuses, so
            tapping the card morphs the bottle open (and back on close) — the
            same effect as the Community feed. */}
        <m.div
          layoutId={`wardrobe-bottle-${item.id}`}
          transition={bottleMorphTransition}
          className="absolute inset-0 z-10"
        >
          <BottleImage
            variant="grid"
            src={item.imageUrl}
            videoSrc={betaVideoUrlForFragrance(item)}
            alt={name}
            adjustment={item.imageAdjustment}
            imageProperties={item.imageProperties}
            isSyncing={isImageSyncing?.(item)}
            className="absolute inset-0"
            imgClassName={imgClassName}
            loading={prioritizeImage ? 'eager' : 'lazy'}
            fetchPriority={prioritizeImage ? 'high' : undefined}
            onLoad={onImageLoad ? handleImageLoad : undefined}
            onError={onImageError ? handleImageError : undefined}
          />
        </m.div>
      </VaultCard>
    </m.div>
  );
}

export const VaultGridTile = React.memo(VaultGridTileComponent);
