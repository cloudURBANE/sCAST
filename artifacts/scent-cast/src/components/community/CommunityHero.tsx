import React from 'react';

export const CommunityHero: React.FC = () => (
  <section className="scent-hero-zone mx-auto w-full max-w-[960px] space-y-4 px-4 py-3 text-center sm:px-6 sm:py-4">
    <h2 className="mx-auto max-w-[21rem] text-balance font-serif italic text-[clamp(1.85rem,7.5vw,3.25rem)] leading-[1.02] tracking-normal text-[#fff7ec] sm:max-w-3xl">
      Discover signature scents from real fragrance lovers.
    </h2>
    <p className="mx-auto max-w-[20rem] text-balance font-serif italic text-[15px] leading-7 text-scent-muted sm:max-w-xl sm:text-base">
      Explore the wardrobes our community actually wears, and find your next signature.
    </p>
  </section>
);
