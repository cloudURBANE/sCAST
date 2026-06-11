import React from 'react';

export const CommunityHero: React.FC = () => (
  <section className="scent-hero-zone mx-auto w-full max-w-[940px] space-y-3 px-4 py-2 text-center sm:px-6 sm:py-3">
    <h2 className="mx-auto max-w-[22rem] text-balance font-serif italic text-[clamp(1.9rem,7vw,3.2rem)] leading-[1.04] tracking-normal text-[#fff7ec] sm:max-w-3xl">
      Discover signature scents from real fragrance lovers.
    </h2>
    <p className="mx-auto max-w-[21rem] text-balance font-serif italic text-[15px] leading-7 text-scent-muted sm:max-w-xl sm:text-base">
      Explore the wardrobes our community actually wears, and find your next signature.
    </p>
  </section>
);
