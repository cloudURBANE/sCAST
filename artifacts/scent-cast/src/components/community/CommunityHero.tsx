import React from 'react';

export const CommunityHero: React.FC = () => (
  <section className="scent-hero-zone mx-auto w-full max-w-[940px] overflow-hidden rounded-[22px] border border-scent-accent/70 bg-[radial-gradient(85%_110%_at_50%_0%,rgba(212,175,55,0.055),transparent_62%),linear-gradient(180deg,rgba(9,8,6,0.96),rgba(0,0,0,0.985))] px-4 py-6 text-center shadow-[0_26px_70px_-52px_rgba(212,175,55,0.5),inset_0_1px_0_rgba(255,236,183,0.08)] sm:rounded-[28px] sm:px-10 sm:py-14 lg:px-16 lg:py-16">
    <div className="mx-auto flex max-w-[18rem] items-center justify-center gap-3 sm:max-w-[34rem] sm:gap-6">
      <span
        className="h-px flex-1 bg-gradient-to-r from-transparent to-scent-accent/85"
        aria-hidden="true"
      />
      <span className="shrink-0 scent-type-label text-[0.56rem] text-scent-accent sm:text-[0.72rem]">
        Fragrance Community
      </span>
      <span
        className="h-px flex-1 bg-gradient-to-l from-transparent to-scent-accent/85"
        aria-hidden="true"
      />
    </div>

    <h2 className="mx-auto mt-3 max-w-[20rem] text-balance font-serif text-[clamp(1.65rem,7.4vw,2rem)] leading-[1.02] tracking-normal text-[#fff7ec] sm:mt-7 sm:max-w-[52rem] sm:text-[clamp(2.5rem,5.4vw,4.35rem)]">
      See what the <span className="italic text-scent-accent">community</span> is wearing.
    </h2>

    <p className="mx-auto mt-3 max-w-[19rem] text-balance text-[0.78rem] leading-5 text-scent-text-muted/90 sm:mt-7 sm:max-w-[40rem] sm:text-lg sm:leading-relaxed">
      Share rotations, compare bottles, and trade notes.
    </p>
  </section>
);
