import React from 'react';
import { Wind } from 'lucide-react';
import { APP_BRAND_MARK } from '@/lib/appBrand';

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
      <div className="max-w-[1760px] mx-auto h-full relative flex items-center justify-center">
        <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center gap-2 sm:gap-4">
          {authControl}
          {currentRoute !== 'home' ? (
            <>
              <span className="w-px h-3 bg-scent-accent/20 mx-0.5 sm:mx-1" aria-hidden="true" />
              <a href="/" className={inactiveNavClassName}>
                Home
              </a>
            </>
          ) : null}
        </div>

        <div className="flex items-center gap-2 sm:gap-3 pointer-events-none">
          <Wind
            strokeWidth={1.25}
            className="w-[19.8px] h-[19.8px] sm:w-[22px] sm:h-[22px] text-scent-accent drop-shadow-[0_0_10px_rgba(201,139,44,0.22)]"
          />
          <h1 className="scent-brandmark font-serif text-[1.125rem] sm:text-3xl tracking-[0.14em] uppercase">{APP_BRAND_MARK}</h1>
        </div>

        <div className="absolute right-0 top-1/2 -translate-y-1/2 flex items-center gap-2 sm:gap-4 justify-end">
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
