import React from 'react';
import { motion } from 'framer-motion';
import type { Variants } from 'framer-motion';
import { CommunityFragranceCard } from '@/components/community/CommunityFragranceCard';
import type { CommunityFragranceEntry } from '@/components/community/communityData';

interface FeaturedCaseGridProps {
  items: CommunityFragranceEntry[];
  loading: boolean;
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

export const FeaturedCaseGrid: React.FC<FeaturedCaseGridProps> = ({ items, loading }) => {
  const showSkeletons = loading || items.length === 0;

  return (
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
                  <div className="ml-auto h-3 w-24 bg-white/10" />
                  <div className="my-5 min-h-0 flex-1 rounded-sm border border-dashed border-white/10 bg-white/[0.03]" />
                  <div className="mx-auto h-7 w-36 bg-white/10" />
                  <div className="mx-auto mt-4 h-3 w-44 bg-white/10" />
                </div>
              </div>
            ))
          : items.map((entry) => (
              <motion.div key={entry.id} variants={cardVariants}>
                <CommunityFragranceCard item={entry} />
              </motion.div>
            ))}
      </motion.div>
    </section>
  );
};
