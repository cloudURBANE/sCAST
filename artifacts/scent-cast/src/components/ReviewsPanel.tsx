import React, { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
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

const REVIEW_EASE = [0.22, 1, 0.36, 1] as const;

function formatReviewPosition(index: number, total: number) {
  const width = Math.max(2, String(total).length);
  return `${String(index + 1).padStart(width, "0")} / ${String(total).padStart(width, "0")}`;
}

function ReviewsShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="relative mx-auto mt-4 flex w-full max-w-[700px] flex-col items-center overflow-hidden border border-white/[0.06] bg-[linear-gradient(180deg,rgba(10,8,6,0.76)_0%,rgba(5,4,3,0.92)_62%,rgba(3,2,2,0.98)_100%)] px-4 py-5 text-center shadow-[inset_0_1px_0_rgba(255,236,200,0.04),0_18px_48px_-42px_rgba(0,0,0,0.98)] sm:px-6 sm:py-6">
      <span
        className="pointer-events-none absolute inset-x-12 top-0 h-px bg-gradient-to-r from-transparent via-scent-accent/24 to-transparent"
        aria-hidden
      />
      {children}
    </section>
  );
}

function ReviewsHeader() {
  return (
    <div className="mb-4 w-full max-w-[500px]">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
        <div className="h-px bg-gradient-to-r from-transparent to-white/[0.16]" />
        <div className="text-center">
          <p className="text-[10px] uppercase tracking-[0.34em] text-white/70 font-bold">
            Reviews
          </p>
        </div>
        <div className="h-px bg-gradient-to-l from-transparent to-white/[0.16]" />
      </div>
    </div>
  );
}

function FeaturedQuote({
  comment,
  reduced,
}: {
  comment: SummarizedComment;
  reduced: boolean;
}) {
  return (
    <motion.figure
      key={comment.text}
      initial={reduced ? { opacity: 1 } : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, y: -10 }}
      transition={{
        duration: reduced ? 0 : 0.38,
        ease: REVIEW_EASE,
      }}
      className="mx-auto flex w-full max-w-[520px] flex-col items-center text-center"
    >
      <blockquote
        className="mx-auto max-w-[31rem] text-center font-serif text-[20px] italic leading-[1.52] tracking-normal text-[#f5f0e6]/[0.88] sm:text-[21px]"
        style={{ fontFamily: "var(--font-serif)" }}
      >
        &ldquo;{comment.text}&rdquo;
      </blockquote>

      <span
        className="mx-auto mt-4 block h-px w-14 bg-gradient-to-r from-transparent via-scent-accent/50 to-transparent"
        aria-hidden
      />
      <figcaption className="mt-3 text-[9px] font-semibold uppercase tracking-[0.3em] text-[#b47a34]">
        Featured Impression
      </figcaption>
    </motion.figure>
  );
}

export function ReviewsPanel({ name, brand, reviews }: ReviewsPanelProps) {
  const cacheKey = useMemo(
    () => reviewSummaryCacheKey(name, brand, reviews),
    [name, brand, reviews],
  );
  const initialCached = useMemo(
    () => getCachedReviewSummary(cacheKey),
    [cacheKey],
  );

  const [comments, setComments] = useState<SummarizedComment[]>(() => initialCached ?? []);
  const [loading, setLoading] = useState(() => reviews.length > 0 && !initialCached?.length);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);

  const prefersReducedMotion = useReducedMotion();
  const reduced = prefersReducedMotion ?? false;

  const reviewsKey = useMemo(
    () => reviews.map((r) => r.text).join("|").slice(0, 6000),
    [reviews],
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

  useEffect(() => {
    setCurrentIndex(0);
    setExpanded(false);
  }, [cacheKey]);

  useEffect(() => {
    setCurrentIndex((index) => (
      comments.length === 0 ? 0 : Math.min(index, comments.length - 1)
    ));
  }, [comments.length]);

  if (reviews.length === 0) return null;
  if (!loading && comments.length === 0) return null;

  if (loading) {
    return (
      <ReviewsShell>
        <ReviewsHeader />
        <div className="flex w-full max-w-[500px] flex-col items-center justify-center gap-4 px-2 py-4 animate-pulse">
          <div className="flex items-center gap-2">
            <RefreshCw size={13} className="animate-spin text-white/40" />
            <p className="text-[11px] uppercase tracking-[0.22em] text-white/40 font-bold">
              Distilling reviews...
            </p>
          </div>
          <div className="h-3 w-3/4 max-w-md rounded bg-white/[0.04]" />
          <div className="h-3 w-1/2 max-w-sm rounded bg-white/[0.04]" />
          <div className="h-3 w-2/3 max-w-md rounded bg-white/[0.04]" />
        </div>
      </ReviewsShell>
    );
  }

  const currentComment = comments[currentIndex] ?? comments[0];
  const hasMultiple = comments.length > 1;
  const positionLabel = formatReviewPosition(currentIndex, comments.length);
  const selectReview = (index: number) => {
    setCurrentIndex(index);
    setExpanded(false);
  };
  const stepReview = (delta: number) => {
    if (!comments.length) return;
    setCurrentIndex((index) => (index + delta + comments.length) % comments.length);
  };

  return (
    <ReviewsShell>
      <ReviewsHeader />

      <div className="flex w-full flex-col items-center">
        <div className="grid min-h-[8rem] w-full place-items-center" aria-live="polite">
          <AnimatePresence mode="wait" initial={false}>
            <FeaturedQuote
              key={`${currentIndex}-${currentComment.text}`}
              comment={currentComment}
              reduced={reduced}
            />
          </AnimatePresence>
        </div>

        <div className="mt-4 flex flex-col items-center gap-2.5">
          <div className="grid grid-cols-[1.75rem_5.5rem_1.75rem] items-center justify-center gap-2.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-[#f5f0e6]/[0.5]">
            <button
              type="button"
              onClick={() => stepReview(-1)}
              disabled={!hasMultiple}
              className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-white/[0.02] text-white/45 transition-colors hover:border-scent-accent/35 hover:text-scent-accent disabled:cursor-default disabled:opacity-25 disabled:hover:border-white/10 disabled:hover:text-white/45"
              aria-label="Previous review"
              title="Previous review"
            >
              <ChevronLeft size={14} strokeWidth={1.8} />
            </button>
            <span className="text-center tabular-nums">{positionLabel}</span>
            <button
              type="button"
              onClick={() => stepReview(1)}
              disabled={!hasMultiple}
              className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-white/[0.02] text-white/45 transition-colors hover:border-scent-accent/35 hover:text-scent-accent disabled:cursor-default disabled:opacity-25 disabled:hover:border-white/10 disabled:hover:text-white/45"
              aria-label="Next review"
              title="Next review"
            >
              <ChevronRight size={14} strokeWidth={1.8} />
            </button>
          </div>

          {hasMultiple ? (
            <button
              type="button"
              onClick={() => setExpanded((open) => !open)}
              className="border-b border-white/15 px-1 pb-1 text-[9px] font-bold uppercase tracking-[0.26em] text-white/48 transition-colors hover:border-scent-accent/55 hover:text-scent-accent"
              aria-expanded={expanded}
            >
              {expanded ? "Close List" : "View All"}
            </button>
          ) : null}
        </div>

        <AnimatePresence initial={false}>
          {expanded ? (
            <motion.ol
              key="review-ledger"
              initial={reduced ? { opacity: 1 } : { opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8 }}
              transition={{ duration: reduced ? 0 : 0.28, ease: REVIEW_EASE }}
              className="mt-5 w-full max-w-[520px] border-t border-white/[0.055]"
            >
              {comments.map((comment, index) => (
                <li key={`${comment.text}-${index}`} className="border-b border-white/[0.045]">
                  <button
                    type="button"
                    onClick={() => selectReview(index)}
                    className="group flex w-full flex-col items-center gap-2.5 px-1 py-4 text-center transition-colors hover:bg-white/[0.018]"
                    aria-current={index === currentIndex ? "true" : undefined}
                  >
                    <span
                      className={`text-[9px] font-semibold uppercase tracking-[0.28em] tabular-nums ${
                        index === currentIndex ? "text-scent-accent/80" : "text-white/28"
                      }`}
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span
                      className={`max-w-[34rem] font-serif text-[17px] italic leading-[1.6] transition-colors ${
                        index === currentIndex
                          ? "text-[#f5f0e6]/80"
                          : "text-white/52 group-hover:text-white/70"
                      }`}
                      style={{ fontFamily: "var(--font-serif)" }}
                    >
                      &ldquo;{comment.text}&rdquo;
                    </span>
                  </button>
                </li>
              ))}
            </motion.ol>
          ) : null}
        </AnimatePresence>
      </div>
    </ReviewsShell>
  );
}
