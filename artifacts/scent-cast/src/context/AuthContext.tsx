import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

const STORAGE_KEYS = {
  TOKEN: 'scent_token',
  EMAIL: 'scent_email',
} as const;

interface AuthContextType {
  authToken: string | null;
  authEmail: string | null;
  isAuthModalOpen: boolean;
  guestPromptDismissed: boolean;
  setIsAuthModalOpen: (open: boolean) => void;
  setGuestPromptDismissed: (dismissed: boolean) => void;
  handleAuth: (token: string, email: string) => void;
  handleSignOut: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [authToken, setAuthToken] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthToken = params.get('oauth_token');
    const oauthEmail = params.get('oauth_email');
    if (oauthToken && oauthEmail) {
      localStorage.setItem(STORAGE_KEYS.TOKEN, oauthToken);
      localStorage.setItem(STORAGE_KEYS.EMAIL, oauthEmail);
      window.history.replaceState({}, '', window.location.pathname);
      return oauthToken;
    }
    return localStorage.getItem(STORAGE_KEYS.TOKEN);
  });

  const [authEmail, setAuthEmail] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthEmail = params.get('oauth_email');
    if (oauthEmail) {
      return oauthEmail;
    }
    return localStorage.getItem(STORAGE_KEYS.EMAIL);
  });

  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [guestPromptDismissed, setGuestPromptDismissed] = useState(false);

  const handleAuth = useCallback((token: string, email: string) => {
    localStorage.setItem(STORAGE_KEYS.TOKEN, token);
    localStorage.setItem(STORAGE_KEYS.EMAIL, email);
    setAuthToken(token);
    setAuthEmail(email);
    setIsAuthModalOpen(false);
    setGuestPromptDismissed(false);
  }, []);

  const handleSignOut = useCallback(() => {
    localStorage.removeItem(STORAGE_KEYS.TOKEN);
    localStorage.removeItem(STORAGE_KEYS.EMAIL);
    setAuthToken(null);
    setAuthEmail(null);
  }, []);

  const contextValue = useMemo<AuthContextType>(() => ({
    authToken,
    authEmail,
    isAuthModalOpen,
    guestPromptDismissed,
    setIsAuthModalOpen,
    setGuestPromptDismissed,
    handleAuth,
    handleSignOut,
  }), [
    authToken,
    authEmail,
    isAuthModalOpen,
    guestPromptDismissed,
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
