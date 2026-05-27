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
  sheenDelay?: number | string;
};

type BrandGoldLabelStyle = React.CSSProperties & {
  '--brand-sheen-delay'?: string;
};

function formatSheenDelay(delay: number | string): string {
  return typeof delay === 'number' ? `${delay}s` : delay;
}

export const BrandGoldLabel: React.FC<BrandGoldLabelProps> = ({
  as = 'p',
  brand,
  className = 'scent-card-brand',
  shimmer = true,
  sheenDelay,
  style,
  title,
  ...props
}) => {
  const labelStyle: BrandGoldLabelStyle =
    sheenDelay === undefined
      ? (style as BrandGoldLabelStyle)
      : {
          ...style,
          '--brand-sheen-delay': formatSheenDelay(sheenDelay),
        };

  return React.createElement(
    as,
    {
      ...props,
      className,
      'data-len': brandLengthBucket(brand),
      style: labelStyle,
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
