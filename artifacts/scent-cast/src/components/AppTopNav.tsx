import React from 'react';
import { LogOut, Share2 } from 'lucide-react';
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

interface AppTopNavProps {
  authToken: string | null;
  authEmail?: string | null;
  authPictureUrl?: string | null;
  onSignIn: () => void;
  onShare: () => void;
  onSignOut: () => void;
}

const navBaseClassName =
  'text-[13px] sm:text-[14px] font-semibold uppercase tracking-[0.12em] min-[430px]:tracking-[0.16em] whitespace-nowrap';

const inactiveNavClassName = `${navBaseClassName} text-[#f4debd]/85 hover:text-white transition-colors`;
const activeNavClassName = `${navBaseClassName} text-scent-accent`;

const ActiveDot: React.FC = () => (
  <span aria-hidden="true" className="hidden sm:inline-block w-1 h-1 rounded-full bg-scent-accent mr-2 align-middle" />
);

const getAvatarFallback = (email?: string | null): string => {
  const trimmedEmail = email?.trim();
  if (!trimmedEmail) return 'SB';
  const localPart = trimmedEmail.split('@')[0]?.replace(/[^a-z0-9]/gi, '');
  return (localPart || trimmedEmail).slice(0, 2).toUpperCase();
};

interface MobileAccountMenuProps {
  authEmail?: string | null;
  authPictureUrl?: string | null;
  onShare: () => void;
  onSignOut: () => void;
}

const MobileAccountMenu: React.FC<MobileAccountMenuProps> = ({
  authEmail,
  authPictureUrl,
  onShare,
  onSignOut,
}) => (
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
            {getAvatarFallback(authEmail)}
          </AvatarFallback>
        </Avatar>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      align="start"
      sideOffset={10}
      className="w-52 rounded-[8px] border-scent-accent/25 bg-[#090604]/95 p-1.5 text-[#fff7ec] shadow-[0_18px_48px_rgba(0,0,0,0.62)] backdrop-blur-sm"
    >
      {authEmail ? (
        <>
          <DropdownMenuLabel className="px-3 py-2 text-[13px] font-semibold uppercase tracking-[0.12em] text-scent-text-muted">
            {authEmail}
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="bg-scent-accent/15" />
        </>
      ) : null}
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

export const AppTopNav: React.FC<AppTopNavProps> = ({
  authToken,
  authEmail,
  authPictureUrl,
  onSignIn,
  onShare,
  onSignOut,
}) => {
  const { pathname } = useLocation();
  const isHomeRoute = pathname === '/';

  const authControl = authToken ? (
    <>
      <div className="sm:hidden">
        <MobileAccountMenu
          authEmail={authEmail}
          authPictureUrl={authPictureUrl}
          onShare={onShare}
          onSignOut={onSignOut}
        />
      </div>
      <button type="button" onClick={onShare} className={`${inactiveNavClassName} hidden sm:inline-flex`}>
        Share
      </button>
    </>
  ) : (
    <button type="button" onClick={onSignIn} className={inactiveNavClassName}>
      Sign In
    </button>
  );

  return (
    <nav className="scent-topbar fixed top-0 left-0 right-0 z-50 px-3 sm:px-8">
      <div className="max-w-[1760px] mx-auto h-full grid grid-cols-[minmax(84px,1fr)_auto_minmax(84px,1fr)] sm:grid-cols-[1fr_auto_1fr] items-center">
        <div className="flex min-w-0 items-center gap-4 sm:gap-6 justify-self-start">
          {authControl}
          {!isHomeRoute ? (
            <div className="hidden sm:flex items-center gap-6">
              <span className="w-px h-3 bg-scent-accent/20 shrink-0" aria-hidden="true" />
              <Link to="/" className={inactiveNavClassName}>
                Home
              </Link>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-center px-2 sm:px-10">
          <h1 className="leading-none">
            <Link to="/" aria-label="Go to home" className="block">
              <img
                src="/nav/scentbeam-nav-logo.png"
                srcSet="/nav/scentbeam-nav-logo.png 1x, /nav/scentbeam-nav-logo@2x.png 2x"
                alt="ScentBeam"
                className="h-8 w-auto max-w-[118px] object-contain min-[430px]:h-9 min-[430px]:max-w-[138px] sm:h-12 sm:max-w-none"
                draggable={false}
              />
            </Link>
          </h1>
        </div>

        <div className="flex min-w-0 items-center gap-4 sm:gap-6 justify-self-end">
          <NavLink
            to="/community"
            className={({ isActive }) =>
              isActive ? `${activeNavClassName} hidden sm:inline-flex` : inactiveNavClassName
            }
          >
            {({ isActive }) => (
              <>
                {isActive ? <ActiveDot /> : null}
                Community
              </>
            )}
          </NavLink>
          {authToken ? (
            <button type="button" onClick={onSignOut} className={`${inactiveNavClassName} hidden sm:inline-flex`}>
              Sign Out
            </button>
          ) : null}
        </div>
      </div>
    </nav>
  );
};
