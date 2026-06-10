import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const STORAGE_KEYS = {
  TOKEN: 'scent_token',
  EMAIL: 'scent_email',
  PICTURE: 'scent_picture',
  USERNAME: 'scent_username',
  GUEST_DISMISSED: 'scent_guest_prompt_dismissed',
} as const;

interface AuthContextType {
  authToken: string | null;
  authEmail: string | null;
  authPictureUrl: string | null;
  authUsername: string | null;
  isAuthModalOpen: boolean;
  isProfileModalOpen: boolean;
  guestPromptDismissed: boolean;
  setIsAuthModalOpen: (open: boolean) => void;
  setIsProfileModalOpen: (open: boolean) => void;
  setAuthUsername: (username: string | null) => void;
  setGuestPromptDismissed: (dismissed: boolean) => void;
  handleAuth: (token: string, email: string, pictureUrl?: string | null) => void;
  handleSignOut: () => void;
}

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

  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
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
    setIsAuthModalOpen(false);
    setGuestPromptDismissed(false);
  }, [setGuestPromptDismissed]);

  const handleSignOut = useCallback(() => {
    localStorage.removeItem(STORAGE_KEYS.TOKEN);
    localStorage.removeItem(STORAGE_KEYS.EMAIL);
    localStorage.removeItem(STORAGE_KEYS.PICTURE);
    localStorage.removeItem(STORAGE_KEYS.USERNAME);
    setAuthToken(null);
    setAuthEmail(null);
    setAuthPictureUrl(null);
    setAuthUsernameState(null);
  }, []);

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
    setIsAuthModalOpen,
    setIsProfileModalOpen,
    setAuthUsername,
    setGuestPromptDismissed,
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
    setAuthUsername,
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
