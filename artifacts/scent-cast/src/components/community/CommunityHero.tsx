import React from 'react';

export const CommunityHero: React.FC = () => (
  <section className="scent-hero-zone mx-auto w-full max-w-3xl space-y-6 px-2 text-center sm:px-0">
    <h2 className="mx-auto max-w-[21rem] text-balance font-serif italic text-[clamp(1.95rem,8.5vw,3.8rem)] text-[#fff7ec] leading-[0.98] tracking-normal sm:max-w-3xl">
      Discover signature scents from real fragrance lovers.
    </h2>
    <p className="mx-auto max-w-[20rem] text-balance font-serif italic text-base leading-relaxed text-scent-muted sm:max-w-xl sm:text-lg">
      Explore the wardrobes our community actually wears, and find your next signature.
    </p>
  </section>
);
