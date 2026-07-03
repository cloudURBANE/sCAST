import { Compass, Home } from 'lucide-react';
import { Link } from 'react-router-dom';
import { APP_BRAND_MARK } from '@/lib/appBrand';

export default function NotFound() {
  return (
    <main className="relative z-10 flex min-h-[100svh] w-full items-center justify-center px-6 py-20 text-foreground">
      <section className="mx-auto flex w-full max-w-2xl flex-col items-center text-center">
        <img
          src="/nav/scentbeam-nav-logo.png"
          srcSet="/nav/scentbeam-nav-logo.png 1x, /nav/scentbeam-nav-logo@2x.png 2x"
          alt={APP_BRAND_MARK}
          className="h-12 w-auto object-contain opacity-90"
          draggable={false}
        />
        {/* No projected gold glow off the disc (owner-rejected site-wide) — a
            subtle inset highlight carries the depth instead. */}
        <div className="mt-12 flex h-16 w-16 items-center justify-center rounded-full border border-scent-accent/25 bg-black/35 text-scent-accent shadow-[inset_0_1px_0_rgba(255,236,183,0.12)]">
          <Compass size={28} aria-hidden="true" />
        </div>
        <p className="mt-8 text-[10px] font-bold uppercase tracking-[0.42em] text-scent-accent/80">404</p>
        <h1 className="mt-4 font-serif text-4xl italic leading-tight text-foreground sm:text-6xl">
          This trail has gone cold.
        </h1>
        <p className="mt-5 max-w-md text-sm leading-7 text-scent-text-muted sm:text-base">
          The vault you requested is not available here. Return to your wardrobe or browse the community cases.
        </p>
        <div className="mt-10 flex w-full max-w-sm flex-col gap-3 sm:flex-row sm:justify-center">
          <Link to="/" className="scent-primary-button inline-flex min-h-12 items-center justify-center gap-2 rounded-[var(--radius-scent)] px-6">
            <Home size={16} aria-hidden="true" />
            Home
          </Link>
          <Link
            to="/community"
            className="inline-flex min-h-12 items-center justify-center rounded-[var(--radius-scent)] border border-scent-text-subtle/25 px-6 text-[10px] font-bold uppercase tracking-[0.28em] text-scent-text-muted transition-colors hover:border-scent-accent/45 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
          >
            Community
          </Link>
        </div>
      </section>
    </main>
  );
}
