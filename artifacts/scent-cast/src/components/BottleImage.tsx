import React, { useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { bottleArtboardClass, bottleImageFillClass, type BottleImageVariant } from '@/lib/bottleImageFrame';
import {
  bottleImageAdjustmentStyle,
  type BottleImageAdjustment,
} from '@/lib/bottleImageAdjustment';
import { isProcessedStorageImageUrl, proxiedImageUrl } from '@/lib/imageProxy';
import { isLowRenderBudget } from '@/lib/platform';
import { reportImageMetric } from '@/lib/imageTelemetry';
import { Spinner } from '@/components/ui/spinner';

const RETRY_LIMIT = 2;
const RETRY_BASE_MS = 250;

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Exponential backoff with full jitter — absorbs transient blips without a retry stampede. */
function backoffDelayMs(attempt: number): number {
  return RETRY_BASE_MS * 2 ** attempt + Math.random() * RETRY_BASE_MS;
}

/**
 * Primary UI for vault bottle artwork: handles proxy URL, **resize-up** framing (see
 * `bottleImageFrame.ts`), broken/missing image placeholders, and async decode.
 *
 * **Layout contract**
 * - You must give the root `className` so this component has a real size (e.g.
 *   `absolute inset-0` in a card, `h-full w-full` in a thumb, `min-h-0 w-full flex-1`
 *   in the featured hero). Framing does nothing if the slot has no dimensions.
 * - Inside: (1) symmetric **artboard** inset + clip + column flex **justify-end**, (2) packshot
 *   CSS `object-fit/object-position` + **`origin-bottom`** so bottles share one shelf line.
 */

type BottleImageProps = {
  src: string | undefined | null;
  alt: string;
  variant: BottleImageVariant;
  /** Use `/api/image-proxy` for http(s) URLs (default true). */
  proxy?: boolean;
  /** Outermost wrapper: must establish size — e.g. `absolute inset-0 z-10`, `h-full w-full`, `flex-1 min-h-0 w-full`. */
  className?: string;
  /** Extra classes on the `<img>` (hover, filters). */
  imgClassName?: string;
  /** Persistent visual rescue controls: zoom, nudge, and per-edge clip (top/right/bottom/left). */
  adjustment?: BottleImageAdjustment | null;
  /** Blueprint overlay for the manual frame editor. Shares the real artboard and shelf line. */
  showFrameGuide?: boolean;
  loading?: 'lazy' | 'eager';
  fetchPriority?: 'high' | 'low' | 'auto';
  onLoad?: () => void;
  onError?: () => void;
  /** Beta: render a looping video instead of <img>. Falls back to <img> when prefers-reduced-motion is active. */
  videoSrc?: string | null;
  /**
   * The fragrance's image is being actively backfilled in the background (the
   * row saved imageless and a poll burst is running). When there's no `src` yet,
   * show a bounded "fetching…" spinner instead of the static "No image" — an
   * honest pending signal. Never spins indefinitely: the burst clears it.
   */
  isSyncing?: boolean;
};

function BottleFrameGuide() {
  return (
    <div className="bottle-frame-guide" aria-hidden="true">
      <div className="bottle-frame-guide__grid" />
      <div className="bottle-frame-guide__center" />
      <div className="bottle-frame-guide__width bottle-frame-guide__width--left" />
      <div className="bottle-frame-guide__width bottle-frame-guide__width--right" />
      <div className="bottle-frame-guide__height">
        <span>target height</span>
      </div>
      <div className="bottle-frame-guide__baseline">
        <span>base line</span>
      </div>
    </div>
  );
}

export const BottleImage: React.FC<BottleImageProps> = ({
  src,
  alt,
  variant,
  proxy = true,
  className,
  imgClassName,
  adjustment,
  showFrameGuide = false,
  loading = 'lazy',
  fetchPriority,
  onLoad,
  onError,
  videoSrc,
  isSyncing = false,
}) => {
  const reduceMotion = useReducedMotion();
  const lowRenderBudget = React.useRef(isLowRenderBudget()).current;
  // Direct URL the SPA would normally render (proxy-bypassed for our own
  // processed CDN objects per Phase 1).
  const url = proxy ? proxiedImageUrl(src, { packshot: true }) : (src ?? '');

  // Phase 4 fallback: when `url` is a *direct* CDN passthrough for one of our own
  // processed objects, keep a proxied version ready. If the direct fetch fails
  // (e.g. a transient 403 from a referrer/CDN policy) we retry once through
  // /api/image-proxy before declaring the image unavailable. Third-party images
  // are already proxied, so they have no further fallback.
  const trimmedSrc = (src ?? '').trim();
  const hasDirectCdnSrc =
    proxy && /^https?:\/\//i.test(trimmedSrc) && isProcessedStorageImageUrl(trimmedSrc);
  const proxyFallbackUrl = hasDirectCdnSrc ? proxiedImageUrl(src, { forceProxy: true }) : '';
  const mediaKey = `${url}\u0000${videoSrc ?? ''}`;

  const imgRef = React.useRef<HTMLImageElement | null>(null);
  const retryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadStartRef = React.useRef<number>(nowMs());
  const errorCountRef = React.useRef(0);
  const reportedRef = React.useRef(false);
  const [prevMediaKey, setPrevMediaKey] = useState(mediaKey);
  const [broken, setBroken] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [usedProxyFallback, setUsedProxyFallback] = useState(false);
  const [isLoading, setIsLoading] = useState(!!url);
  const [videoFailed, setVideoFailed] = useState(false);
  const useVideo = !!videoSrc && !reduceMotion && !lowRenderBudget && !videoFailed;

  const canProxyFallback = !!proxyFallbackUrl && proxyFallbackUrl !== url;
  const activeUrl = usedProxyFallback ? proxyFallbackUrl : url;

  const clearRetryTimer = React.useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  // Synchronously reset state if the image/video source changes.
  if (mediaKey !== prevMediaKey) {
    clearRetryTimer();
    setPrevMediaKey(mediaKey);
    setBroken(false);
    setRetryCount(0);
    setUsedProxyFallback(false);
    setIsLoading(!!url);
    setVideoFailed(false);
    loadStartRef.current = nowMs();
    errorCountRef.current = 0;
    reportedRef.current = false;
  }

  React.useEffect(() => clearRetryTimer, [clearRetryTimer]);

  // Emit exactly one terminal metric per media-load cycle.
  const report = (outcome: 'load' | 'error' | 'proxy-fallback') => {
    if (reportedRef.current) return;
    reportedRef.current = true;
    reportImageMetric({
      outcome,
      ms: nowMs() - loadStartRef.current,
      attempts: errorCountRef.current,
      usedProxyFallback,
      url: activeUrl,
      variant,
    });
  };

  const handleLoad = () => {
    clearRetryTimer();
    setIsLoading(false);
    setBroken(false);
    report(usedProxyFallback ? 'proxy-fallback' : 'load');
    onLoad?.();
  };

  const handleError = () => {
    clearRetryTimer();
    errorCountRef.current += 1;

    if (retryCount < RETRY_LIMIT) {
      // Jittered exponential backoff to absorb transient proxy/network blips.
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        setRetryCount((prev) => prev + 1);
      }, backoffDelayMs(retryCount));
      return;
    }

    // Retries exhausted. If this was a direct CDN URL, fall back to the proxy
    // once (with a fresh retry budget) before giving up — the safety net for a
    // processed object that transiently 403s on the direct path.
    if (canProxyFallback && !usedProxyFallback) {
      setUsedProxyFallback(true);
      setRetryCount(0);
      setIsLoading(true);
      return;
    }

    setBroken(true);
    setIsLoading(false);
    report('error');
    onError?.();
  };

  React.useEffect(() => {
    if (useVideo || !activeUrl || broken || !isLoading) return;
    const img = imgRef.current;
    if (!img?.complete) return;

    if (img.naturalWidth > 0) {
      handleLoad();
    } else if (loading !== 'lazy') {
      // An eager image that is `complete` with zero natural width genuinely
      // failed to decode. A lazy image, however, reports `complete && naturalWidth === 0`
      // on iOS Safari while it is still deferred off-screen (not an error) —
      // flagging it here is what surfaced "Unavailable" on the iPhone grid even
      // though the URL was fine. For lazy images, wait for the real load/error event.
      handleError();
    }
  }, [broken, isLoading, retryCount, activeUrl, useVideo, loading, usedProxyFallback]);

  const handleVideoError = () => {
    setVideoFailed(true);
    setIsLoading(!!url);
    if (!url) onError?.();
  };

  // Strip brightness filter for video path: video was mastered against a black card at 1.0 brightness;
  // applying brightness-[1.1] from imgClassName would make the bottle appear overlit vs. the card.
  const videoClassName = imgClassName
    ? imgClassName.split(/\s+/).filter(cls => !cls.includes('brightness')).join(' ')
    : undefined;

  // When rendering video, its poster handles visual feedback; failed video falls back to the still image.
  const showPlaceholder = useVideo ? false : (!url || broken);
  const showSkeleton = useVideo ? false : (isLoading && !broken);
  // Empty source, but the backend is still actively resolving the image: show a
  // bounded "fetching…" spinner rather than the static "No image". (`showPlaceholder
  // && !broken` already implies there's no `src`.) The caller guarantees this is
  // time-bounded, so it can never strand the indefinite spinner FE-1 removed.
  const showFetchingPlaceholder = showPlaceholder && !broken && isSyncing;

  // ① Root: sized by parent. ② Artboard: inset + flex-end + .bottle-packshot-img shelf CSS.
  return (
    <div className={cn('relative min-h-0 min-w-0', className)}>
      <div className={bottleArtboardClass(variant)}>
        {showPlaceholder ? (
          // No usable image. Two distinct states, never an indefinite spinner:
          //  • actively syncing → a *bounded* "Fetching" spinner (the burst clears it),
          //    so a freshly-added tile reads honestly while its image resolves.
          //  • otherwise → static text. An empty source (nothing to load) shows
          //    "No image"; an <img> that errored after retries shows "Unavailable".
          //    A perpetual spinner here is exactly what stranded fragrances whose
          //    backend image never arrives (the BottleImage spinner-gap bug).
          // The pulsing skeleton (`showSkeleton`) remains the affordance for a live URL.
          showFetchingPlaceholder ? (
            <div className="flex h-full w-full min-h-0 flex-col items-center justify-center gap-1.5 rounded-sm border border-dashed border-white/15 bg-white/[0.03] px-1">
              <Spinner className="size-3 text-white/30" />
              <span className="text-center text-[8px] uppercase leading-tight tracking-widest text-white/25">
                Fetching
              </span>
            </div>
          ) : broken ? (
            // An <img> mounted and errored after retries — keep it textual.
            // A bottle silhouette here would imply "still coming", which is wrong.
            <div className="flex h-full w-full min-h-0 items-center justify-center rounded-sm border border-dashed border-white/15 bg-white/[0.03] px-1">
              <span className="text-center text-[8px] uppercase leading-tight tracking-widest text-white/30">
                Unavailable
              </span>
            </div>
          ) : (
            // BE-1: no image ever resolved (brand absent from the bundled dataset
            // and the live pipeline found nothing). Show one generic bottle
            // silhouette rather than bare "No image" text — a brand-agnostic
            // placeholder that reads as an intentional empty packshot. Inline SVG
            // (no asset fetch, never persisted) so it can't reintroduce a spinner.
            <div className="flex h-full w-full min-h-0 flex-col items-center justify-center gap-1.5 rounded-sm border border-dashed border-white/15 bg-white/[0.03] px-1">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="size-5 text-white/25"
              >
                {/* cap, neck, shoulders, body — a generic perfume bottle */}
                <path d="M10 2.5h4v2h-4z" />
                <path d="M10.5 4.5v2.2c0 .5-.25.95-.7 1.25C8.7 8.7 8 9.9 8 11.2V19a2.5 2.5 0 0 0 2.5 2.5h3A2.5 2.5 0 0 0 16 19v-7.8c0-1.3-.7-2.5-1.8-3.25-.45-.3-.7-.75-.7-1.25V4.5" />
                <path d="M9 13.5h6" />
              </svg>
              <span className="text-center text-[8px] uppercase leading-tight tracking-widest text-white/25">
                No image
              </span>
            </div>
          )
        ) : (
          <>
            {showSkeleton && (
              <div className="absolute inset-0 flex h-full w-full min-h-0 items-end justify-center rounded-sm bg-white/[0.01] px-1 animate-pulse pb-8 z-20">
                <div className="h-1/2 w-1/4 rounded-t-md bg-white/5 relative flex flex-col items-center">
                  <div className="absolute -top-2.5 h-2.5 w-1/2 rounded-t-sm bg-white/10" />
                </div>
              </div>
            )}
            <div
              className={cn(
                "bottle-packshot-frame transition-opacity duration-300",
                showSkeleton ? "opacity-0" : "opacity-100"
              )}
              style={bottleImageAdjustmentStyle(adjustment)}
            >
              {useVideo ? (
                <video
                  className={cn('bottle-packshot-video min-h-0 min-w-0 origin-bottom transform-gpu select-none', videoClassName)}
                  src={videoSrc!}
                  autoPlay
                  loop
                  muted
                  playsInline
                  disablePictureInPicture
                  preload="metadata"
                  poster={url || undefined}
                  onError={handleVideoError}
                  aria-label={alt}
                />
              ) : (
                <img
                  ref={imgRef}
                  key={`${activeUrl}-${retryCount}`}
                  src={activeUrl}
                  alt={alt}
                  className={bottleImageFillClass(imgClassName)}
                  referrerPolicy="no-referrer"
                  loading={loading}
                  fetchPriority={fetchPriority}
                  decoding="async"
                  onLoad={handleLoad}
                  onError={handleError}
                />
              )}
            </div>
          </>
        )}
        {showFrameGuide ? <BottleFrameGuide /> : null}
      </div>
    </div>
  );
};
