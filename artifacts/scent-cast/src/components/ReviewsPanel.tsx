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
        <span className="inline-flex items-center text-[9px] uppercase tracking-[0.18em] font-semibold px-2.5 py-1 rounded-sm border border-amber-500/25 bg-amber-500/[0.06] text-amber-300/65">
          performance
        </span>
      );
    case "season":
      return (
        <span className="inline-flex items-center text-[9px] uppercase tracking-[0.18em] font-semibold px-2.5 py-1 rounded-sm border border-sky-500/25 bg-sky-500/[0.06] text-sky-300/65">
          season
        </span>
      );
    case "vibe":
      return (
        <span className="inline-flex items-center text-[9px] uppercase tracking-[0.18em] font-semibold px-2.5 py-1 rounded-sm border border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-300/65">
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
      className="relative flex flex-col justify-between gap-5 overflow-hidden rounded-lg border border-white/[0.065] bg-gradient-to-b from-white/[0.03] to-white/[0.01] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_4px_18px_rgba(0,0,0,0.45),inset_0_0_40px_rgba(201,139,44,0.015)]"
    >
      {/* Decorative background quotation mark */}
      <span
        className="pointer-events-none absolute -top-2 left-2 select-none font-serif leading-none text-scent-accent/[0.08]"
        style={{ fontSize: "7rem", fontFamily: "var(--font-serif)" }}
        aria-hidden
      >
        "
      </span>

      {/* Ambient corner glow */}
      <span className="pointer-events-none absolute inset-0 rounded-lg bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,rgba(201,139,44,0.04),transparent)]" aria-hidden />

      {/* Quote text */}
      <p className="relative z-10 pt-3 font-serif italic leading-[1.8] text-white/88"
        style={{ fontSize: "clamp(14px, 1.1vw, 16px)", fontFamily: "var(--font-serif)" }}>
        "{comment.text}"
      </p>

      {/* Footer row: theme badge */}
      <div className="relative z-10 flex items-center justify-end">
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
      <div className="border-t border-white/[0.05] px-5 py-2.5 flex items-center justify-between gap-4 text-[10px] text-white/35">
        <span>Summarized from community reviews</span>
        <div className="flex items-center gap-4">
          {hasMore && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="inline-flex items-center gap-1.5 rounded border border-white/12 bg-white/[0.03] px-3 py-1.5 text-[9px] uppercase tracking-[0.22em] font-bold text-white/55 transition-all duration-200 hover:border-scent-accent/30 hover:bg-scent-accent/[0.07] hover:text-scent-accent/80"
            >
              {expanded ? "Show Less" : `Show All (${comments.length})`}
            </button>
          )}
          {reviews.length > 0 && <span>Based on {reviews.length} reviews</span>}
        </div>
      </div>
    </section>
  );
}

function ReviewsHeader() {
  return (
    <div className="border-b border-white/[0.05] px-6 py-4">
      <div className="flex items-center gap-4">
        <div className="h-px flex-1 bg-gradient-to-r from-transparent to-white/[0.18]" />
        <div className="text-center">
          <p className="text-[9px] uppercase tracking-[0.38em] text-white/55 font-bold">
            Reviews
          </p>
          <p
            className="mt-0.5 text-[13px] italic text-scent-accent/50"
            style={{ fontFamily: "var(--font-script)" }}
          >
            what people say
          </p>
        </div>
        <div className="h-px flex-1 bg-gradient-to-l from-transparent to-white/[0.18]" />
      </div>
    </div>
  );
}
