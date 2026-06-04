import React from 'react';

export type BrandLengthBucket = 'short' | 'medium' | 'long' | 'xlong';

/** Adaptive brand-text sizing bucket. Longer brand names get smaller type. */
export function brandLengthBucket(brand: string): BrandLengthBucket {
  const len = brand.trim().length;
  if (len <= 10) return 'short';
  if (len <= 16) return 'medium';
  if (len <= 24) return 'long';
  return 'xlong';
}

type BrandGoldLabelElement = 'p' | 'span';

type BrandGoldLabelProps = Omit<React.HTMLAttributes<HTMLElement>, 'children'> & {
  as?: BrandGoldLabelElement;
  brand: string;
  shimmer?: boolean;
};

export const BrandGoldLabel: React.FC<BrandGoldLabelProps> = ({
  as = 'p',
  brand,
  className = 'scent-card-brand',
  shimmer = true,
  title,
  ...props
}) => {
  const labelRef = React.useRef<HTMLElement | null>(null);
  const [hasViewportSheen, setHasViewportSheen] = React.useState(false);
  const labelClassName = [
    'scent-brand-gold-label',
    hasViewportSheen ? 'scent-brand-gold-label--viewport-sheen' : null,
    className,
  ].filter(Boolean).join(' ');

  React.useEffect(() => {
    setHasViewportSheen(false);
  }, [brand]);

  React.useEffect(() => {
    if (
      !shimmer ||
      hasViewportSheen ||
      typeof window === 'undefined' ||
      !('IntersectionObserver' in window) ||
      !window.matchMedia('(hover: none) and (prefers-reduced-motion: no-preference)').matches
    ) {
      return;
    }

    const node = labelRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setHasViewportSheen(true);
        observer.disconnect();
      },
      {
        rootMargin: '-38% 0px -38% 0px',
        threshold: 0,
      },
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, [brand, hasViewportSheen, shimmer]);

  return React.createElement(
    as,
    {
      ...props,
      ref: labelRef,
      className: labelClassName,
      'data-len': brandLengthBucket(brand),
      title: title ?? brand,
    },
    shimmer ? (
      <span className="scent-brand-gold-shimmer" data-text={brand}>
        {brand}
      </span>
    ) : (
      brand
    ),
  );
};
