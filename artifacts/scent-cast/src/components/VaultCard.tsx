import React from 'react';
import { BrandGoldLabel } from '@/components/BrandGoldLabel';

/**
 * Which vault surface a card belongs to. The owner's Wardrobe grid and the
 * public SharePage grid share an identical structure but use intentionally
 * different sizing (card height, body padding, image margins, brand-label
 * offset). Those — and only those — differences live in {@link tonePreset}.
 */
export type VaultCardTone = 'share' | 'wardrobe';

interface VaultCardTonePreset {
  /** Min-height floor: compact 2-up vs roomy single column, plus the `sm:` floor. */
  minH: string;
  /** Inner body padding (incl. `sm:`). */
  body: string;
  /** Extra classes appended to the brand label. */
  brandLabel: string;
  /** Image-slot vertical margins (incl. `sm:`). */
  imageSlot: string;
}

function tonePreset(tone: VaultCardTone, compact: boolean): VaultCardTonePreset {
  if (tone === 'share') {
    return {
      minH: `${compact ? 'min-h-[18rem]' : 'min-h-[32rem]'} sm:min-h-[32rem]`,
      body: `${compact ? 'px-3 py-4' : 'px-6 py-7'} sm:px-8 sm:py-9`,
      brandLabel: 'scent-card-brand w-full',
      imageSlot: `${compact ? 'my-3' : 'my-5'} sm:my-6`,
    };
  }
  return {
    minH: `${compact ? 'min-h-[17.5rem]' : 'min-h-[26rem]'} sm:min-h-[26rem]`,
    body: `${compact ? 'px-3 py-4' : 'px-6 py-5'} sm:px-8 sm:py-6`,
    brandLabel: 'scent-card-brand w-full mt-1 sm:mt-1.5',
    imageSlot: `${compact ? 'mt-2 mb-2' : 'mt-3 mb-3'} sm:mt-4 sm:mb-4`,
  };
}

interface VaultCardProps {
  tone: VaultCardTone;
  /** Compact 2-up mobile grid vs roomy single column. */
  compact: boolean;
  /** Brand text for the gold label. */
  brand: string;
  /** Display name for the title row (also the `title` tooltip). */
  name: string;
  /**
   * Image-slot content — a `<BottleImage>` (route bottle imagery through it so it
   * honors the render budget), a hide-images fallback, etc. The slot is the sized
   * `relative ... flex-1` region; children should fill it (e.g. `absolute inset-0`).
   */
  children: React.ReactNode;
}

/**
 * Shared vault tile shell for the Wardrobe and SharePage grids, so the two
 * surfaces can't structurally drift. The interactive wrapper (motion, onClick,
 * hover prefetch) stays at each call site because it genuinely differs; this
 * component owns only the visual shell: the `.scent-fragrance-card` frame, flex
 * column, brand label, sized image slot, and title row.
 */
export function VaultCard({ tone, compact, brand, name, children }: VaultCardProps) {
  const preset = tonePreset(tone, compact);
  return (
    <div
      className={`scent-fragrance-card scent-hover-lift w-full h-full ${preset.minH} transition-[transform,border-color,box-shadow] duration-500 motion-reduce:transition-none relative overflow-hidden flex flex-col`}
    >
      <div className="scent-card-frame" aria-hidden />
      <div className={`relative z-[1] flex h-full flex-col items-center ${preset.body}`}>
        <BrandGoldLabel brand={brand} className={preset.brandLabel} />
        <div className={`relative flex-1 w-full min-h-0 ${preset.imageSlot}`}>
          {children}
        </div>
        <div className="scent-card-title-row shrink-0">
          <h3 className="scent-card-title" title={name}>
            {name}
          </h3>
        </div>
      </div>
    </div>
  );
}
