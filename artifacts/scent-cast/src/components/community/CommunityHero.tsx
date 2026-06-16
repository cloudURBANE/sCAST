import React from 'react';

export const CommunityHero: React.FC = () => (
  <section className="scent-hero-zone mx-auto w-full max-w-[940px] px-4 py-3 text-center sm:px-6 sm:py-4">
    {/* Eyebrow — a wide-tracked gold category tag flanked by thin hairlines,
        framing the heading without spending any blur on the render budget. */}
    <div className="mx-auto flex max-w-[19rem] items-center justify-center gap-3 sm:max-w-sm">
      <span
        className="h-px flex-1 bg-gradient-to-r from-transparent to-scent-accent/45"
        aria-hidden="true"
      />
      <span className="shrink-0 scent-type-label text-[0.62rem] text-scent-accent/90 sm:text-[0.7rem]">
        The Collective
      </span>
      <span
        className="h-px flex-1 bg-gradient-to-l from-transparent to-scent-accent/45"
        aria-hidden="true"
      />
    </div>

    <h2 className="mx-auto mt-4 max-w-[22rem] text-balance font-serif italic text-[clamp(1.9rem,7vw,3.2rem)] leading-[1.04] tracking-normal text-[#fff7ec] sm:max-w-3xl">
      Discover{' '}
      {/* Metallic bg-clip-text gradient — cheap and Safari-safe (no blur). */}
      <span className="bg-gradient-to-r from-[#fff7ec] via-scent-accent to-[#fff7ec] bg-clip-text text-transparent">
        Signature Scents
      </span>{' '}
      from real fragrance lovers.
    </h2>

    <p className="mx-auto mt-4 max-w-[34rem] text-balance text-[0.95rem] leading-relaxed text-scent-text-muted/80 sm:mt-5 sm:text-base">
      A curated space where enthusiasts share daily rotations, pit bottles
      head-to-head in battles, and trade olfactory notes.
    </p>
  </section>
);
