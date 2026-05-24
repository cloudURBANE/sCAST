import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

const STORAGE_KEYS = {
  TOKEN: 'scent_token',
  EMAIL: 'scent_email',
  PICTURE: 'scent_picture',
} as const;

interface AuthContextType {
  authToken: string | null;
  authEmail: string | null;
  authPictureUrl: string | null;
  isAuthModalOpen: boolean;
  guestPromptDismissed: boolean;
  setIsAuthModalOpen: (open: boolean) => void;
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

  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [guestPromptDismissed, setGuestPromptDismissed] = useState(false);

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
  }, []);

  const handleSignOut = useCallback(() => {
    localStorage.removeItem(STORAGE_KEYS.TOKEN);
    localStorage.removeItem(STORAGE_KEYS.EMAIL);
    localStorage.removeItem(STORAGE_KEYS.PICTURE);
    setAuthToken(null);
    setAuthEmail(null);
    setAuthPictureUrl(null);
  }, []);

  const contextValue = useMemo<AuthContextType>(() => ({
    authToken,
    authEmail,
    authPictureUrl,
    isAuthModalOpen,
    guestPromptDismissed,
    setIsAuthModalOpen,
    setGuestPromptDismissed,
    handleAuth,
    handleSignOut,
  }), [
    authToken,
    authEmail,
    authPictureUrl,
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
