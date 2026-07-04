import React, { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m } from 'framer-motion';
import { Check, LoaderCircle, Plus, X } from 'lucide-react';
import { BottleImage } from '@/components/BottleImage';
import { BrandGoldLabel } from '@/components/BrandGoldLabel';
import {
  COMMUNITY_IMAGE_LAYOUT_TRANSITION,
  COMMUNITY_IMAGE_LAYOUT_TRANSITION_LOW_RENDER,
} from '@/components/community/communityMotion';
import type { CommunityFragranceEntry } from '@/components/community/communityData';
import { useWardrobe } from '@/context/WardrobeContext';
import { useModalBehavior } from '@/hooks/use-modal-behavior';

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
  // The card→overlay shared-bottle transition and the staggered detail reveal
  // play on every device class. On the low-render budget (phone / iPad WebKit /
  // reduced-motion) we keep the SAME motion but route it through the cheaper
  // tween (`imageLayoutTransition`) so it stays inside WebKit's compositor
  // budget — a transform+opacity animation, no blur/blend/extra layers, so it
  // never pushes the iOS detail-modal memory ceiling. `prefers-reduced-motion`
  // users still get no motion: BottleMarquee's <MotionConfig reducedMotion="user">
  // strips the layout/transform animations for them.
  const imageLayoutTransition = lowRenderBudget
    ? COMMUNITY_IMAGE_LAYOUT_TRANSITION_LOW_RENDER
    : COMMUNITY_IMAGE_LAYOUT_TRANSITION;
  const sharedImageLayoutId = imageLayoutId ?? undefined;
  const detailRevealVariants = {
    hidden: {},
    visible: {
      transition: {
        delayChildren: 0.12,
        staggerChildren: 0.08,
      },
    },
  };
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

  // Focus trap, Escape-to-close, and a robust scroll lock (fixed-body on phones,
  // root-overflow + overscroll-none on iPad WebKit) come from the shared modal
  // hook — the same one the wardrobe detail modal uses. This replaces the old
  // bespoke `documentElement.overflow = hidden`, which iOS Safari ignores for
  // touch scrolling, letting the page footer rubber-band up into view behind the
  // overlay. restoreFocus stays off here: BottleMarquee restores the trigger
  // focus on exit-complete so it survives the close animation.
  useModalBehavior({
    isOpen: Boolean(item),
    containerRef: overlayRef,
    initialFocusRef: closeButtonRef,
    onDismiss: closeOverlay,
    restoreFocus: false,
  });

  useEffect(() => {
    setAddState('idle');
    setAddMessage(null);
  }, [activeItemKey]);

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

  // Portal to <body> so the overlay escapes the community page's `main` z-10
  // stacking context. Trapped inside it, the z-[110] panel still painted UNDER
  // the z-50 bottom nav (close button unreachable) and under the page footer
  // (it could rubber-band into view). At the body root, z-[110] wins outright.
  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence mode="wait" onExitComplete={handleExitComplete}>
      {item ? (
        <m.div
          key="community-fragrance-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          // Open: a quick fade so the shared-bottle morph is already travelling
          // when the overlay turns opaque. Close: a longer fade that OUTLASTS the
          // 0.45s bottle morph, so the bottle stays visible until it lands back on
          // the marquee card instead of vanishing mid-flight (the glitchy close on
          // phones, where the morph runs longer than a 0.24s fade could cover).
          exit={{ opacity: 0, transition: { duration: 0.5, ease: [0.4, 0, 0.2, 1] } }}
          transition={{ duration: 0.24, ease: 'easeOut' }}
          className="community-fragrance-detail fixed inset-0 z-[110] flex flex-col bg-[#020202]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="community-fragrance-overlay-title"
          ref={overlayRef}
        >
          <div aria-hidden="true" className="community-fragrance-detail__atmosphere" />
          <div className="community-fragrance-detail__scroll flex-1 overflow-y-auto overscroll-contain">
            <div
              className="community-fragrance-detail__shell"
              style={{
                paddingTop: 'max(3.4rem, env(safe-area-inset-top))',
                paddingBottom: 'max(2.35rem, env(safe-area-inset-bottom))',
              }}
            >
              <header className="community-fragrance-detail__topbar">
                <p className="community-fragrance-detail__eyebrow">Community Wardrobe</p>
                <button
                  type="button"
                  onClick={closeOverlay}
                  className="community-fragrance-detail__x"
                  aria-label="Close fragrance details"
                  ref={closeButtonRef}
                >
                  <X size={26} strokeWidth={1.18} />
                </button>
              </header>

              <m.div
                className="community-fragrance-detail__content"
                initial="hidden"
                animate="visible"
                variants={detailRevealVariants}
              >
                <section className="community-fragrance-detail__hero" aria-labelledby="community-fragrance-overlay-title">
                  <div className="community-fragrance-detail__hero-frame" aria-hidden="true" />
                  <button
                    type="button"
                    onClick={() => void addToWardrobe()}
                    disabled={addState === 'saving' || addState === 'saved' || alreadyInWardrobe}
                    aria-label={alreadyInWardrobe || addState === 'saved' ? `${item.name} is in your wardrobe` : `Add ${item.name} to wardrobe`}
                    className="community-fragrance-detail__save"
                    data-state={alreadyInWardrobe || addState === 'saved' ? 'saved' : addState}
                  >
                    {addState === 'saving' ? (
                      <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                    ) : alreadyInWardrobe || addState === 'saved' ? (
                      <Check size={16} strokeWidth={1.65} aria-hidden="true" />
                    ) : (
                      <Plus size={16} strokeWidth={1.65} aria-hidden="true" />
                    )}
                    <span>{alreadyInWardrobe || addState === 'saved' ? 'Saved' : 'Save'}</span>
                  </button>

                  <m.div
                    layoutId={sharedImageLayoutId}
                    transition={imageLayoutTransition}
                    className="community-fragrance-detail__bottle"
                  >
                    <BottleImage
                      src={item.imageUrl}
                      alt={`${item.name} by ${item.brand}`}
                      variant="detail"
                      proxy={false}
                      loading="eager"
                      fetchPriority="high"
                      className="absolute inset-0"
                      imgClassName="brightness-[1.06] contrast-[1.04]"
                      adjustment={item.imageAdjustment}
                      imageProperties={item.imageProperties}
                    />
                  </m.div>

                  <m.div
                    className="community-fragrance-detail__identity"
                    variants={{
                      hidden: { opacity: 0, y: 10 },
                      visible: { opacity: 1, y: 0, transition: { duration: 0.38, ease: 'easeOut' } },
                    }}
                  >
                    <BrandGoldLabel as="p" brand={item.brand} className="community-fragrance-detail__brand" />
                    <h2 id="community-fragrance-overlay-title" className="community-fragrance-detail__name">
                      {item.name}
                    </h2>
                    <div className="community-fragrance-detail__rule" aria-hidden="true">
                      <span />
                    </div>
                  </m.div>
                </section>

                {addMessage ? (
                  <m.p
                    className={addState === 'error' ? 'community-fragrance-detail__message community-fragrance-detail__message--error' : 'community-fragrance-detail__message'}
                    variants={{
                      hidden: { opacity: 0, y: 8 },
                      visible: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
                    }}
                  >
                    {addMessage}
                  </m.p>
                ) : null}

                <m.section
                  className="community-fragrance-detail__family"
                  variants={{
                    hidden: { opacity: 0, y: 12 },
                    visible: { opacity: 1, y: 0, transition: { duration: 0.38, ease: 'easeOut' } },
                  }}
                >
                  <p>Fragrance Family</p>
                  <h3>{item.family ?? 'Signature'}</h3>
                </m.section>

                <m.div
                  className="community-fragrance-detail__notes"
                  variants={{
                    hidden: { opacity: 0, y: 12 },
                    visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' } },
                  }}
                >
                  {noteRows.map(([label, key]) => (
                    <div key={label} className="community-fragrance-detail__note-row">
                      <p>{label}</p>
                      <span aria-hidden="true" />
                      <div>{formatNotes(item[key])}</div>
                    </div>
                  ))}
                </m.div>

                <m.button
                  type="button"
                  onClick={closeOverlay}
                  className="community-fragrance-detail__close"
                  variants={{
                    hidden: { opacity: 0, y: 14 },
                    visible: { opacity: 1, y: 0, transition: { duration: 0.42, ease: 'easeOut' } },
                  }}
                >
                  <span>Close Details</span>
                </m.button>
              </m.div>
            </div>
          </div>
        </m.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
};
