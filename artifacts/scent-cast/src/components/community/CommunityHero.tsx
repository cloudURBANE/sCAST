import React from 'react';

export const CommunityHero: React.FC = () => (
  <section className="scent-hero-zone scent-night-panel mx-auto w-full max-w-[940px] overflow-hidden rounded-[calc(var(--radius-scent)-2px)] border border-scent-accent/55 bg-[#050403] px-4 py-3.5 text-center sm:rounded-[calc(var(--radius-scent)+6px)] sm:px-10 sm:py-7 lg:px-16 lg:py-8">
    <div className="mx-auto flex max-w-[17rem] items-center justify-center gap-3 sm:max-w-[34rem] sm:gap-6">
      <span
        className="h-px flex-1 bg-scent-accent/55"
        aria-hidden="true"
      />
      <span className="shrink-0 scent-type-label text-[0.6875rem] text-scent-accent sm:text-[0.72rem]">
        Fragrance Community
      </span>
      <span
        className="h-px flex-1 bg-scent-accent/55"
        aria-hidden="true"
      />
    </div>

    {/* Page title: the only h1 on the desktop document (the top-nav brand h1 is
        md:hidden), matching the legal / not-found / arena page-title pattern. */}
    <h1 className="mx-auto mt-2.5 max-w-[19rem] text-balance font-serif text-[clamp(1.4rem,6.5vw,1.75rem)] leading-none tracking-normal text-[#fff7ec] sm:mt-4 sm:max-w-[52rem] sm:text-[clamp(2.5rem,5.4vw,4.35rem)] sm:leading-[1.02]">
      See what the <span className="italic text-scent-accent">community</span> is wearing.
    </h1>

    <p className="mx-auto mt-2.5 max-w-[18rem] text-balance text-[0.72rem] leading-4 text-scent-text-muted/90 sm:mt-4 sm:max-w-[40rem] sm:text-lg sm:leading-relaxed">
      Share rotations, compare bottles, and trade notes.
    </p>
  </section>
);
