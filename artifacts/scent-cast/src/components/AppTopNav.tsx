import React from 'react';
import { Home, LogOut, Settings, Share2, Swords, UsersRound } from 'lucide-react';
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
import { isIpadSafariPerformanceMode, isLowRenderBudget } from '@/lib/platform';

interface AppTopNavProps {
  authToken: string | null;
  authEmail?: string | null;
  authPictureUrl?: string | null;
  authUsername?: string | null;
  renderedRoute?: 'home' | 'community' | 'arena';
  // While the Beam Agent panel owns the screen, the global bottom nav pill is
  // suppressed so its fixed gold pill never sits over the panel's composer / CTA.
  // The panel carries its own exit (the header X), so navigation is not lost.
  agentActive?: boolean;
  onSignIn: () => void;
  onShare: () => void;
  onSignOut: () => void;
  onEditProfile: () => void;
}

// Below 360px (iPhone SE class) the logo + "Sign In" share a tight grid track,
// so the label scales down a notch and loosens its tracking only there; from
// 360px up it returns to the standard treatment used on every other breakpoint.
const navBaseClassName =
  'text-[11px] tracking-[0.10em] min-[360px]:text-[13px] min-[360px]:tracking-[0.16em] font-semibold uppercase whitespace-nowrap';

const topLevelNavClassName =
  'relative inline-flex min-h-[44px] items-center justify-center rounded-full px-2';
const inactiveNavClassName = `${navBaseClassName} ${topLevelNavClassName} text-[#f4debd]/85 hover:text-white transition-colors`;
const activeNavClassName = `${navBaseClassName} ${topLevelNavClassName} text-[#fff7ec]`;

const ActiveDot: React.FC = () => (
  <span
    aria-hidden="true"
    className="h-1.5 w-1.5 shrink-0 rounded-full bg-scent-accent/75 shadow-[0_0_10px_rgba(212,175,55,0.34)]"
  />
);

const navItems = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/arena', label: 'Arena', icon: Swords },
  { to: '/community', label: 'Community', icon: UsersRound },
];

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
          className="flex h-11 w-11 items-center justify-center rounded-full border border-scent-accent/35 bg-black/35 shadow-[0_0_18px_rgba(212,175,55,0.12)] transition-colors hover:border-scent-accent/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55"
          aria-label="Open account menu"
        >
          <Avatar className="h-10 w-10 border border-white/10 bg-scent-surface">
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
  agentActive = false,
  onSignIn,
  onShare,
  onSignOut,
  onEditProfile,
}) => {
  const location = useLocation();
  // Show-on-scroll-up bottom nav.
  //
  // The bar hides ONLY while the user is actively scrolling down (an
  // immersive gesture); it returns the instant they scroll up, tap, or the
  // scroll settles. This is deliberate: the old behavior auto-hid the bar
  // after a fixed idle timeout, which left it `pointer-events-none` and
  // off-screen exactly when a resting user reached for it — so their first
  // tap only re-revealed the bar and a second tap was needed to navigate
  // (the "double-tap" bug). Keeping the bar visible whenever the user is at
  // rest guarantees a single tap always activates navigation.
  const [navVisible, setNavVisible] = React.useState(true);
  const lastScrollYRef = React.useRef(0);
  // Reveals the bar a beat after scrolling SETTLES (not an idle-hide). The old
  // timer hid the bar at rest — the inverse of the intent — which is what caused
  // the double-tap bug. This one brings it back so the resting state is visible.
  const settleTimerRef = React.useRef<number | null>(null);
  // The fixed bottom nav is a standing backdrop layer on phone-class devices and
  // stays mounted while a dynamic detail modal opens — exactly the WebKit
  // memory-pressure crash profile. Drop the backdrop blur on low-budget devices
  // (the solid bg already carries the contrast); iPad never renders it (md:hidden).
  const lowRenderBudget = React.useRef(isLowRenderBudget() || isIpadSafariPerformanceMode()).current;

  // The pill is shown only when scroll-visible AND the Beam panel is not active.
  // While the panel owns the screen its composer/CTA sit at the bottom, so the
  // fixed gold nav pill would otherwise overlap them.
  const bottomNavShown = navVisible && !agentActive;

  // Propagate nav visibility state via CSS variable to keep floating elements synchronized
  React.useEffect(() => {
    document.documentElement.style.setProperty(
      '--mobile-nav-offset',
      bottomNavShown ? 'var(--bottomnav-h)' : '0px'
    );
  }, [bottomNavShown]);

  React.useEffect(() => {
    lastScrollYRef.current = window.scrollY;

    const handleScroll = () => {
      const y = window.scrollY;
      const delta = y - lastScrollYRef.current;
      
      if (Math.abs(delta) > 6) {
        if (delta > 0 && y > 56) {
          // Scrolling down: hide bottom nav immediately (immersive gesture).
          setNavVisible(false);
        } else if (delta < 0) {
          // Scrolling up: reveal bottom nav immediately.
          setNavVisible(true);
        }
        lastScrollYRef.current = y;
      }
      // Reveal the bar once the scroll SETTLES, so the resting state is always
      // visible and reachable in a single tap. Each scroll event resets the
      // timer, so the bar stays hidden only while a downward scroll is actively
      // in motion — never while the user is at rest (the double-tap bug came from
      // the old timer doing the opposite and hiding the bar on settle).
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = window.setTimeout(() => {
        setNavVisible(true);
        settleTimerRef.current = null;
      }, 320);
    };

    // Any direct interaction reveals the bar (covers the case where the user
    // taps right after a downward fling, before the scroll settles).
    const reveal = () => setNavVisible(true);

    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('touchstart', reveal, { passive: true });
    window.addEventListener('pointerdown', reveal, { passive: true });

    return () => {
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('touchstart', reveal);
      window.removeEventListener('pointerdown', reveal);
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    };
  }, []);

  // Navigating to a new route must never land the user on a hidden bar.
  React.useEffect(() => {
    setNavVisible(true);
  }, [location.pathname]);

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
    <>
      <nav className="scent-topbar fixed top-0 left-0 right-0 z-50 px-4 md:px-8">
        <div className="mx-auto grid h-full max-w-4xl grid-cols-[1fr_auto_1fr] items-center md:grid-cols-[auto_1fr_auto] md:gap-8">
          {/* Column 1 (desktop): primary nav links, far left. Hidden on mobile,
              where the bottom tab bar carries navigation. */}
          <div className="hidden items-center gap-6 md:flex md:justify-self-start">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  isActive ? `${activeNavClassName} gap-2` : inactiveNavClassName
                }
              >
                {({ isActive }) => (
                  <span className="relative inline-flex items-center gap-2">
                    {isActive ? <ActiveDot /> : null}
                    {item.label}
                  </span>
                )}
              </NavLink>
            ))}
          </div>

          {/* Column 1 (mobile only): spacer that balances the centered logo
              against the right-hand account control. */}
          <div className="md:hidden" aria-hidden="true" />

          {/* Column 2: logo, centered on every breakpoint. Two sizes — the
              compact mobile lockup and the larger desktop/iPad one. */}
          <div className="flex items-center justify-center md:justify-self-center">
            <h1 className="leading-none md:hidden">
              <Link to="/" aria-label="Go to home" className="block">
                <img
                  src="/nav/scentbeam-nav-logo.png"
                  srcSet="/nav/scentbeam-nav-logo.png 1x, /nav/scentbeam-nav-logo@2x.png 2x"
                  alt="ScentBeam"
                  className="h-9 w-auto max-w-[105px] min-[360px]:max-w-[126px] object-contain"
                  decoding="async"
                  draggable={false}
                />
              </Link>
            </h1>
            <Link to="/" aria-label="Go to home" className="hidden md:block">
              <img
                src="/nav/scentbeam-nav-logo.png"
                srcSet="/nav/scentbeam-nav-logo.png 1x, /nav/scentbeam-nav-logo@2x.png 2x"
                alt="ScentBeam"
                className="h-11 w-auto max-w-none object-contain"
                decoding="async"
                draggable={false}
              />
            </Link>
          </div>

          <div className="flex items-center justify-self-end">
            {authControl}
          </div>
        </div>
      </nav>

      {/* Bottom scrim — fades page content out just beneath the floating tab
          bar so a panel's action row (e.g. the arena reveal's Next / Share)
          never appears to bleed through or fight the nav, and the home-indicator
          safe-area never shows raw content. Phone-only and tied to the bar's own
          show/hide, so it never darkens the base when the bar is gone. Global:
          every route renders AppTopNav, so this lands on all pages at once. */}
      <div
        aria-hidden="true"
        className={[
          'pointer-events-none fixed inset-x-0 bottom-0 z-40 h-[calc(var(--bottomnav-h)+1.75rem)] md:hidden transition-opacity duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]',
          renderedRoute === 'community'
            ? 'bg-scent-bg'
            : 'bg-gradient-to-t from-scent-bg via-scent-bg/94 to-transparent',
          bottomNavShown ? 'opacity-100' : 'opacity-0',
        ].join(' ')}
      />

      <nav
        className={[
          'fixed bottom-[calc(0.75rem+env(safe-area-inset-bottom,0px))] left-3 right-3 z-50 md:hidden transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] will-change-[transform,opacity]',
          bottomNavShown
            ? 'translate-y-0 opacity-100 pointer-events-auto'
            : 'translate-y-[110%] opacity-0 pointer-events-none',
        ].join(' ')}
        aria-label="Primary navigation"
        aria-hidden={agentActive ? 'true' : undefined}
        onFocusCapture={() => setNavVisible(true)}
      >
        {/* Opaque pill surface: content must never read through the bar. The
            near-solid warm-black (was bg-black/66) is what makes the overlap
            land as a clean tab bar instead of competing layers. */}
        <div className={`mx-auto grid max-w-sm grid-cols-3 rounded-full border border-scent-accent/22 bg-[rgba(8,6,4,0.94)] p-1 shadow-[0_18px_48px_rgba(0,0,0,0.58),inset_0_1px_0_rgba(255,236,183,0.12)]${lowRenderBudget ? '' : ' backdrop-blur-md'}`}>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  [
                    'inline-flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-full px-2 text-[10px] font-bold uppercase tracking-[0.12em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55',
                    isActive
                      ? 'bg-scent-accent text-black shadow-[0_0_18px_rgba(212,175,55,0.18)]'
                      : 'text-scent-text-muted hover:text-foreground',
                  ].join(' ')
                }
              >
                <Icon size={16} strokeWidth={1.9} aria-hidden="true" />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </div>
      </nav>
    </>
  );
};
