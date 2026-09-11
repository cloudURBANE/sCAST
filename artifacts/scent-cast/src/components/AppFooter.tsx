import React from "react";
import { Link } from "react-router";
import { APP_BRAND_MARK } from "@/lib/appBrand";
import { openConsentManager } from "@/lib/consent";

// Shared site footer. Carries the wordmark plus the trust/legal links every
// production app needs reachable from anywhere — Privacy, Terms, Cookie Policy —
// and a "Cookie preferences" control that re-opens the consent manager after the
// first-visit banner is gone. Home keeps mobile navigation in the bottom bar
// and shows exploration links in the footer on desktop.

const legalLinks = [
  { to: "/billing", label: "Billing" },
  { to: "/privacy", label: "Privacy" },
  { to: "/terms", label: "Terms" },
  { to: "/cookies", label: "Cookie Policy" },
];

// min-h + flex centering give each legal link a ~44px touch target (they were
// bare ~16px line boxes, easy to mis-tap); the visual text treatment is
// unchanged and the extra height is absorbed by the footer's generous padding.
const linkClassName =
  "inline-flex min-h-11 items-center text-[11px] font-semibold uppercase tracking-[0.18em] text-scent-text-subtle transition-colors hover:text-scent-accent active:text-scent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55 rounded-sm";

export const AppFooter: React.FC<{
  className?: string;
  showExploreLinks?: boolean;
}> = ({ className = "", showExploreLinks = false }) => {
  const footerLinkClassName = showExploreLinks
    ? "inline-flex min-h-11 items-center rounded-sm text-xs text-scent-text-subtle transition-colors hover:text-scent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55"
    : linkClassName;

  return (
    <footer
      className={`relative z-10 border-t border-scent-accent/10 px-6 ${showExploreLinks ? "bg-scent-surface/20 py-6 sm:py-8" : "py-14"} ${className}`.trim()}
    >
      <div className="mx-auto max-w-6xl">
        <div
          className={`flex flex-col gap-4 ${showExploreLinks ? "pb-4 sm:flex-row sm:items-center sm:justify-between sm:gap-8 sm:pb-5" : "items-center pb-8 text-center"}`}
        >
          <div className={showExploreLinks ? "max-w-sm" : ""}>
            <Link
              to="/"
              aria-label="Go to home"
              className="inline-flex min-h-11 items-center rounded-sm transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55"
            >
              <img
                src="/nav/scentbeam-nav-logo-640x188.png"
                width={640}
                height={188}
                alt={APP_BRAND_MARK}
                className={`${showExploreLinks ? "w-[150px] sm:w-[180px]" : "w-[200px]"} h-auto max-w-full object-contain`}
                draggable={false}
              />
            </Link>

          </div>
          {showExploreLinks ? (
            <div className="hidden md:block">
              <p className="scent-type-label mb-2 text-scent-accent">
                Explore ScentBeam
              </p>
              <nav
                aria-label="Explore ScentBeam"
                className="flex flex-wrap gap-x-6 gap-y-1"
              >
                <Link to="/" className={footerLinkClassName}>
                  Home
                </Link>
                <Link to="/arena" className={footerLinkClassName}>
                  Arena
                </Link>
                <Link to="/community" className={footerLinkClassName}>
                  Community
                </Link>
              </nav>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 border-t border-scent-accent/10 pt-3 lg:flex-row lg:items-center lg:justify-between">
          <nav
            aria-label="Legal"
            className={`flex flex-wrap items-center gap-x-5 gap-y-1 ${showExploreLinks ? "" : "justify-center"}`}
          >
            {legalLinks.map((link) => (
              <Link key={link.to} to={link.to} className={footerLinkClassName}>
                {link.label}
              </Link>
            ))}
            <button
              type="button"
              onClick={() => openConsentManager()}
              className={footerLinkClassName}
            >
              Cookie preferences
            </button>
          </nav>

          <p className="text-[11px] leading-5 text-scent-text-subtle">
            © {new Date().getFullYear()} Olfactory Intelligence Systems
          </p>
        </div>
      </div>
    </footer>
  );
};
