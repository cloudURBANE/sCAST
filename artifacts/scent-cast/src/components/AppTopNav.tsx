import React from 'react';
import { Wind } from 'lucide-react';
import { APP_BRAND_MARK, APP_BRAND_MARK_SHORT } from '@/lib/appBrand';

type AppRoute = 'home' | 'community';

interface AppTopNavProps {
  authToken: string | null;
  onSignIn: () => void;
  onShare: () => void;
  onSignOut: () => void;
  currentRoute: AppRoute;
}

const inactiveNavClassName =
  'text-[10px] sm:text-[13px] font-medium uppercase tracking-[0.22em] text-[#f4debd]/85 hover:text-white transition-colors whitespace-nowrap';

const activeNavClassName =
  'text-[11px] sm:text-[13px] font-medium uppercase tracking-[0.22em] text-scent-accent whitespace-nowrap';

const ActiveDot: React.FC = () => (
  <span aria-hidden="true" className="inline-block w-1 h-1 rounded-full bg-scent-accent mr-2 align-middle" />
);

export const AppTopNav: React.FC<AppTopNavProps> = ({
  authToken,
  onSignIn,
  onShare,
  onSignOut,
  currentRoute,
}) => {
  const authControl = authToken ? (
    <button type="button" onClick={onShare} className={inactiveNavClassName}>
      Share
    </button>
  ) : (
    <button type="button" onClick={onSignIn} className={inactiveNavClassName}>
      Sign In
    </button>
  );

  return (
    <nav className="scent-topbar fixed top-0 left-0 right-0 h-16 sm:h-[72px] z-50 px-3 sm:px-8">
      <div className="relative max-w-[1760px] mx-auto h-full flex items-center">
        {/* Left controls — flow from the left edge. */}
        <div className="flex shrink-0 items-center gap-2 sm:gap-4">
          {authControl}
          {currentRoute !== 'home' ? (
            <>
              <span className="w-px h-3 bg-scent-accent/20 mx-0.5 sm:mx-1 shrink-0" aria-hidden="true" />
              <a href="/" className={inactiveNavClassName}>
                Home
              </a>
            </>
          ) : null}
        </div>

        {/* Brandmark — absolutely pinned to the true center of the bar so it
            stays dead-center regardless of how wide the side controls are. */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-2 sm:gap-3">
          <Wind
            strokeWidth={1.25}
            className="w-[26px] h-[26px] sm:w-9 sm:h-9 shrink-0 text-scent-accent drop-shadow-[0_0_12px_rgba(201,139,44,0.26)]"
          />
          <h1 className="scent-brandmark font-serif text-[1.3rem] sm:text-[2rem] leading-none tracking-[0.14em] uppercase whitespace-nowrap">
            <span className="sm:hidden">{APP_BRAND_MARK_SHORT}</span>
            <span className="hidden sm:inline">{APP_BRAND_MARK}</span>
          </h1>
        </div>

        {/* Right controls — pushed to the right edge. */}
        <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-4 justify-end">
          {currentRoute === 'community' ? (
            <span className={activeNavClassName}>
              <ActiveDot />
              Community
            </span>
          ) : (
            <a href="/community" className={inactiveNavClassName}>
              Community
            </a>
          )}
          {authToken ? (
            <button type="button" onClick={onSignOut} className={inactiveNavClassName}>
              Sign Out
            </button>
          ) : null}
        </div>
      </div>
    </nav>
  );
};
