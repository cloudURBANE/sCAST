import React from 'react';
import { motion } from 'framer-motion';
import { useModalBehavior } from '@/hooks/use-modal-behavior';

interface AuthModalProps {
  onAuth: (token: string, email: string) => void;
  onClose?: () => void;
  title?: React.ReactNode;
  subtitle?: string;
  allowDismiss?: boolean;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  onClose,
  title,
  subtitle,
  allowDismiss = false,
}) => {
  const modalRef = React.useRef<HTMLDivElement | null>(null);
  const primaryActionRef = React.useRef<HTMLButtonElement | null>(null);

  useModalBehavior({
    isOpen: true,
    containerRef: modalRef,
    initialFocusRef: primaryActionRef,
    onDismiss: allowDismiss ? onClose : undefined,
    closeOnEscape: allowDismiss,
  });

  const handleGoogleSignIn = () => {
    window.location.href = '/api/auth/google';
  };

  return (
    <div
      ref={modalRef}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
    >
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md px-8"
      >
        <div className="flex flex-col items-center gap-10">
          <div className="opacity-60">
            <img
              src="/nav/scentbeam-nav-logo.png"
              srcSet="/nav/scentbeam-nav-logo.png 1x, /nav/scentbeam-nav-logo@2x.png 2x"
              alt="ScentBeam"
              className="h-7 w-auto"
              draggable={false}
            />
          </div>

          <div className="text-center space-y-3">
            <p className="text-[10px] uppercase tracking-[0.5em] text-white/30 font-bold">Olfactory Intelligence</p>
            <h1 id="auth-modal-title" className="font-serif italic text-4xl sm:text-5xl text-white tracking-tighter leading-tight">
              {title ?? <>Sign in to access<br />your vault</>}
            </h1>
            <p className="text-sm text-white/30 font-sans">
              {subtitle ?? 'Your fragrances are saved to your account.'}
            </p>
          </div>

          <div className="w-full space-y-4">
            <button
              ref={primaryActionRef}
              onClick={handleGoogleSignIn}
              className="w-full h-14 bg-white text-black font-sans font-semibold text-sm flex items-center justify-center gap-3 hover:bg-neutral-100 transition-all rounded-2xl"
            >
              <GoogleIcon />
              Continue with Google
            </button>
            {allowDismiss && onClose ? (
              <button
                type="button"
                onClick={onClose}
                className="w-full h-11 border border-white/15 text-white/70 font-sans text-xs uppercase tracking-[0.25em] hover:text-white hover:border-white/35 transition-all rounded-2xl"
              >
                Continue as Guest
              </button>
            ) : null}
          </div>
        </div>
      </motion.div>
    </div>
  );
};

const GoogleIcon: React.FC = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
    <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
    <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
    <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
  </svg>
);
