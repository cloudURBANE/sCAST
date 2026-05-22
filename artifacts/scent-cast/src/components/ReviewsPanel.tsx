import React, { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Quote, RefreshCw } from "lucide-react";
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

  const maxInitial = isMobile ? 2 : 3;
  const displayedComments = expanded ? comments : comments.slice(0, maxInitial);
  const hasMore = comments.length > maxInitial;
  
  // Decide columns count based on comments length (cap at 3)
  const cols = Math.min(3, comments.length);

  // Trust footer
  const trustFooter = (
    <div className="border-t border-white/[0.05] px-4 py-2.5 flex items-center justify-between text-[10px] text-white/40">
      <span>Summarized from community reviews</span>
      {reviews.length > 0 && (
        <span>Based on {reviews.length} reviews</span>
      )}
    </div>
  );

  return (
    <FragrancePanel title="Reviews">
      <div className="flex flex-col">
        <motion.div
          layout="position"
          className={`grid gap-y-6 gap-x-8 py-8 px-6 ${
            cols === 1
              ? "grid-cols-1 max-w-2xl mx-auto"
              : cols === 2
                ? "grid-cols-1 md:grid-cols-2"
                : "grid-cols-1 md:grid-cols-3"
          }`}
        >
          <AnimatePresence initial={false}>
            {displayedComments.map((comment, index) => {
              const isFirstMobile = index === 0;
              const isFirstInRowDesktop = index % cols === 0;
              
              let borderClasses = "";
              if (cols === 2) {
                borderClasses = `
                  ${isFirstMobile ? "" : "border-t border-white/[0.05] pt-6 md:border-t-0 md:pt-0"}
                  ${isFirstInRowDesktop ? "" : "md:border-l md:border-white/[0.05] md:pl-8"}
                `;
              } else if (cols === 3) {
                borderClasses = `
                  ${isFirstMobile ? "" : "border-t border-white/[0.05] pt-6"}
                  ${isFirstInRowDesktop ? "md:border-l-0 md:pl-0" : "md:border-l md:border-white/[0.05] md:pl-8"}
                  ${index >= 3 ? "md:border-t md:border-white/[0.05] md:pt-6" : "md:border-t-0 md:pt-0"}
                `;
              } else {
                borderClasses = isFirstMobile ? "" : "border-t border-white/[0.05] pt-6";
              }

              return (
                <motion.div
                  key={index}
                  initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -12 }}
                  transition={{ duration: 0.2, ease: "easeOut" }}
                  className={`flex flex-col items-center justify-center text-center gap-3 px-4 ${borderClasses}`}
                >
                  <Quote size={18} className="text-scent-accent/40 shrink-0" />
                  <p className={`italic leading-[1.75] text-white/90 font-serif ${
                    cols === 1 ? "text-[18px] max-w-2xl" : "text-[16px] max-w-md"
                  }`}>
                    "{comment.text}"
                  </p>
                  {getThemeBadge(comment.theme)}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </motion.div>

        {hasMore && (
          <div className="flex justify-center pb-6">
            <button
              onClick={() => setExpanded(!expanded)}
              className="inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-white/[0.04] px-4 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-white/70 transition-all hover:border-scent-accent/35 hover:bg-scent-accent/[0.08] hover:text-scent-accent"
            >
              {expanded ? "Show Less" : `Show All Reviews (${comments.length})`}
            </button>
          </div>
        )}
      </div>
      {trustFooter}
    </FragrancePanel>
  );
}
