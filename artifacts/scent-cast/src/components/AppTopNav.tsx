import React from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';

interface AppTopNavProps {
  authToken: string | null;
  onSignIn: () => void;
  onShare: () => void;
  onSignOut: () => void;
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
}) => {
  const { pathname } = useLocation();
  const isHomeRoute = pathname === '/';

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
      {/* Symmetric 3-column grid: equal 1fr side columns keep the brandmark
          column mathematically centered; each control group is centered
          within its own third so the bar reads as three evenly spaced zones. */}
      <div className="max-w-[1760px] mx-auto h-full grid grid-cols-[1fr_auto_1fr] items-center">
        {/* Left controls — centered within the left third. */}
        <div className="flex min-w-0 items-center gap-3 sm:gap-6 justify-self-center">
          {authControl}
          {!isHomeRoute ? (
            <>
              <span className="w-px h-3 bg-scent-accent/20 shrink-0" aria-hidden="true" />
              <Link to="/" className={inactiveNavClassName}>
                Home
              </Link>
            </>
          ) : null}
        </div>

        {/* Brandmark — its own center column, so side controls can never
            crowd it. Horizontal padding guarantees clear space on both sides. */}
        <div className="flex items-center justify-center px-4 sm:px-10">
          <h1>
            <img
              src="/nav/scentbeam-nav-logo.png"
              srcSet="/nav/scentbeam-nav-logo.png 1x, /nav/scentbeam-nav-logo@2x.png 2x"
              alt="ScentBeam"
              className="h-10 sm:h-12 w-auto"
              draggable={false}
            />
          </h1>
        </div>

        {/* Right controls — centered within the right third, same gap as left. */}
        <div className="flex min-w-0 items-center gap-3 sm:gap-6 justify-self-center">
          <NavLink
            to="/community"
            className={({ isActive }) => (isActive ? activeNavClassName : inactiveNavClassName)}
          >
            {({ isActive }) => (
              <>
                {isActive ? <ActiveDot /> : null}
                Community
              </>
            )}
          </NavLink>
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
