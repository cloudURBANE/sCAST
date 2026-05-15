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
 * - Inside: (1) symmetric **artboard** inset + clip + flex **items-end**, (2) packshot
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
  /** Persistent visual rescue controls: zoom, nudge, and edge crop. */
  adjustment?: BottleImageAdjustment | null;
  loading?: 'lazy' | 'eager';
};

export const BottleImage: React.FC<BottleImageProps> = ({
  src,
  alt,
  variant,
  proxy = true,
  className,
  imgClassName,
  adjustment,
  loading = 'lazy',
}) => {
  const [broken, setBroken] = useState(false);
  const url = proxy ? proxiedImageUrl(src, { packshot: true }) : (src ?? '');
  const showPlaceholder = !url || broken;

  useEffect(() => {
    setBroken(false);
  }, [src, proxy]);

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
          <div className="bottle-packshot-frame" style={bottleImageAdjustmentStyle(adjustment)}>
            <img
              key={url}
              src={url}
              alt={alt}
              className={bottleImageFillClass(imgClassName)}
              referrerPolicy="no-referrer"
              loading={loading}
              decoding="async"
              onError={() => setBroken(true)}
            />
          </div>
        )}
      </div>
    </div>
  );
};
