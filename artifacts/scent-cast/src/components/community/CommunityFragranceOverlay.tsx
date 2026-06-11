import React, { useCallback, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, LoaderCircle, Plus, X } from 'lucide-react';
import { BottleImage } from '@/components/BottleImage';
import { BrandGoldLabel } from '@/components/BrandGoldLabel';
import {
  COMMUNITY_IMAGE_LAYOUT_TRANSITION,
  COMMUNITY_IMAGE_LAYOUT_TRANSITION_LOW_RENDER,
} from '@/components/community/communityMotion';
import type { CommunityFragranceEntry } from '@/components/community/communityData';
import { useWardrobe } from '@/context/WardrobeContext';

interface CommunityFragranceOverlayProps {
  item: CommunityFragranceEntry | null;
  imageLayoutId?: string | null;
  lowRenderBudget?: boolean;
  onClose: () => void;
  onExitComplete?: () => void;
  restoreFocus?: () => void;
}

const noteRows = [
  ['Top', 'topNotes'],
  ['Heart', 'heartNotes'],
  ['Base', 'baseNotes'],
] as const;

function formatNotes(notes: string[] | undefined): string {
  return notes && notes.length > 0 ? notes.join(', ') : 'Notes pending curation';
}

function newCommunityWardrobeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `community-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function wardrobeIdentityKey(brand?: string | null, name?: string | null): string {
  const compact = [brand, name]
    .map((value) => value?.trim().toLowerCase().replace(/[^a-z0-9]+/g, ''))
    .filter(Boolean)
    .join(':');
  return compact;
}

export const CommunityFragranceOverlay: React.FC<CommunityFragranceOverlayProps> = ({
  item,
  imageLayoutId,
  lowRenderBudget = false,
  onClose,
  onExitComplete,
  restoreFocus,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const { items, handleAddItem } = useWardrobe();
  const [addState, setAddState] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [addMessage, setAddMessage] = React.useState<string | null>(null);
  const imageLayoutTransition = lowRenderBudget
    ? COMMUNITY_IMAGE_LAYOUT_TRANSITION_LOW_RENDER
    : COMMUNITY_IMAGE_LAYOUT_TRANSITION;
  const activeItemKey = item ? wardrobeIdentityKey(item.brand, item.name) : '';
  const alreadyInWardrobe = Boolean(
    activeItemKey &&
      items.some((wardrobeItem) => {
        const record = wardrobeItem as unknown as Record<string, unknown>;
        const product = record.product && typeof record.product === 'object'
          ? (record.product as Record<string, unknown>)
          : {};
        const brand = typeof record.brand === 'string'
          ? record.brand
          : typeof product.brand === 'string'
            ? product.brand
            : null;
        const name = typeof record.name === 'string'
          ? record.name
          : typeof product.name === 'string'
            ? product.name
            : null;
        return wardrobeIdentityKey(brand, name) === activeItemKey;
      }),
  );

  const closeOverlay = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleExitComplete = useCallback(() => {
    onExitComplete?.();
    window.requestAnimationFrame(() => {
      restoreFocus?.();
    });
  }, [onExitComplete, restoreFocus]);

  useEffect(() => {
    if (!item) return;
    closeButtonRef.current?.focus();
  }, [item]);

  useEffect(() => {
    setAddState('idle');
    setAddMessage(null);
  }, [activeItemKey]);

  // Lock page scroll behind the modal; restore whatever was there on close.
  useEffect(() => {
    if (!item) return;
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = previousOverflow;
    };
  }, [item]);

  useEffect(() => {
    if (!item) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeOverlay();
        return;
      }

      // Cycle Tab within the dialog so focus can't land on the hidden page.
      if (event.key !== 'Tab') return;
      const root = overlayRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const activeInDialog = active instanceof HTMLElement && root.contains(active);

      if (event.shiftKey) {
        if (!activeInDialog || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!activeInDialog || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [item, closeOverlay]);

  const addToWardrobe = useCallback(async () => {
    if (!item || addState === 'saving' || addState === 'saved' || alreadyInWardrobe) return;

    const flatNotes = [
      ...(item.topNotes ?? []),
      ...(item.heartNotes ?? []),
      ...(item.baseNotes ?? []),
    ];

    setAddState('saving');
    setAddMessage(null);

    try {
      const result = await handleAddItem({
        id: newCommunityWardrobeId(),
        name: item.name,
        brand: item.brand,
        imageUrl: item.imageUrl,
        season: 'Universal',
        ...(item.family ? { family: item.family } : {}),
        ...(flatNotes.length > 0 ? { notes: flatNotes } : {}),
        ...(flatNotes.length > 0
          ? {
              pyramid: {
                top: item.topNotes ?? [],
                heart: item.heartNotes ?? [],
                base: item.baseNotes ?? [],
              },
            }
          : {}),
        context: {
          source: 'community',
          curator: item.curator,
        },
      });

      if (result.error) {
        setAddState('error');
        setAddMessage(result.error);
        return;
      }

      setAddState('saved');
      setAddMessage(result.persisted ? 'Saved to wardrobe.' : 'Added locally. Sign in to sync.');
    } catch (err) {
      setAddState('error');
      setAddMessage(err instanceof Error ? err.message : 'Could not add to wardrobe.');
    }
  }, [addState, alreadyInWardrobe, handleAddItem, item]);

  return (
    <AnimatePresence mode="wait" onExitComplete={handleExitComplete}>
      {item ? (
        <motion.div
          key="community-fragrance-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.24, ease: 'easeOut' }}
          className="fixed inset-0 z-[110] flex flex-col bg-[#020202]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="community-fragrance-overlay-title"
          ref={overlayRef}
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 [background:radial-gradient(58%_46%_at_28%_44%,rgba(214,178,116,0.07),transparent_72%)]"
          />
          <div
            className="relative flex items-center justify-between px-5 pb-4 shrink-0"
            style={{ paddingTop: 'max(1.25rem, env(safe-area-inset-top))' }}
          >
            <p className="scent-type-label text-scent-accent">Community Wardrobe</p>
            <button
              type="button"
              onClick={closeOverlay}
              className="-m-1 inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-scent-text-subtle hover:text-white hover:bg-white/10 transition-all active:scale-95"
              aria-label="Close fragrance details"
              ref={closeButtonRef}
            >
              <X size={20} strokeWidth={1.75} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            <div className="flex min-h-full items-center justify-center px-5 py-6 sm:px-10 sm:py-10 lg:px-16">
              <div className="grid w-full max-w-6xl gap-8 lg:grid-cols-[minmax(18rem,26rem)_minmax(0,1fr)] lg:items-center lg:gap-14">
                <div className="scent-fragrance-card relative mx-auto flex aspect-[3/4.6] w-full max-w-[20rem] flex-col p-5 sm:max-w-[24rem] sm:p-6">
                  <div className="scent-card-frame" aria-hidden="true" />
                  <div className="relative z-10 flex justify-end">
                    <span className="font-mono scent-type-label text-scent-accent">
                      {item.curator}
                    </span>
                  </div>
                  <motion.div
                    layoutId={imageLayoutId ?? undefined}
                    transition={imageLayoutTransition}
                    className="relative z-10 my-3 min-h-0 flex-1"
                  >
                    <BottleImage
                      src={item.imageUrl}
                      alt={`${item.name} by ${item.brand}`}
                      variant="detail"
                      proxy={false}
                      loading="eager"
                      fetchPriority="high"
                      className="absolute inset-0"
                      imgClassName="brightness-[1.1]"
                      adjustment={item.imageAdjustment}
                    />
                  </motion.div>
                  <div className="relative z-10 mt-2 text-center">
                    <BrandGoldLabel as="span" brand={item.brand} className="scent-card-brand block" />
                  </div>
                  <div className="scent-card-title-row relative z-10 mt-2">
                    <h3 className="scent-card-title" title={item.name}>{item.name}</h3>
                  </div>
                </div>

                <motion.div
                  className="space-y-8 text-left"
                  initial="hidden"
                  animate="visible"
                  variants={{
                    hidden: {},
                    visible: {
                      transition: {
                        delayChildren: 0.12,
                        staggerChildren: 0.08,
                      },
                    },
                  }}
                >
                  <motion.header className="space-y-5">
                    <motion.p
                      className="scent-type-label text-scent-accent"
                      variants={{
                        hidden: { opacity: 0, y: 10 },
                        visible: { opacity: 1, y: 0, transition: { duration: 0.38, ease: 'easeOut' } },
                      }}
                    >
                      Community Wardrobe
                    </motion.p>
                    <motion.div
                      className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
                      variants={{
                        hidden: { opacity: 0, y: 12 },
                        visible: { opacity: 1, y: 0, transition: { duration: 0.42, ease: 'easeOut' } },
                      }}
                    >
                      <div className="min-w-0 space-y-3">
                        <BrandGoldLabel as="p" brand={item.brand} className="font-serif text-sm uppercase tracking-[0.24em]" />
                        <motion.h2
                          id="community-fragrance-overlay-title"
                          className="font-serif text-4xl italic leading-none text-[#fff7ec] sm:text-6xl lg:text-7xl"
                        >
                          {item.name}
                        </motion.h2>
                      </div>
                      <button
                        type="button"
                        onClick={() => void addToWardrobe()}
                        disabled={addState === 'saving' || addState === 'saved' || alreadyInWardrobe}
                        aria-label={alreadyInWardrobe || addState === 'saved' ? `${item.name} is in your wardrobe` : `Add ${item.name} to wardrobe`}
                        className={[
                          'inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full border px-3.5 py-2 scent-type-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/70 sm:mt-0',
                          alreadyInWardrobe || addState === 'saved'
                            ? 'border-scent-accent/30 bg-scent-accent/[0.1] text-[#fff7ec]'
                            : 'border-scent-accent/28 bg-black/58 text-scent-text-muted hover:border-scent-accent/48 hover:text-[#fff7ec]',
                        ].join(' ')}
                      >
                        {addState === 'saving' ? (
                          <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                        ) : alreadyInWardrobe || addState === 'saved' ? (
                          <Check size={16} strokeWidth={1.8} aria-hidden="true" />
                        ) : (
                          <Plus size={17} strokeWidth={1.9} aria-hidden="true" />
                        )}
                        <span className="hidden sm:inline">
                          {alreadyInWardrobe || addState === 'saved' ? 'Saved' : 'Wardrobe'}
                        </span>
                      </button>
                    </motion.div>
                    {addMessage ? (
                      <motion.p
                        className={addState === 'error' ? 'scent-type-meta uppercase text-red-200' : 'scent-type-meta uppercase text-scent-text-muted'}
                        variants={{
                          hidden: { opacity: 0, y: 8 },
                          visible: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
                        }}
                      >
                        {addMessage}
                      </motion.p>
                    ) : null}
                    {item.family ? (
                      <motion.p
                        className="scent-type-meta uppercase"
                        variants={{
                          hidden: { opacity: 0, y: 8 },
                          visible: { opacity: 1, y: 0, transition: { duration: 0.36, ease: 'easeOut' } },
                        }}
                      >
                        {item.family}
                      </motion.p>
                    ) : null}
                  </motion.header>

                  <motion.div
                    className="h-px w-full bg-gradient-to-r from-scent-accent/40 via-white/10 to-transparent"
                    variants={{
                      hidden: { opacity: 0, scaleX: 0.96 },
                      visible: {
                        opacity: 1,
                        scaleX: 1,
                        transition: { duration: 0.4, ease: 'easeOut' },
                      },
                    }}
                    style={{ transformOrigin: 'left' }}
                  />

                  <div className="grid grid-cols-1 gap-5 sm:grid-cols-3 sm:gap-6">
                    {noteRows.map(([label, key]) => (
                      <motion.div
                        key={label}
                        className="border-l border-white/10 pl-4"
                        variants={{
                          hidden: { opacity: 0, y: 10 },
                          visible: { opacity: 1, y: 0, transition: { duration: 0.36, ease: 'easeOut' } },
                        }}
                      >
                        <p className="mb-2 scent-type-label text-scent-accent">
                          {label}
                        </p>
                        <p className="font-serif text-base italic leading-relaxed text-scent-text-muted">
                          {formatNotes(item[key])}
                        </p>
                      </motion.div>
                    ))}
                  </div>
                </motion.div>
              </div>
            </div>
          </div>

          <div
            className="px-5 pt-3 shrink-0 border-t border-white/5"
            style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
          >
            <button
              type="button"
              onClick={closeOverlay}
              className="scent-primary-button mx-auto flex min-h-11 w-full max-w-sm items-center justify-center rounded-[var(--radius-scent)] px-5 py-2.5 text-xs font-bold uppercase tracking-[0.18em]"
            >
              <span>Close details</span>
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
};
