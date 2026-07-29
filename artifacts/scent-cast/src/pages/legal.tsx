import React from "react";
import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";

import { SEO } from "@/components/SEO";
import { AppFooter } from "@/components/AppFooter";
import { APP_BRAND_MARK } from "@/lib/appBrand";
import { openConsentManager } from "@/lib/consent";

// ---------------------------------------------------------------------------
// NOTE FOR THE TEAM: this is honest, production-styled placeholder copy that
// describes what the app actually does (Google sign-in, local session token,
// optional weather/location, optional push, optional performance analytics,
// third-party fragrance data, affiliate links). It intentionally makes NO
// regulatory/compliance guarantees and no data-sale claims. Have counsel review
// and adjust the specifics (entity name, jurisdiction, contact, retention) before
// relying on it. Swapping the copy requires no structural changes.
// ---------------------------------------------------------------------------

const LAST_UPDATED = "June 21, 2026";
const CONTACT_EMAIL = "privacy@scentbeam.com";

function LegalLayout({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <main className="relative z-10 min-h-[100svh] w-full text-foreground">
      <div className="mx-auto w-full max-w-3xl px-6 pt-[calc(var(--topbar-h)+1.5rem)] pb-20 sm:px-8">
        <div className="flex items-center justify-between">
          <Link to="/" aria-label="Go to home" className="inline-flex opacity-80 transition-opacity hover:opacity-100">
            <img
              src="/nav/scentbeam-nav-logo.png"
              srcSet="/nav/scentbeam-nav-logo.png 1x, /nav/scentbeam-nav-logo@2x.png 2x"
              alt={APP_BRAND_MARK}
              className="h-8 w-auto object-contain"
              draggable={false}
            />
          </Link>
          <Link
            to="/"
            className="inline-flex min-h-10 items-center gap-2 rounded-full px-3 text-[10px] font-bold uppercase tracking-[0.2em] text-scent-text-subtle transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Home
          </Link>
        </div>

        <header className="mt-12 border-b border-scent-accent/12 pb-8">
          <p className="scent-type-label text-scent-accent/80">{eyebrow}</p>
          <h1 className="mt-3 font-serif text-4xl italic leading-tight text-foreground sm:text-5xl">
            {title}
          </h1>
          <p className="mt-5 max-w-2xl text-[15px] leading-7 text-scent-text-muted">{intro}</p>
          <p className="mt-5 text-[11px] uppercase tracking-[0.18em] text-scent-text-subtle/80">
            Last updated · {LAST_UPDATED}
          </p>
        </header>

        <div className="mt-10 space-y-9">{children}</div>
      </div>

      <AppFooter />
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-[12px] font-bold uppercase tracking-[0.22em] text-scent-accent/85">{title}</h2>
      <div className="mt-3 space-y-3 text-[14px] leading-7 text-scent-text-muted">{children}</div>
    </section>
  );
}

function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li key={index} className="flex gap-2.5">
          <span aria-hidden="true" className="mt-2.5 h-1 w-1 shrink-0 rounded-full bg-scent-accent/70" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

const inlineLink = "text-scent-accent underline-offset-2 hover:underline";

export function PrivacyPage() {
  return (
    <>
      <SEO
        title="Privacy Policy | ScentBeam"
        description="How ScentBeam collects, uses, and protects your information."
        url="https://scentbeam.com/privacy"
      />
      <LegalLayout
        eyebrow="Trust & Privacy"
        title="Privacy Policy"
        intro="ScentBeam helps you build a fragrance wardrobe and get scent recommendations. This policy explains what we collect, why, and the choices you have. We keep it to what the product actually does — nothing more."
      >
        <Section title="Information we collect">
          <Bullets
            items={[
              "Account details from Google sign-in: your email address, name, and profile picture. We use Google solely to authenticate you — we never see your Google password.",
              "Your wardrobe and preferences: the fragrances, notes, and settings you save while using ScentBeam.",
              "Approximate location: only when you grant permission, and only to fetch local weather for recommendations. You can decline or revoke it in your browser.",
              "Notification subscription: only if you choose to enable push notifications.",
              "Performance data: anonymous speed and stability measurements, collected only if you opt into analytics in your cookie preferences.",
            ]}
          />
        </Section>

        <Section title="How we use your information">
          <Bullets
            items={[
              "To provide the service: save your wardrobe, sign you in, and generate recommendations.",
              "To personalize suggestions using your saved scents and, when available, local weather.",
              "To deliver notifications you have explicitly opted into.",
              "To improve performance and reliability, where you have allowed analytics.",
            ]}
          />
          <p>We do not sell your personal information, and we do not use it for advertising or cross-site tracking.</p>
        </Section>

        <Section title="Storage and security">
          <p>
            When you sign in, an opaque session token is stored in your browser's local storage to keep
            you logged in. Your wardrobe and account data are stored with our hosting and database
            providers. We take reasonable measures to protect your information, though no online service
            can guarantee absolute security.
          </p>
        </Section>

        <Section title="Third parties we rely on">
          <p>We share the minimum necessary with service providers that help us run ScentBeam:</p>
          <Bullets
            items={[
              "Google — sign-in and authentication.",
              "A weather data provider — local conditions for recommendations.",
              "Fragrance reference sources — scent profiles, notes, and details shown in the app.",
              "Image processing and storage providers — to prepare and serve bottle imagery.",
              "Affiliate partners — some product links are affiliate links; see our Terms for details.",
            ]}
          />
        </Section>

        <Section title="Cookies and local storage">
          <p>
            We use a small amount of essential browser storage to run the app, plus optional performance
            analytics. Full detail and controls live in our{" "}
            <Link to="/cookies" className={inlineLink}>
              Cookie Policy
            </Link>
            .
          </p>
        </Section>

        <Section title="Your choices">
          <Bullets
            items={[
              "Sign out at any time to clear your local session.",
              <>
                Manage analytics consent whenever you like via{" "}
                <button type="button" onClick={() => openConsentManager()} className={inlineLink}>
                  Cookie Preferences
                </button>
                .
              </>,
              "Turn notifications on or off from your device and the app's notification settings.",
              <>
                Request access to or deletion of your account data by contacting us at{" "}
                <a href={`mailto:${CONTACT_EMAIL}`} className={inlineLink}>
                  {CONTACT_EMAIL}
                </a>
                .
              </>,
            ]}
          />
        </Section>

        <Section title="Children">
          <p>ScentBeam is intended for adults and is not directed to children under 13.</p>
        </Section>

        <Section title="Changes to this policy">
          <p>
            We may update this policy as the product evolves. Material changes will be reflected by the
            "Last updated" date above.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Questions about privacy? Reach us at{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className={inlineLink}>
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </Section>
      </LegalLayout>
    </>
  );
}

export function TermsPage() {
  return (
    <>
      <SEO
        title="Terms of Service | ScentBeam"
        description="The terms that govern your use of ScentBeam."
        url="https://scentbeam.com/terms"
      />
      <LegalLayout
        eyebrow="Trust & Legal"
        title="Terms of Service"
        intro="These terms govern your use of ScentBeam. By using the app you agree to them. We've written them to be readable rather than dense."
      >
        <Section title="Using ScentBeam">
          <p>
            ScentBeam provides fragrance discovery, a personal wardrobe, and scent recommendations. You
            may use it for your own personal, non-commercial purposes. Please don't misuse the service,
            attempt to disrupt it, or access it in ways the app doesn't intend.
          </p>
        </Section>

        <Section title="Your account">
          <p>
            You sign in with Google. You're responsible for activity under your account and for keeping
            access to your Google account secure. You can stop using ScentBeam at any time.
          </p>
        </Section>

        <Section title="Recommendations are informational">
          <p>
            Scent recommendations, weather context, and fragrance details are provided for general,
            informational purposes. They're suggestions to help you choose — not professional advice —
            and individual experiences with any fragrance will vary.
          </p>
        </Section>

        <Section title="Third-party fragrance data">
          <p>
            Fragrance profiles, notes, and imagery are drawn from third-party and community sources. This
            information may be incomplete or inaccurate, and we present it as-is without warranty as to
            its accuracy.
          </p>
        </Section>

        <Section title="Affiliate links">
          <p>
            Some links to products are affiliate links, which means we may earn a commission if you make
            a purchase. This is at no extra cost to you and never changes the recommendations we show.
          </p>
        </Section>

        <Section title="Intellectual property">
          <p>
            The ScentBeam name, design, and software are owned by us or our licensors. The content you add
            (such as your wardrobe) remains yours; you grant us the permission needed to operate the
            service for you.
          </p>
        </Section>

        <Section title="Service provided “as is”">
          <p>
            ScentBeam is provided on an "as is" and "as available" basis. To the fullest extent permitted
            by law, we disclaim warranties of any kind and are not liable for indirect or incidental
            damages arising from your use of the service.
          </p>
        </Section>

        <Section title="Changes">
          <p>
            We may update these terms as the product changes. Continued use after an update means you
            accept the revised terms.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Questions about these terms? Reach us at{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className={inlineLink}>
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </Section>
      </LegalLayout>
    </>
  );
}

export function CookiePolicyPage() {
  return (
    <>
      <SEO
        title="Cookie Policy | ScentBeam"
        description="How ScentBeam uses cookies and local storage, and how to control them."
        url="https://scentbeam.com/cookies"
      />
      <LegalLayout
        eyebrow="Trust & Privacy"
        title="Cookie Policy"
        intro="ScentBeam keeps cookies and browser storage to a minimum. We use essential storage to run the app, plus optional performance analytics — and nothing for advertising or cross-site tracking."
      >
        <Section title="Essential storage">
          <p>Always on, because the app can't work without it:</p>
          <Bullets
            items={[
              "Session token — keeps you signed in after Google authentication.",
              "Preferences — remembers choices like your wardrobe view and dismissed prompts.",
              "Consent record — remembers the cookie choice you make here.",
            ]}
          />
        </Section>

        <Section title="Performance analytics (optional)">
          <p>
            Only active if you opt in. We collect anonymous Core Web Vitals — page speed and stability
            metrics — to find and fix slow spots. There are no advertising cookies, no cross-site
            trackers, and no personal profiles.
          </p>
        </Section>

        <Section title="Managing your choice">
          <p>
            You're in control and can change your mind at any time. Opening preferences won't sign you
            out or affect your wardrobe.
          </p>
          <div className="pt-1">
            <button
              type="button"
              onClick={() => openConsentManager()}
              className="scent-primary-button inline-flex min-h-11 items-center justify-center rounded-full px-6 text-[11px] font-bold uppercase tracking-[0.16em]"
            >
              <span>Manage cookie preferences</span>
            </button>
          </div>
        </Section>

        <Section title="More information">
          <p>
            For the wider picture of how we handle your data, see our{" "}
            <Link to="/privacy" className={inlineLink}>
              Privacy Policy
            </Link>
            .
          </p>
        </Section>
      </LegalLayout>
    </>
  );
}
