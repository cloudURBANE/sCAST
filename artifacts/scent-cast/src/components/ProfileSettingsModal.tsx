import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, LoaderCircle, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { useModalBehavior } from '@/hooks/use-modal-behavior';

interface ProfileSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  authToken: string | null;
  currentUsername: string | null;
  onSaved: (username: string | null) => void;
}

const USERNAME_MAX = 20;
// Mirrors the server contract (PUT /api/me/profile): 3–20 chars, letters/numbers
// and . _ -, never at the start or end. Empty clears the username.
const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9_.\-]{1,18}[a-zA-Z0-9])$/;

export const ProfileSettingsModal: React.FC<ProfileSettingsModalProps> = ({
  isOpen,
  onClose,
  authToken,
  currentUsername,
  onSaved,
}) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset the field to the current name each time the panel opens.
  useEffect(() => {
    if (isOpen) {
      setValue(currentUsername ?? '');
      setError(null);
    }
  }, [isOpen, currentUsername]);

  useModalBehavior({
    isOpen,
    containerRef: modalRef,
    initialFocusRef: inputRef,
    onDismiss: onClose,
  });

  const trimmed = value.trim();
  const unchanged = trimmed === (currentUsername ?? '');
  const formatInvalid = trimmed.length > 0 && !USERNAME_RE.test(trimmed);

  const handleSave = async () => {
    if (!authToken || saving) return;
    if (formatInvalid) {
      setError('Use 3–20 characters: letters, numbers, and . _ - only (not at the start or end).');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/me/profile', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ username: trimmed }),
      });
      const data = (await res.json().catch(() => null)) as { username?: string | null; error?: string } | null;
      if (!res.ok) {
        throw new Error(data?.error || `Could not save (HTTP ${res.status}).`);
      }
      const savedUsername = typeof data?.username === 'string' ? data.username : null;
      onSaved(savedUsername);
      // Author names are baked into cached community payloads — refetch so the
      // feed and comments reflect the new name without a hard reload.
      void queryClient.invalidateQueries({ queryKey: ['community'] });
      toast({
        title: savedUsername ? 'Username updated' : 'Username cleared',
        description: savedUsername
          ? `You'll appear as “${savedUsername}” in the community.`
          : 'Your posts now show a private alias.',
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your username.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/90"
          />
          <motion.div
            ref={modalRef}
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 40 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full sm:max-w-md mx-0 sm:mx-6 bg-neutral-950 border-t sm:border border-white/10 sm:rounded-[1.5rem] overflow-hidden shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-modal-title"
          >
            <div className="flex items-center justify-between px-6 py-5 border-b border-white/5">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-1.5 h-1.5 rounded-full bg-scent-accent animate-pulse shrink-0" />
                <div className="min-w-0">
                  <p id="profile-modal-title" className="text-[9px] uppercase tracking-[0.5em] text-scent-accent font-bold">
                    Profile
                  </p>
                  <p className="text-[9px] text-white/25 mt-0.5 font-sans">Community display name</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="p-2 bg-white/5 hover:bg-white/10 transition-all rounded-full border border-white/10 text-white group shrink-0 ml-3"
              >
                <X size={16} className="group-hover:rotate-90 transition-transform duration-300" />
              </button>
            </div>

            <form
              className="px-6 py-6 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSave();
              }}
            >
              <label htmlFor="profile-username" className="block">
                <span className="text-[9px] uppercase tracking-[0.4em] text-white/30 font-bold">Username</span>
                <input
                  id="profile-username"
                  ref={inputRef}
                  type="text"
                  value={value}
                  maxLength={USERNAME_MAX}
                  onChange={(event) => {
                    setValue(event.target.value);
                    if (error) setError(null);
                  }}
                  placeholder="e.g. velvet_oud"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="mt-2 w-full bg-white/[0.03] border border-white/10 px-4 py-3 text-base text-white placeholder:text-white/20 focus:border-scent-accent/40 outline-none transition-all font-sans rounded-[10px]"
                />
              </label>

              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] leading-snug text-white/35">
                  {error ? (
                    <span className="text-red-300">{error}</span>
                  ) : (
                    'Letters, numbers, and . _ - · leave blank to stay anonymous.'
                  )}
                </p>
                <span className="shrink-0 font-mono text-[11px] text-white/30">
                  {trimmed.length}/{USERNAME_MAX}
                </span>
              </div>

              <button
                type="submit"
                disabled={saving || unchanged || formatInvalid || !authToken}
                className="inline-flex w-full min-h-12 items-center justify-center gap-2 rounded-full border border-scent-accent/30 bg-scent-accent/[0.08] px-4 py-3 text-[13px] font-semibold uppercase tracking-[0.16em] text-[#fff7ec] transition-colors hover:border-scent-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35 disabled:pointer-events-none disabled:opacity-45"
              >
                {saving ? (
                  <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                ) : (
                  <Check size={15} strokeWidth={2} aria-hidden="true" />
                )}
                {saving ? 'Saving' : 'Save username'}
              </button>
            </form>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
