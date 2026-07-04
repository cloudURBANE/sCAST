import React, { useState, useEffect, useMemo } from "react";
import { m, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import {
  summarizeReviews,
  getCachedReviewSummary,
  reviewSummaryCacheKey,
  type FragranceRawReview,
  type SummarizedComment,
} from "@/lib/fragranceApi";
import { useCalmMotion } from "@/hooks/useCalmMotion";
import { SCENT_EASE_OUT as REVIEW_EASE } from "@/lib/motion";

interface ReviewsPanelProps {
  name?: string;
  brand?: string;
  reviews: FragranceRawReview[];
}

function formatReviewPosition(index: number, total: number) {
  const width = Math.max(2, String(total).length);
  return `${String(index + 1).padStart(width, "0")} / ${String(total).padStart(width, "0")}`;
}

function ReviewsShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="w-full overflow-hidden border border-white/[0.04] bg-gradient-to-b from-white/[0.018] to-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
      {children}
    </section>
  );
}

function ReviewsHeader() {
  return (
    <div className="border-b border-white/[0.05] px-4 py-3 text-center">
      <p className="text-[11px] uppercase tracking-[0.34em] text-white/70 font-bold">
        Reviews
      </p>
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
    <m.figure
      key={comment.text}
      initial={reduced ? { opacity: 1 } : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, y: -10 }}
      transition={{
        duration: reduced ? 0 : 0.38,
        ease: REVIEW_EASE,
      }}
      className="mx-auto flex w-full max-w-[62rem] flex-col items-center text-center"
    >
      <blockquote
        className="mx-auto max-w-[54rem] break-words text-center font-serif text-[20px] italic leading-[1.5] tracking-normal text-white/80 [overflow-wrap:anywhere] sm:text-[22px] lg:text-[24px]"
      >
        &ldquo;{comment.text}&rdquo;
      </blockquote>

      <span
        className="mx-auto mt-5 block h-px w-14 bg-gradient-to-r from-transparent via-scent-accent/38 to-transparent"
        aria-hidden
      />
      <figcaption className="mt-3 text-[9px] font-semibold uppercase tracking-[0.3em] text-white/36">
        Featured Impression
      </figcaption>
    </m.figure>
  );
}

function ReviewArrowButton({
  direction,
  disabled,
  onClick,
}: {
  direction: "previous" | "next";
  disabled: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
  const label = direction === "previous" ? "Previous review" : "Next review";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.025] text-white/42 transition-colors hover:border-scent-accent/32 hover:bg-scent-accent/[0.06] hover:text-scent-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/22 disabled:cursor-default disabled:opacity-25 disabled:hover:border-white/[0.08] disabled:hover:bg-white/[0.025] disabled:hover:text-white/42"
      aria-label={label}
      title={label}
    >
      <Icon size={15} strokeWidth={1.75} />
    </button>
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
  const [showControls, setShowControls] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // `reduced` switches the controls/summary reveals from height-auto layout
  // reflow tweens to an opacity-only fallback. useCalmMotion folds in the
  // render budget so phones and iPad Safari (where the height reflow stutters)
  // get the cheap path too.
  const reduced = useCalmMotion();

  const reviewsKey = useMemo(
    () => reviews.map((r) => r.text).join("|").slice(0, 6000),
    [reviews],
  );

  useEffect(() => {
    if (reviews.length === 0) {
      setComments([]);
      setLoading(false);
      setFetchError(null);
      return;
    }
    const cached = getCachedReviewSummary(cacheKey);
    if (cached?.length) {
      setComments(cached);
      setLoading(false);
      setFetchError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setFetchError(null);
    setComments([]);
    summarizeReviews({ name, brand, reviews }, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) {
          if (result && result.length > 0) {
            setComments(result);
          } else {
            setFetchError("Distillation produced no molecular impressions.");
          }
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          console.error("Failed to summarize reviews", err);
          setFetchError(err?.message || "Failed to load review distillation.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reviewsKey, name, brand, cacheKey, retryCount]);

  useEffect(() => {
    setCurrentIndex(0);
    setExpanded(false);
    setShowControls(false);
  }, [cacheKey]);

  useEffect(() => {
    setCurrentIndex((index) => (
      comments.length === 0 ? 0 : Math.min(index, comments.length - 1)
    ));
  }, [comments.length]);

  useEffect(() => {
    if (comments.length <= 1 || showControls || loading) {
      return;
    }

    const interval = setInterval(() => {
      setCurrentIndex((prevIndex) => (prevIndex + 1) % comments.length);
    }, 6000);

    return () => clearInterval(interval);
  }, [comments.length, showControls, loading]);

  if (reviews.length === 0) {
    return (
      <ReviewsShell>
        <ReviewsHeader />
        <div className="flex w-full flex-col items-center justify-center px-4 py-10 text-center sm:px-5">
          <p className="font-serif italic text-lg text-white/55">
            No reviews yet for this fragrance. Molecular impressions pending.
          </p>
        </div>
      </ReviewsShell>
    );
  }

  if (fetchError) {
    return (
      <ReviewsShell>
        <ReviewsHeader />
        <div className="flex w-full flex-col items-center justify-center gap-4 px-4 py-5 text-center sm:px-5">
          <div className="space-y-1">
            <p className="text-sm font-serif italic text-white/80">Impression Calibrator Failed</p>
            <p className="text-xs text-scent-muted max-w-md">{fetchError}</p>
          </div>
          <button
            type="button"
            onClick={() => setRetryCount((c) => c + 1)}
            className="flex h-8 items-center justify-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.025] px-4 text-[9px] font-bold uppercase tracking-[0.24em] text-white/44 transition-colors hover:border-scent-accent/32 hover:bg-scent-accent/[0.06] hover:text-scent-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/22"
          >
            <RefreshCw size={11} strokeWidth={1.75} className="text-inherit" />
            <span>Retry</span>
          </button>
        </div>
      </ReviewsShell>
    );
  }

  if (!loading && comments.length === 0) {
    return (
      <ReviewsShell>
        <ReviewsHeader />
        <div className="flex w-full flex-col items-center justify-center px-4 py-10 text-center sm:px-5">
          <p className="font-serif italic text-lg text-white/55">
            No reviews yet for this fragrance. Molecular impressions pending.
          </p>
        </div>
      </ReviewsShell>
    );
  }

  if (loading) {
    return (
      <ReviewsShell>
        <ReviewsHeader />
        <div className="flex w-full flex-col items-center justify-center gap-4 px-4 py-5 animate-pulse sm:px-5">
          <div className="flex items-center gap-2">
            <RefreshCw size={13} strokeWidth={1.75} className="animate-spin text-white/40" />
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

      <div
        className={`relative flex w-full flex-col items-center overflow-hidden px-4 py-5 sm:px-5 sm:py-5 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/22 ${
          !showControls && hasMultiple ? "cursor-pointer hover:bg-white/[0.01]" : ""
        }`}
        onClick={() => {
          if (!showControls && hasMultiple) {
            setShowControls(true);
          }
        }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !showControls && hasMultiple) {
            e.preventDefault();
            setShowControls(true);
          }
        }}
        tabIndex={!showControls && hasMultiple ? 0 : undefined}
        role={!showControls && hasMultiple ? "button" : undefined}
        aria-label={!showControls && hasMultiple ? "Interact to view all reviews and controls" : undefined}
      >
        <div className="grid min-h-[8.5rem] w-full place-items-center sm:min-h-[9rem]" aria-live="polite">
          <AnimatePresence mode="wait" initial={false}>
            <FeaturedQuote
              key={`${currentIndex}-${currentComment.text}`}
              comment={currentComment}
              reduced={reduced}
            />
          </AnimatePresence>
        </div>

        {hasMultiple && showControls ? (
          <m.div
            key="reviews-controls"
            initial={reduced ? { opacity: 1 } : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: reduced ? 0 : 0.25, ease: REVIEW_EASE }}
            className="mt-5 flex w-full flex-col items-center gap-3 overflow-hidden"
          >
            <div className="grid grid-cols-[2rem_5.75rem_2rem] items-center justify-center gap-3 text-[10px] font-semibold uppercase tracking-[0.24em] text-scent-muted/60">
              <ReviewArrowButton
                direction="previous"
                onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                  e.stopPropagation();
                  stepReview(-1);
                }}
                disabled={false}
              />
              <span className="text-center tabular-nums">{positionLabel}</span>
              <ReviewArrowButton
                direction="next"
                onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                  e.stopPropagation();
                  stepReview(1);
                }}
                disabled={false}
              />
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                  e.stopPropagation();
                  setExpanded((open) => !open);
                }}
                className="rounded-full border border-white/[0.08] bg-white/[0.025] px-4 py-2 text-[9px] font-bold uppercase tracking-[0.24em] text-white/44 transition-colors hover:border-scent-accent/32 hover:bg-scent-accent/[0.06] hover:text-scent-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/22"
                aria-expanded={expanded}
              >
                {expanded ? "Close List" : "View All"}
              </button>
              <button
                type="button"
                onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                  e.stopPropagation();
                  setShowControls(false);
                  setExpanded(false);
                }}
                className="flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.025] px-4 py-2 text-[9px] font-bold uppercase tracking-[0.24em] text-white/44 transition-colors hover:border-scent-accent/32 hover:bg-scent-accent/[0.06] hover:text-scent-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/22"
              >
                <span>Collapse</span>
                <ChevronUp size={11} strokeWidth={1.75} className="opacity-70" />
              </button>
            </div>
          </m.div>
        ) : null}

        <AnimatePresence initial={false}>
          {expanded ? (
            <m.ol
              key="review-ledger"
              initial={reduced ? { opacity: 1 } : { opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8 }}
              transition={{ duration: reduced ? 0 : 0.28, ease: REVIEW_EASE }}
              className="mt-7 w-full border-t border-white/[0.055]"
            >
              {comments.map((comment, index) => (
                <li key={`${comment.text}-${index}`} className="border-b border-white/[0.045]">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      selectReview(index);
                    }}
                    className="group grid w-full grid-cols-[2.5rem_minmax(0,1fr)] items-start gap-3 px-1 py-4 text-left transition-colors hover:bg-white/[0.018] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/22 sm:grid-cols-[3.5rem_minmax(0,1fr)] sm:px-3 lg:px-10"
                    aria-current={index === currentIndex ? "true" : undefined}
                  >
                    <span
                      className={`pt-1 text-center text-[9px] font-semibold uppercase tracking-[0.28em] tabular-nums ${
                        index === currentIndex ? "text-scent-accent/80" : "text-white/28"
                      }`}
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span
                      className={`block min-w-0 max-w-[68rem] break-words font-serif text-[16px] italic leading-[1.58] transition-colors [overflow-wrap:anywhere] sm:text-[17px] ${
                        index === currentIndex
                          ? "text-white/80"
                          : "text-white/52 group-hover:text-white/70"
                      }`}
                    >
                      &ldquo;{comment.text}&rdquo;
                    </span>
                  </button>
                </li>
              ))}
            </m.ol>
          ) : null}
        </AnimatePresence>
      </div>
    </ReviewsShell>
  );
}
