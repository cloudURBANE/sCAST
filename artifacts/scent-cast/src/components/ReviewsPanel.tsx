import React, { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Quote, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
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

function FragrancePanel({
  title,
  children,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`border border-white/10 bg-white/[0.025] shadow-[inset_0_1px_0_rgba(255,255,255,0.035),inset_0_0_12px_rgba(251,191,36,0.02)] ${className}`}>
      <div className="border-b border-white/[0.07] px-4 py-3 text-center flex flex-col items-center justify-center gap-1 relative">
        <p className="text-[10px] uppercase tracking-[0.34em] text-white/70 font-bold pl-3">
          {title}
        </p>
        <p className="text-[14px] text-scent-accent/60 font-serif italic select-none" style={{ fontFamily: "var(--font-script)" }}>
          what people say
        </p>
      </div>
      {children}
    </section>
  );
}

function getThemeBadge(theme: string) {
  switch (theme) {
    case "performance":
      return (
        <span className="text-[9px] uppercase tracking-[0.15em] font-medium px-2 py-0.5 rounded border border-amber-500/30 bg-amber-500/5 text-amber-300/80">
          performance
        </span>
      );
    case "season":
      return (
        <span className="text-[9px] uppercase tracking-[0.15em] font-medium px-2 py-0.5 rounded border border-sky-500/30 bg-sky-500/5 text-sky-300/80">
          season
        </span>
      );
    case "vibe":
      return (
        <span className="text-[9px] uppercase tracking-[0.15em] font-medium px-2 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/5 text-emerald-300/80">
          vibe
        </span>
      );
    default:
      return null;
  }
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
  const [mobileIndex, setMobileIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const prefersReducedMotion = useReducedMotion();

  // Resize listener to detect mobile viewport
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Fetch reviews if not cached
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

  // Auto-cycle for mobile carousel
  useEffect(() => {
    if (!isMobile || isPaused || prefersReducedMotion || comments.length <= 1) return;
    const interval = setInterval(() => {
      setMobileIndex((prev) => (prev + 1) % comments.length);
    }, 6000);
    return () => clearInterval(interval);
  }, [isMobile, isPaused, prefersReducedMotion, comments.length]);

  // Hide the entire panel if there's no reviews data and it's not loading
  if (reviews.length === 0) return null;
  if (!loading && comments.length === 0) return null;

  // Render Skeleton state with reserved height
  if (loading) {
    return (
      <FragrancePanel title="Reviews">
        <div className="flex flex-col justify-center items-center gap-6 px-6 py-8 h-[16rem] animate-pulse">
          <div className="flex items-center gap-2">
            <RefreshCw size={13} className="animate-spin text-white/45" />
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/45 font-bold">
              Distilling reviews...
            </p>
          </div>
          <div className="h-4 bg-white/5 rounded-md w-3/4 max-w-md"></div>
          <div className="h-4 bg-white/5 rounded-md w-1/2 max-w-sm"></div>
          <div className="h-4 bg-white/5 rounded-md w-2/3 max-w-md"></div>
        </div>
      </FragrancePanel>
    );
  }

  // Trust footer
  const trustFooter = (
    <div className="border-t border-white/[0.05] px-4 py-2.5 flex items-center justify-between text-[10px] text-white/40">
      <span>Summarized from community reviews</span>
      {reviews.length > 0 && (
        <span>Based on {reviews.length} reviews</span>
      )}
    </div>
  );

  // REDUCED MOTION or STATIC FALLBACK
  if (prefersReducedMotion) {
    const displayed = expanded ? comments : comments.slice(0, 3);
    return (
      <FragrancePanel title="Reviews">
        <div className="flex flex-col gap-6 px-6 py-6 min-h-[12rem] justify-center">
          {displayed.map((comment, index) => (
            <div key={index} className="flex flex-col items-center text-center gap-2">
              <p className="max-w-lg text-[15px] italic leading-relaxed text-white/85 font-serif">
                "{comment.text}"
              </p>
              {getThemeBadge(comment.theme)}
            </div>
          ))}
          {comments.length > 3 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-[11px] uppercase tracking-[0.15em] text-scent-accent hover:text-white transition-colors duration-200 mt-2 font-medium"
            >
              {expanded ? "Show Less" : `Show All (${comments.length})`}
            </button>
          )}
        </div>
        {trustFooter}
      </FragrancePanel>
    );
  }

  // MOBILE INTERACTIVE CAROUSEL
  if (isMobile) {
    const currentComment = comments[mobileIndex];
    return (
      <FragrancePanel title="Reviews">
        <div
          className="relative px-6 py-8 min-h-[14rem] flex flex-col justify-between items-center"
          onTouchStart={() => setIsPaused(true)}
          onTouchEnd={() => setIsPaused(false)}
          onMouseEnter={() => setIsPaused(true)}
          onMouseLeave={() => setIsPaused(false)}
        >
          {/* Previous Arrow */}
          {comments.length > 1 && (
            <button
              onClick={() => setMobileIndex((prev) => (prev - 1 + comments.length) % comments.length)}
              className="absolute left-2 top-1/2 -translate-y-1/2 p-2 text-white/40 hover:text-white transition-colors duration-200"
              aria-label="Previous review"
            >
              <ChevronLeft size={20} />
            </button>
          )}

          {/* Comment Slide */}
          <div className="flex-1 flex flex-col items-center justify-center text-center max-w-[80%] mx-auto py-2">
            <AnimatePresence mode="wait">
              <motion.div
                key={mobileIndex}
                initial={{ opacity: 0, scale: 0.98, y: 5 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98, y: -5 }}
                transition={{ duration: 0.25, ease: "easeOut" }}
                className="flex flex-col items-center gap-4"
              >
                <Quote size={20} className="text-scent-accent/40" />
                <p className="text-[16px] italic leading-[1.65] text-white/90 font-serif">
                  {currentComment.text}
                </p>
                {getThemeBadge(currentComment.theme)}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Next Arrow */}
          {comments.length > 1 && (
            <button
              onClick={() => setMobileIndex((prev) => (prev + 1) % comments.length)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-white/40 hover:text-white transition-colors duration-200"
              aria-label="Next review"
            >
              <ChevronRight size={20} />
            </button>
          )}

          {/* Dots Indicator */}
          {comments.length > 1 && (
            <div className="flex items-center gap-1.5 mt-4">
              {comments.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setMobileIndex(i)}
                  className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${
                    i === mobileIndex ? "bg-scent-accent w-3" : "bg-white/20"
                  }`}
                  aria-label={`Go to slide ${i + 1}`}
                />
              ))}
            </div>
          )}
        </div>
        {trustFooter}
      </FragrancePanel>
    );
  }

  // DESKTOP MAGAZINE EDITORIAL LAYOUT
  if (comments.length === 1) {
    const comment = comments[0];
    return (
      <FragrancePanel title="Reviews">
        <div className="flex flex-col items-center justify-center text-center gap-4 px-8 py-10 min-h-[12rem]">
          <Quote size={24} className="text-scent-accent/50" />
          <p className="max-w-2xl text-[18px] italic leading-[1.75] text-white font-serif">
            "{comment.text}"
          </p>
          {getThemeBadge(comment.theme)}
        </div>
        {trustFooter}
      </FragrancePanel>
    );
  }

  if (comments.length === 2) {
    return (
      <FragrancePanel title="Reviews">
        <div className="grid grid-cols-2 gap-8 px-8 py-10 min-h-[12rem] divide-x divide-white/[0.05]">
          {comments.map((comment, index) => (
            <div key={index} className="flex flex-col items-center justify-center text-center gap-3 px-4">
              <Quote size={18} className="text-scent-accent/40" />
              <p className="text-[15px] italic leading-[1.7] text-white/85 font-serif">
                "{comment.text}"
              </p>
              {getThemeBadge(comment.theme)}
            </div>
          ))}
        </div>
        {trustFooter}
      </FragrancePanel>
    );
  }

  // comments.length >= 3: Lead Quote + Alternating Teleprompter
  const leadComment = comments[0];
  const scrollingComments = comments.slice(1);
  const totalChars = scrollingComments.reduce((acc, c) => acc + c.text.length, 0);
  const scrollDuration = Math.max(15, Math.min(60, Math.round(totalChars / 15)));

  // Duplicate the list so it scrolls seamlessly
  const renderedScrolling = [...scrollingComments, ...scrollingComments];

  return (
    <FragrancePanel title="Reviews">
      <div className="flex flex-col">
        {/* Lead Quote */}
        <div className="relative px-8 py-6 text-center flex flex-col items-center justify-center gap-3 bg-white/[0.01] border-b border-white/[0.05]">
          <span className="absolute top-2 left-6 text-[52px] font-serif text-scent-accent/10 pointer-events-none select-none leading-none">"</span>
          <p className="font-serif italic text-[18px] leading-[1.7] text-white max-w-2xl relative z-10">
            {leadComment.text}
          </p>
          {getThemeBadge(leadComment.theme)}
        </div>

        {/* Teleprompter for secondary reviews */}
        <div className="relative border-b border-white/[0.03] bg-black/[0.08]">
          <div
            className="scent-reviews-teleprompter h-[14rem] px-6 py-4"
            style={{ "--reviews-edge-fade": "3.2rem" } as React.CSSProperties}
          >
            <div
              className="scent-reviews-teleprompter-track gap-5"
              style={{ "--reviews-scroll-duration": `${scrollDuration}s` } as React.CSSProperties}
            >
              {renderedScrolling.map((comment, index) => {
                const isLeft = index % 2 === 0;
                return (
                  <div
                    key={`${index}-${comment.text.slice(0, 16)}`}
                    className={`flex flex-col px-4 py-1.5 w-full ${isLeft ? "items-start text-left" : "items-end text-right"}`}
                  >
                    <div className="max-w-[75%] flex flex-col gap-1 relative">
                      <p className="text-[14px] italic leading-relaxed text-white/80 font-serif">
                        "{comment.text}"
                      </p>
                      {getThemeBadge(comment.theme)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      {trustFooter}
    </FragrancePanel>
  );
}
