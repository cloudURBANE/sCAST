import React from 'react';
import { motion, type Transition } from 'framer-motion';
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
const TILE_TRANSITION: Transition = { duration: 0.28, ease: [0.16, 1, 0.3, 1] };

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
  onOpen,
  onPrefetch,
}: VaultGridTileProps) {
  const name = entryName(item);
  const handleClick = React.useCallback(() => onOpen(item), [onOpen, item]);
  const handleMouseEnter = React.useCallback(() => onPrefetch(item), [onPrefetch, item]);

  return (
    <motion.div
      initial={motionDisabled ? false : TILE_INITIAL}
      whileInView={motionDisabled ? undefined : TILE_WHILE_IN_VIEW}
      viewport={motionDisabled ? undefined : TILE_VIEWPORT}
      transition={motionDisabled ? undefined : TILE_TRANSITION}
      className="group cursor-pointer relative h-full min-w-0"
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
    >
      <VaultCard tone="wardrobe" compact={compact} brand={entryBrand(item)} name={name}>
        {/* Shared-bottle morph source: this fills the square image slot and
            carries the layoutId that the detail modal's bottle reuses, so
            tapping the card morphs the bottle open (and back on close) — the
            same effect as the Community feed. */}
        <motion.div
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
            imgClassName="scent-hover-scale brightness-[1.1] transition-transform duration-500 motion-reduce:transition-none"
            loading={prioritizeImage ? 'eager' : 'lazy'}
            fetchPriority={prioritizeImage ? 'high' : undefined}
          />
        </motion.div>
      </VaultCard>
    </motion.div>
  );
}

export const VaultGridTile = React.memo(VaultGridTileComponent);
