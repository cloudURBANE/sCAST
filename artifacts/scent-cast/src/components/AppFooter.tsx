import React from "react";
import { Link } from "react-router-dom";
import { APP_BRAND_MARK } from "@/lib/appBrand";
import { openConsentManager } from "@/lib/consent";

// Shared site footer. Carries the wordmark plus the trust/legal links every
// production app needs reachable from anywhere — Privacy, Terms, Cookie Policy —
// and a "Cookie preferences" control that re-opens the consent manager after the
// first-visit banner is gone. Extends the original home-page footer treatment
// (faint centered logo + copyright) rather than introducing a new visual style.

const legalLinks = [
  { to: "/privacy", label: "Privacy" },
  { to: "/terms", label: "Terms" },
  { to: "/cookies", label: "Cookie Policy" },
];

// min-h + flex centering give each legal link a ~44px touch target (they were
// bare ~16px line boxes, easy to mis-tap); the visual text treatment is
// unchanged and the extra height is absorbed by the footer's generous padding.
const linkClassName =
  "inline-flex min-h-11 items-center text-[11px] font-semibold uppercase tracking-[0.18em] text-scent-text-subtle transition-colors hover:text-scent-accent active:text-scent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55 rounded-sm";

export const AppFooter: React.FC<{ className?: string }> = ({ className = "" }) => {
  return (
    <footer
      className={`relative z-10 border-t border-scent-accent/10 px-6 py-14 ${className}`.trim()}
    >
      <div className="mx-auto flex max-w-[1400px] flex-col items-center gap-6 text-center">
        <Link
          to="/"
          aria-label="Go to home"
          className="inline-flex rounded-sm opacity-40 transition-opacity hover:opacity-70 focus-visible:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55"
        >
          <img
            src="/nav/scentbeam-nav-logo.png"
            srcSet="/nav/scentbeam-nav-logo.png 1x, /nav/scentbeam-nav-logo@2x.png 2x"
            alt={APP_BRAND_MARK}
            className="h-5 w-auto object-contain"
            draggable={false}
          />
        </Link>

        <nav
          aria-label="Legal"
          className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2.5"
        >
          {legalLinks.map((link) => (
            <Link key={link.to} to={link.to} className={linkClassName}>
              {link.label}
            </Link>
          ))}
          <button type="button" onClick={() => openConsentManager()} className={linkClassName}>
            Cookie Preferences
          </button>
        </nav>

        <p className="scent-type-label text-scent-text-subtle/70">
          © {new Date().getFullYear()} Olfactory Intelligence Systems
        </p>
      </div>
    </footer>
  );
};
