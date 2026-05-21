import React, { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { bottleArtboardClass, bottleImageFillClass, type BottleImageVariant } from '@/lib/bottleImageFrame';
import {
  bottleImageAdjustmentStyle,
  type BottleImageAdjustment,
} from '@/lib/bottleImageAdjustment';
import { proxiedImageUrl } from '@/lib/imageProxy';

/**
 * Primary UI for vault bottle artwork: handles proxy URL, **resize-up** framing (see
 * `bottleImageFrame.ts`), broken/missing image placeholders, and async decode.
 *
 * **Layout contract**
 * - You must give the root `className` so this component has a real size (e.g.
import React, { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { bottleArtboardClass, bottleImageFillClass, type BottleImageVariant } from '@/lib/bottleImageFrame';
import {
  bottleImageAdjustmentStyle,
  type BottleImageAdjustment,
} from '@/lib/bottleImageAdjustment';
import { proxiedImageUrl } from '@/lib/imageProxy';

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
}) => {
  const url = proxy ? proxiedImageUrl(src, { packshot: true }) : (src ?? '');

  const [prevUrl, setPrevUrl] = useState(url);
  const [broken, setBroken] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [isLoading, setIsLoading] = useState(!!url);

  // Synchronously reset state if the URL changes
  if (url !== prevUrl) {
    setPrevUrl(url);
    setBroken(false);
    setRetryCount(0);
    setIsLoading(!!url);
  }

  const handleLoad = () => {
    setIsLoading(false);
    setBroken(false);
    onLoad?.();
  };

  const handleError = () => {
    if (retryCount < 2) {
      // Retry after a 300ms delay to absorb transient proxy/network blips
      setTimeout(() => {
        setRetryCount((prev) => prev + 1);
      }, 300);
    } else {
      setBroken(true);
      setIsLoading(false);
      onError?.();
    }
  };

  const showPlaceholder = !url || broken;
  const showSkeleton = isLoading && !broken;

  // ① Root: sized by parent. ② Artboard: inset + flex-end + .bottle-packshot-img shelf CSS.
  return (
    <div className={cn('relative min-h-0 min-w-0', className)}>
      <div className={bottleArtboardClass(variant)}>
        {showPlaceholder ? (
          <div className="flex h-full w-full min-h-0 items-center justify-center rounded-sm border border-dashed border-white/15 bg-white/[0.03] px-1">
            <span className="text-center text-[8px] uppercase leading-tight tracking-widest text-white/30">
              {broken ? 'Unavailable' : 'No image'}
            </span>
          </div>
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
              <img
                key={`${url}-${retryCount}`}
                src={url}
                alt={alt}
                className={bottleImageFillClass(imgClassName)}
                referrerPolicy="no-referrer"
                loading={loading}
                fetchPriority={fetchPriority}
                decoding="async"
                onLoad={handleLoad}
                onError={handleError}
              />
            </div>
          </>
        )}
        {showFrameGuide ? <BottleFrameGuide /> : null}
      </div>
    </div>
  );
};
