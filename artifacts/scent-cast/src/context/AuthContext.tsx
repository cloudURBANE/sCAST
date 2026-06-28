import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { clearPwaApiCache } from '@/lib/pwa/registerPwa';

const STORAGE_KEYS = {
  TOKEN: 'scent_token',
  EMAIL: 'scent_email',
  PICTURE: 'scent_picture',
  USERNAME: 'scent_username',
  GUEST_DISMISSED: 'scent_guest_prompt_dismissed',
  GUEST_MODE_ACK: 'scent_guest_mode_acknowledged',
} as const;

interface AuthContextType {
  authToken: string | null;
  authEmail: string | null;
  authPictureUrl: string | null;
  authUsername: string | null;
  isAuthModalOpen: boolean;
  isProfileModalOpen: boolean;
  guestPromptDismissed: boolean;
  /** True once the user explicitly chose "Continue as guest" this session. */
  guestModeActive: boolean;
  /** Persisted: the user dismissed the "browsing as guest" banner. */
  guestModeAcknowledged: boolean;
  /** User-facing message when a Google OAuth round-trip failed (null otherwise). */
  authError: string | null;
  clearAuthError: () => void;
  setIsAuthModalOpen: (open: boolean) => void;
  setIsProfileModalOpen: (open: boolean) => void;
  setAuthUsername: (username: string | null) => void;
  setGuestPromptDismissed: (dismissed: boolean) => void;
  setGuestModeAcknowledged: (acknowledged: boolean) => void;
  handleContinueAsGuest: () => void;
  handleAuth: (token: string, email: string, pictureUrl?: string | null) => void;
  handleSignOut: () => void;
}

/**
 * Maps the `oauth_error` codes the backend redirects with (routes/oauth.ts)
 * to a user-facing message. Without this, a failed sign-in silently bounces
 * the user back to a signed-out app with no feedback — they assume the button
 * is broken and retry in a loop.
 */
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  no_code: 'Sign-in was cancelled before it finished. Please try again.',
  token_exchange: "We couldn't complete sign-in with Google. Please try again.",
  user_info: "We couldn't read your Google profile. Please try again.",
  missing_email: 'Your Google account did not share an email address, which is required to sign in.',
  unverified_email:
    'Your Google email address is not verified. Verify it with Google, then sign in again.',
  server_error: 'Something went wrong on our end during sign-in. Please try again in a moment.',
  account_conflict:
    'This email is already linked to a different Google account. Sign in with the original account, or contact support.',
};

const mapOAuthError = (code: string): string =>
  OAUTH_ERROR_MESSAGES[code] ?? 'Sign-in failed. Please try again.';

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [authToken, setAuthToken] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthToken = params.get('oauth_token');
    const oauthEmail = params.get('oauth_email');
    const oauthPicture = params.get('oauth_picture');
    if (oauthToken && oauthEmail) {
      localStorage.setItem(STORAGE_KEYS.TOKEN, oauthToken);
      localStorage.setItem(STORAGE_KEYS.EMAIL, oauthEmail);
      if (oauthPicture) {
        localStorage.setItem(STORAGE_KEYS.PICTURE, oauthPicture);
      } else {
        localStorage.removeItem(STORAGE_KEYS.PICTURE);
      }
      window.history.replaceState({}, '', window.location.pathname);
      return oauthToken;
    }
    return localStorage.getItem(STORAGE_KEYS.TOKEN);
  });

  // authToken's initializer already wrote oauth_email/oauth_picture to localStorage
  // and cleared the URL via replaceState — read from storage only.
  const [authEmail, setAuthEmail] = useState<string | null>(() =>
    localStorage.getItem(STORAGE_KEYS.EMAIL),
  );

  const [authPictureUrl, setAuthPictureUrl] = useState<string | null>(() =>
    localStorage.getItem(STORAGE_KEYS.PICTURE),
  );

  // The chosen community display name. Seeded from storage for an instant nav
  // label, then reconciled against the server (GET /api/me/profile) on sign-in.
  const [authUsername, setAuthUsernameState] = useState<string | null>(() =>
    localStorage.getItem(STORAGE_KEYS.USERNAME),
  );

  const setAuthUsername = useCallback((username: string | null) => {
    const next = username?.trim() ? username.trim() : null;
    setAuthUsernameState(next);
    try {
      if (next) localStorage.setItem(STORAGE_KEYS.USERNAME, next);
      else localStorage.removeItem(STORAGE_KEYS.USERNAME);
    } catch {
      /* storage unavailable (private mode / quota) — keep in-memory state only */
    }
  }, []);

  // Surface OAuth failures the backend signals via `?oauth_error=<code>`. The
  // token initializer above only strips the URL when a *successful* token is
  // present, so we read (and clear) the error param here on first paint.
  const [authError, setAuthError] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('oauth_error');
    if (!code) return null;
    params.delete('oauth_error');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
    return mapOAuthError(code);
  });

  const clearAuthError = useCallback(() => setAuthError(null), []);

  // Open the auth modal on first paint when sign-in failed so the message
  // (rendered by AuthModal) is actually seen, instead of a silent bounce.
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(() => authError !== null);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  // Persisted so a guest who has waved off the save prompt isn't re-nagged on
  // every reload. Cleared on sign-in (the prompt becomes irrelevant once saved).
  const [guestPromptDismissed, setGuestPromptDismissedState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEYS.GUEST_DISMISSED) === '1';
    } catch {
      return false;
    }
  });

  const setGuestPromptDismissed = useCallback((dismissed: boolean) => {
    setGuestPromptDismissedState(dismissed);
    try {
      if (dismissed) localStorage.setItem(STORAGE_KEYS.GUEST_DISMISSED, '1');
      else localStorage.removeItem(STORAGE_KEYS.GUEST_DISMISSED);
    } catch {
      /* storage unavailable (private mode / quota) — keep in-memory state only */
    }
  }, []);

  // Session-only: flips on when the user explicitly picks "Continue as guest",
  // which drives the persistent guest-state banner. Not persisted — a fresh
  // visit shouldn't open with the banner unless the user chooses guest again.
  const [guestModeActive, setGuestModeActive] = useState(false);

  // Persisted: once the guest banner is dismissed it stays dismissed across
  // reloads. Cleared on sign-in so a future signed-out guest session can show it.
  const [guestModeAcknowledged, setGuestModeAcknowledgedState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEYS.GUEST_MODE_ACK) === '1';
    } catch {
      return false;
    }
  });

  const setGuestModeAcknowledged = useCallback((acknowledged: boolean) => {
    setGuestModeAcknowledgedState(acknowledged);
    try {
      if (acknowledged) localStorage.setItem(STORAGE_KEYS.GUEST_MODE_ACK, '1');
      else localStorage.removeItem(STORAGE_KEYS.GUEST_MODE_ACK);
    } catch {
      /* storage unavailable (private mode / quota) — keep in-memory state only */
    }
  }, []);

  const handleContinueAsGuest = useCallback(() => {
    setIsAuthModalOpen(false);
    setGuestModeActive(true);
  }, []);

  const handleAuth = useCallback((token: string, email: string, pictureUrl?: string | null) => {
    localStorage.setItem(STORAGE_KEYS.TOKEN, token);
    localStorage.setItem(STORAGE_KEYS.EMAIL, email);
    if (pictureUrl) {
      localStorage.setItem(STORAGE_KEYS.PICTURE, pictureUrl);
    } else {
      localStorage.removeItem(STORAGE_KEYS.PICTURE);
    }
    setAuthToken(token);
    setAuthEmail(email);
    setAuthPictureUrl(pictureUrl ?? null);
    setAuthError(null);
    setIsAuthModalOpen(false);
    setGuestPromptDismissed(false);
    setGuestModeActive(false);
    setGuestModeAcknowledged(false);
  }, [setGuestPromptDismissed, setGuestModeAcknowledged]);

  const handleSignOut = useCallback(() => {
    // WS-18: revoke the bearer token server-side (rotates users.token) so the old
    // credential can't be replayed if it ever leaked. Fire-and-forget — local
    // sign-out must not block on or fail because of the network.
    if (authToken) {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        keepalive: true,
      }).catch(() => {
        /* best-effort: local state is cleared regardless */
      });
    }
    localStorage.removeItem(STORAGE_KEYS.TOKEN);
    localStorage.removeItem(STORAGE_KEYS.EMAIL);
    localStorage.removeItem(STORAGE_KEYS.PICTURE);
    localStorage.removeItem(STORAGE_KEYS.USERNAME);
    setAuthToken(null);
    setAuthEmail(null);
    setAuthPictureUrl(null);
    setAuthUsernameState(null);
    // Reset the guest-nudge flags (these persist to localStorage) so a fresh
    // guest session on a shared device isn't silently denied the sign-in prompt
    // because the previous account had dismissed/acknowledged it.
    setGuestPromptDismissed(false);
    setGuestModeAcknowledged(false);
    setGuestModeActive(false);
    // Evict cached authenticated API responses (wardrobe/profile) from the
    // service worker so the next user on this device never sees them.
    clearPwaApiCache();
  }, [authToken, setGuestPromptDismissed, setGuestModeAcknowledged]);

  // Reconcile the username with the server whenever the token changes. The
  // seeded value covers the first paint; this corrects it if the user set a
  // name on another device (or never set one). Tolerates failure silently —
  // the nav simply falls back to the email until the next successful load.
  useEffect(() => {
    if (!authToken) return;
    const controller = new AbortController();
    fetch('/api/me/profile', {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        setAuthUsername(typeof data.username === 'string' ? data.username : null);
      })
      .catch(() => {
        /* aborted or offline — keep the seeded value */
      });
    return () => controller.abort();
  }, [authToken, setAuthUsername]);

  const contextValue = useMemo<AuthContextType>(() => ({
    authToken,
    authEmail,
    authPictureUrl,
    authUsername,
    isAuthModalOpen,
    isProfileModalOpen,
    guestPromptDismissed,
    guestModeActive,
    guestModeAcknowledged,
    authError,
    clearAuthError,
    setIsAuthModalOpen,
    setIsProfileModalOpen,
    setAuthUsername,
    setGuestPromptDismissed,
    setGuestModeAcknowledged,
    handleContinueAsGuest,
    handleAuth,
    handleSignOut,
  }), [
    authToken,
    authEmail,
    authPictureUrl,
    authUsername,
    isAuthModalOpen,
    isProfileModalOpen,
    guestPromptDismissed,
    guestModeActive,
    guestModeAcknowledged,
    authError,
    clearAuthError,
    setAuthUsername,
    setGuestModeAcknowledged,
    handleContinueAsGuest,
    handleAuth,
    handleSignOut,
  ]);

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
