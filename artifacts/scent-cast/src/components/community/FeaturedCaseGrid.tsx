import React from 'react';
import { motion } from 'framer-motion';
import type { Variants } from 'framer-motion';
import { CommunityFragranceOverlay } from '@/components/community/CommunityFragranceOverlay';
import { CommunityFragranceCard } from '@/components/community/CommunityFragranceCard';
import type { CommunityFragranceEntry } from '@/components/community/communityData';

interface FeaturedCaseGridProps {
  items: CommunityFragranceEntry[];
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
}

const gridVariants: Variants = {
  initial: {},
  animate: {
    transition: {
      staggerChildren: 0.04,
    },
  },
};

const cardVariants: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.42, ease: [0.22, 1, 0.36, 1] },
  },
};

export const FeaturedCaseGrid: React.FC<FeaturedCaseGridProps> = ({
  items,
  loading,
  error = null,
  onRetry,
}) => {
  const showSkeletons = loading;
  const [activeItem, setActiveItem] = React.useState<CommunityFragranceEntry | null>(null);
  const triggerRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const activeTriggerIdRef = React.useRef<string | null>(null);

  const openItem = React.useCallback((entry: CommunityFragranceEntry) => {
    activeTriggerIdRef.current = entry.id;
    setActiveItem(entry);
  }, []);

  const closeOverlay = React.useCallback(() => {
    setActiveItem(null);
  }, []);

  const restoreTriggerFocus = React.useCallback(() => {
    const triggerId = activeTriggerIdRef.current;
    if (triggerId) {
      triggerRefs.current.get(triggerId)?.focus();
    }
    activeTriggerIdRef.current = null;
  }, []);

  if (error) {
    return (
      <section aria-label="Community status" className="py-24 px-4 text-center border border-white/10 bg-white/[0.02] rounded-scent flex flex-col items-center justify-center gap-6">
        <div className="space-y-2">
          <p className="font-serif italic text-3xl text-white/90">Community Intelligence Offline</p>
          <p className="text-sm text-scent-muted max-w-md mx-auto">{error}</p>
        </div>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="scent-primary-button px-8 py-3 rounded-scent font-serif italic text-lg"
          >
            Retry
          </button>
        )}
      </section>
    );
  }

  if (!loading && !error && items.length === 0) {
    return (
      <section aria-label="Community status" className="py-32 px-4 text-center border border-dashed border-white/5 rounded-scent">
        <p className="font-serif italic text-3xl text-white/20">
          No shared vaults are currently active. Be the first to enshrine yours.
        </p>
      </section>
    );
  }

  return (
    <>
      <section aria-label="Featured community wardrobes">
        <motion.div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 sm:gap-8"
          variants={gridVariants}
          initial="initial"
          animate="animate"
        >
          {showSkeletons
            ? [...Array(8)].map((_, index) => (
                <div key={`skeleton-${index}`} className="scent-fragrance-card animate-pulse relative aspect-[3/4.6] p-5 sm:p-6">
                  <div className="scent-card-frame" aria-hidden="true" />
                  <div className="relative z-10 flex h-full flex-col">
                    <div className="flex justify-end">
                      <div className="h-3 w-24 bg-white/10" />
                    </div>
                    <div className="my-3 min-h-0 flex-1 rounded-sm border border-dashed border-white/10 bg-white/[0.03]" />
                    <div className="mx-auto mt-2 h-7 w-36 bg-white/10" />
                    <div className="mx-auto mt-2 h-4 w-44 bg-white/10" />
                    <div className="mx-auto mt-2 h-3 w-28 bg-white/10" />
                  </div>
                </div>
              ))
            : items.map((entry) => (
                <motion.div key={entry.id} variants={cardVariants}>
                  <CommunityFragranceCard
                    item={entry}
                    onOpen={openItem}
                    ref={(node) => {
                      if (node) {
                        triggerRefs.current.set(entry.id, node);
                      } else {
                        triggerRefs.current.delete(entry.id);
                      }
                    }}
                  />
                </motion.div>
              ))}
        </motion.div>
      </section>
      <CommunityFragranceOverlay item={activeItem} onClose={closeOverlay} restoreFocus={restoreTriggerFocus} />
    </>
  );
};
