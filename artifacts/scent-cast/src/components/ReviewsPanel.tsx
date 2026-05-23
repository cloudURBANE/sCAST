import React, { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { RefreshCw } from "lucide-react";
import {
  summarizeReviews,
  getCachedReviewSummary,
  reviewSummaryCacheKey,
  type FragranceRawReview,
  type SummarizedComment,
} from "@/lib/fragranceApi";

interface ReviewsPanelProps {
  name?: string;
  brand?: string;
  reviews: FragranceRawReview[];
}

function getThemeBadge(theme: string) {
  switch (theme) {
    case "performance":
      return (
        <span className="text-[9px] font-semibold uppercase tracking-[0.34em] text-scent-accent/70">
          performance
        </span>
      );
    case "season":
      return (
        <span className="text-[9px] font-semibold uppercase tracking-[0.34em] text-scent-accent/70">
          season
        </span>
      );
    case "vibe":
      return (
        <span className="text-[9px] font-semibold uppercase tracking-[0.34em] text-scent-accent/70">
          vibe
        </span>
      );
    default:
      return null;
  }
}

const CARD_STAGGER = 0.08;
const CARD_DELAY_START = 0.05;

function QuoteCard({
  comment,
  index,
  reduced,
}: {
  comment: SummarizedComment;
  index: number;
  reduced: boolean | null;
}) {
  return (
    <motion.div
      key={comment.text}
      initial={reduced ? { opacity: 1 } : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, y: -10, scale: 0.98 }}
      transition={{
        duration: reduced ? 0 : 0.38,
        ease: [0.22, 1, 0.36, 1],
        delay: reduced ? 0 : CARD_DELAY_START + index * CARD_STAGGER,
      }}
      className="relative flex min-h-[13.5rem] flex-col items-center justify-center overflow-hidden rounded-lg border border-white/[0.055] bg-[linear-gradient(180deg,#090705_0%,#050403_58%,#030202_100%)] px-6 py-8 text-center shadow-[inset_0_1px_0_rgba(255,236,200,0.035),0_18px_36px_-30px_rgba(0,0,0,0.98)] sm:px-7"
    >
      <p
        className="relative z-10 mx-auto max-w-[26rem] font-serif text-[20px] italic leading-[1.62] text-white/90 sm:text-[23px]"
        style={{ fontFamily: "var(--font-serif)" }}
      >
        "{comment.text}"
      </p>

      <span
        className="relative z-10 mt-5 h-px w-14 bg-gradient-to-r from-transparent via-scent-accent/55 to-transparent"
        aria-hidden
      />

      <div className="relative z-10 mt-4 flex items-center justify-center">
        {getThemeBadge(comment.theme)}
      </div>
    </motion.div>
  );
}

export function ReviewsPanel({ name, brand, reviews }: ReviewsPanelProps) {
  const cacheKey = useMemo(
    () => reviewSummaryCacheKey(name, brand, reviews),
    [name, brand, reviews]
  );
  const initialCached = useMemo(
    () => getCachedReviewSummary(cacheKey),
    [cacheKey]
  );

  const [comments, setComments] = useState<SummarizedComment[]>(() => initialCached ?? []);
  const [loading, setLoading] = useState(() => reviews.length > 0 && !initialCached?.length);
  const [isMobile, setIsMobile] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const reviewsKey = useMemo(
    () => reviews.map((r) => r.text).join("|").slice(0, 6000),
    [reviews]
  );

  useEffect(() => {
    if (reviews.length === 0) {
      setComments([]);
      setLoading(false);
      return;
    }
    const cached = getCachedReviewSummary(cacheKey);
    if (cached?.length) {
      setComments(cached);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setComments([]);
    summarizeReviews({ name, brand, reviews }, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setComments(result);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reviewsKey, name, brand, cacheKey]);

  if (reviews.length === 0) return null;
  if (!loading && comments.length === 0) return null;

  // Loading skeleton
  if (loading) {
    return (
      <section className="border border-white/[0.04] bg-gradient-to-b from-white/[0.018] to-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.025),inset_0_0_60px_rgba(201,139,44,0.018)]">
        <ReviewsHeader />
        <div className="flex h-[16rem] flex-col items-center justify-center gap-6 px-6 py-8 animate-pulse">
          <div className="flex items-center gap-2">
            <RefreshCw size={13} className="animate-spin text-white/40" />
            <p className="text-[11px] uppercase tracking-[0.22em] text-white/40 font-bold">
              Distilling reviews…
            </p>
          </div>
          <div className="h-3 w-3/4 max-w-md rounded bg-white/[0.04]" />
          <div className="h-3 w-1/2 max-w-sm rounded bg-white/[0.04]" />
          <div className="h-3 w-2/3 max-w-md rounded bg-white/[0.04]" />
        </div>
      </section>
    );
  }

  const maxInitial = isMobile ? 2 : 3;
  const displayedComments = expanded ? comments : comments.slice(0, maxInitial);
  const hasMore = comments.length > maxInitial;
  const cols = Math.min(3, comments.length);

  const gridClass =
    cols === 1
      ? "grid-cols-1 max-w-xl mx-auto"
      : cols === 2
        ? "grid-cols-1 md:grid-cols-2"
        : "grid-cols-1 md:grid-cols-3";

  return (
    <section className="border border-white/[0.04] bg-gradient-to-b from-white/[0.018] to-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.025),inset_0_0_60px_rgba(201,139,44,0.018)]">
      <ReviewsHeader />

      {/* Quote grid */}
      <motion.div layout="position" className={`grid gap-4 p-5 sm:p-6 ${gridClass}`}>
        <AnimatePresence initial={false}>
          {displayedComments.map((comment, index) => (
            <QuoteCard
              key={comment.text}
              comment={comment}
              index={index}
              reduced={prefersReducedMotion}
            />
          ))}
        </AnimatePresence>
      </motion.div>

      {/* Footer */}
      {hasMore && (
        <div className="border-t border-white/[0.05] px-5 py-2.5 flex items-center justify-end text-[10px] text-white/35">
          <button
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center gap-1.5 rounded border border-white/12 bg-white/[0.03] px-3 py-1.5 text-[9px] uppercase tracking-[0.22em] font-bold text-white/55 transition-all duration-200 hover:border-scent-accent/30 hover:bg-scent-accent/[0.07] hover:text-scent-accent/80"
          >
            {expanded ? "Show Less" : `Show All (${comments.length})`}
          </button>
        </div>
      )}
    </section>
  );
}

function ReviewsHeader() {
  return (
    <div className="border-b border-white/[0.05] px-6 py-4">
      <div className="flex items-center gap-4">
        <div className="h-px flex-1 bg-gradient-to-r from-transparent to-white/[0.18]" />
        <div className="text-center">
          <p className="text-[10px] uppercase tracking-[0.34em] text-white/70 font-bold">
            Reviews
          </p>
        </div>
        <div className="h-px flex-1 bg-gradient-to-l from-transparent to-white/[0.18]" />
      </div>
    </div>
  );
}
