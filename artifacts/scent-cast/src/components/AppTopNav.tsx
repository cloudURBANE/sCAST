import React from 'react';
import { LogOut, Settings, Share2 } from 'lucide-react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { isIpadSafariPerformanceMode } from '@/lib/platform';

interface AppTopNavProps {
  authToken: string | null;
  authEmail?: string | null;
  authPictureUrl?: string | null;
  authUsername?: string | null;
  renderedRoute?: 'home' | 'community' | 'arena';
  onSignIn: () => void;
  onShare: () => void;
  onSignOut: () => void;
  onEditProfile: () => void;
}

const navBaseClassName =
  'text-[11px] min-[390px]:text-[11.5px] sm:text-[14px] font-semibold uppercase tracking-[0.055em] min-[430px]:tracking-[0.09em] sm:tracking-[0.16em] whitespace-nowrap';

const topLevelNavClassName =
  'inline-flex min-h-[44px] items-center justify-center rounded-full px-1.5 min-[390px]:px-2 sm:px-0';
const inactiveNavClassName = `${navBaseClassName} ${topLevelNavClassName} text-[#f4debd]/85 hover:text-white transition-colors`;
const activeNavClassName = `${navBaseClassName} ${topLevelNavClassName} text-[#fff7ec]`;

const ActiveDot: React.FC = () => (
  <span
    aria-hidden="true"
    className="hidden h-1.5 w-1.5 shrink-0 rounded-full bg-scent-accent/75 shadow-[0_0_10px_rgba(212,175,55,0.34)] sm:block"
  />
);

const getAvatarFallback = (username?: string | null, email?: string | null): string => {
  const source = username?.trim() || email?.trim();
  if (!source) return 'SB';
  const localPart = source.includes('@') ? source.split('@')[0] : source;
  const compact = localPart?.replace(/[^a-z0-9]/gi, '');
  return (compact || source).slice(0, 2).toUpperCase();
};

interface AccountMenuProps {
  authEmail?: string | null;
  authPictureUrl?: string | null;
  authUsername?: string | null;
  onShare: () => void;
  onSignOut: () => void;
  onEditProfile: () => void;
}

// The single account control across all breakpoints: tapping the Google avatar
// opens profile (username), share, and sign-out. Consolidating these under the
// avatar keeps account actions in one predictable place instead of scattered
// text links.
const AccountMenu: React.FC<AccountMenuProps> = ({
  authEmail,
  authPictureUrl,
  authUsername,
  onShare,
  onSignOut,
  onEditProfile,
}) => {
  const displayName = authUsername?.trim() || authEmail || null;
  const ipadSafariPerformanceMode = React.useRef(isIpadSafariPerformanceMode()).current;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-10 w-10 items-center justify-center rounded-full border border-scent-accent/35 bg-black/35 shadow-[0_0_18px_rgba(212,175,55,0.12)] transition-colors hover:border-scent-accent/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55"
          aria-label="Open account menu"
        >
          <Avatar className="h-9 w-9 border border-white/10 bg-scent-surface">
            {authPictureUrl ? (
              <AvatarImage src={authPictureUrl} alt="" referrerPolicy="no-referrer" />
            ) : null}
            <AvatarFallback className="bg-scent-surface text-[13px] font-semibold text-scent-accent">
              {getAvatarFallback(authUsername, authEmail)}
            </AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={10}
        className={`w-56 rounded-[8px] border-scent-accent/25 bg-[#090604]/95 p-1.5 text-[#fff7ec] shadow-[0_18px_48px_rgba(0,0,0,0.62)]${ipadSafariPerformanceMode ? '' : ' backdrop-blur-sm'}`}
      >
        {displayName ? (
          <>
            <DropdownMenuLabel className="px-3 py-2 text-[13px] font-semibold normal-case tracking-[0.04em] text-scent-text-muted">
              <span className="block truncate">{displayName}</span>
              {authUsername?.trim() && authEmail ? (
                <span className="mt-0.5 block truncate text-[11px] font-normal tracking-normal text-scent-text-subtle">
                  {authEmail}
                </span>
              ) : null}
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="bg-scent-accent/15" />
          </>
        ) : null}
        <DropdownMenuItem
          className="cursor-pointer rounded-[6px] px-3 py-2.5 text-[13px] font-semibold uppercase tracking-[0.14em] text-[#f4debd] focus:bg-scent-accent/15 focus:text-white"
          onSelect={onEditProfile}
        >
          <Settings size={15} />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem
          className="cursor-pointer rounded-[6px] px-3 py-2.5 text-[13px] font-semibold uppercase tracking-[0.14em] text-[#f4debd] focus:bg-scent-accent/15 focus:text-white"
          onSelect={onShare}
        >
          <Share2 size={15} />
          Share
        </DropdownMenuItem>
        <DropdownMenuItem
          className="cursor-pointer rounded-[6px] px-3 py-2.5 text-[13px] font-semibold uppercase tracking-[0.14em] text-[#f4debd] focus:bg-scent-accent/15 focus:text-white"
          onSelect={onSignOut}
        >
          <LogOut size={15} />
          Sign Out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const AppTopNav: React.FC<AppTopNavProps> = ({
  authToken,
  authEmail,
  authPictureUrl,
  authUsername,
  renderedRoute,
  onSignIn,
  onShare,
  onSignOut,
  onEditProfile,
}) => {
  const { pathname } = useLocation();
  const isHomeRoute = renderedRoute ? renderedRoute === 'home' : pathname === '/';

  const authControl = authToken ? (
    <AccountMenu
      authEmail={authEmail}
      authPictureUrl={authPictureUrl}
      authUsername={authUsername}
      onShare={onShare}
      onSignOut={onSignOut}
      onEditProfile={onEditProfile}
    />
  ) : (
    <button type="button" onClick={onSignIn} className={inactiveNavClassName}>
      Sign In
    </button>
  );

  return (
    <nav className="scent-topbar fixed top-0 left-0 right-0 z-50 px-2.5 sm:px-8">
      <div className="max-w-[1760px] mx-auto h-full grid grid-cols-[minmax(76px,1fr)_auto_minmax(76px,1fr)] sm:grid-cols-[1fr_auto_1fr] items-center">
        <div className="flex min-w-0 items-center gap-2.5 min-[390px]:gap-3 sm:gap-6 justify-self-start">
          {authControl}
          {!isHomeRoute ? (
            <div className="flex items-center gap-1.5 min-[390px]:gap-2.5 sm:gap-6">
              <span className="hidden sm:block w-px h-3 bg-scent-accent/20 shrink-0" aria-hidden="true" />
              <Link
                to="/"
                className={`${inactiveNavClassName} relative z-10`}
              >
                Home
              </Link>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-center px-1 sm:px-10">
          <h1 className="leading-none">
            <Link to="/" aria-label="Go to home" className="block">
              <img
                src="/nav/scentbeam-nav-logo.png"
                srcSet="/nav/scentbeam-nav-logo.png 1x, /nav/scentbeam-nav-logo@2x.png 2x"
                alt="ScentBeam"
                className="h-8 w-auto max-w-[106px] object-contain min-[430px]:h-9 min-[430px]:max-w-[128px] sm:h-12 sm:max-w-none"
                decoding="async"
                draggable={false}
              />
            </Link>
          </h1>
        </div>

        <div className="flex min-w-0 items-center gap-1.5 min-[390px]:gap-2.5 sm:gap-6 justify-self-end">
          <NavLink
            to="/arena"
            className={({ isActive }) =>
              isActive
                ? `${activeNavClassName} gap-2`
                : inactiveNavClassName
            }
          >
            {({ isActive }) => (
              <>
                {isActive ? <ActiveDot /> : null}
                Arena
              </>
            )}
          </NavLink>
          <NavLink
            to="/community"
            className={({ isActive }) =>
              isActive
                ? `${activeNavClassName} gap-2`
                : inactiveNavClassName
            }
          >
            {({ isActive }) => (
              <>
                {isActive ? <ActiveDot /> : null}
                Community
              </>
            )}
          </NavLink>
        </div>
      </div>
    </nav>
  );
};
