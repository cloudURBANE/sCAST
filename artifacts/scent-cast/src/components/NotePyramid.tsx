import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

type ActiveLayer = 'top' | 'heart' | 'base';

type NotePyramidProps = {
  topNotes: string[];
  heartNotes: string[];
  baseNotes: string[];
  className?: string;
};

type LayerConfig = {
  key: ActiveLayer;
  title: string;
  ariaLabel: string;
  notes: string[];
  positionClass: string;
  seamClass: string;
  zIndex: number;
  style: React.CSSProperties;
};

const layerMotion: Record<ActiveLayer | 'idle', Record<ActiveLayer, number>> = {
  idle: { top: 0, heart: 0, base: 0 },
  top: { top: -18, heart: 0, base: 0 },
  heart: { top: -8, heart: -2, base: 16 },
  base: { top: -6, heart: -13, base: 8 },
};

const transition = {
  duration: 0.42,
  ease: [0.22, 1, 0.36, 1],
} as const;

const topLayerStyle: React.CSSProperties = {
  clipPath: 'polygon(50% 0%, 92% 78%, 50% 98%, 8% 78%)',
  background:
    'radial-gradient(circle at 58% 23%, rgba(255,238,174,0.38), transparent 22%), linear-gradient(90deg, rgba(59,37,16,0.98) 0%, rgba(129,86,32,0.97) 43%, rgba(232,191,105,0.98) 50%, rgba(150,98,36,0.98) 57%, rgba(54,34,15,0.99) 100%), repeating-linear-gradient(106deg, rgba(255,255,255,0.075) 0 1px, transparent 1px 11px)',
  boxShadow:
    'inset 0 0 0 1px rgba(255,222,143,0.68), inset 0 -14px 26px rgba(45,24,7,0.48), inset 0 10px 24px rgba(255,236,188,0.1), 0 0 24px rgba(224,154,52,0.2)',
};

const heartLayerStyle: React.CSSProperties = {
  clipPath: 'polygon(20% 6%, 80% 6%, 96% 72%, 50% 96%, 4% 72%)',
  background:
    'radial-gradient(circle at 61% 29%, rgba(255,247,222,0.14), transparent 22%), linear-gradient(90deg, rgba(13,17,18,0.99), rgba(29,42,39,0.99) 43%, rgba(86,91,82,0.98) 50%, rgba(35,49,45,0.99) 57%, rgba(12,16,17,1)), repeating-linear-gradient(126deg, transparent 0 13px, rgba(255,255,255,0.06) 14px 15px, transparent 16px 30px)',
  boxShadow:
    'inset 0 0 0 1px rgba(219,171,82,0.48), inset 0 14px 22px rgba(255,232,162,0.055), inset 0 -18px 26px rgba(0,0,0,0.56), 0 0 18px rgba(214,148,47,0.12)',
};

const baseLayerStyle: React.CSSProperties = {
  clipPath: 'polygon(15% 8%, 85% 8%, 99% 72%, 50% 98%, 1% 72%)',
  background:
    'radial-gradient(circle at 60% 28%, rgba(255,241,204,0.09), transparent 24%), linear-gradient(90deg, rgba(4,5,6,1), rgba(15,17,18,1) 41%, rgba(50,50,47,0.98) 50%, rgba(20,21,21,1) 59%, rgba(4,4,5,1)), repeating-linear-gradient(118deg, transparent 0 15px, rgba(255,255,255,0.05) 16px 17px, transparent 18px 35px)',
  boxShadow:
    'inset 0 0 0 1px rgba(214,146,53,0.52), inset 0 12px 18px rgba(255,231,175,0.035), inset 0 -24px 32px rgba(0,0,0,0.68), 0 20px 38px rgba(0,0,0,0.58), 0 0 24px rgba(214,148,47,0.12)',
};

function formatNotes(notes: string[]) {
  return notes.length > 0 ? notes.join(', ') : 'No notes detected.';
}

function MagneticTether({
  className,
  active,
}: {
  className: string;
  active: boolean;
}) {
  return (
    <motion.div
      aria-hidden
      className={`pointer-events-none absolute left-1/2 z-40 h-8 w-14 -translate-x-1/2 ${className}`}
      animate={{ opacity: active ? 0.95 : 0.3, scaleY: active ? 1 : 0.78 }}
      transition={transition}
    >
      <span className="absolute left-[49%] top-1 h-7 w-px origin-top -rotate-[24deg] bg-gradient-to-b from-scent-accent/80 via-white/42 to-transparent shadow-[0_0_10px_rgba(201,139,44,0.45)]" />
      <span className="absolute right-[49%] top-1 h-7 w-px origin-top rotate-[24deg] bg-gradient-to-b from-scent-accent/80 via-white/42 to-transparent shadow-[0_0_10px_rgba(201,139,44,0.45)]" />
      <span className="absolute left-1/2 top-[44%] h-1.5 w-1.5 -translate-x-1/2 rounded-full border border-scent-accent/55 bg-black shadow-[0_0_12px_rgba(201,139,44,0.55)]" />
    </motion.div>
  );
}

export const NotePyramid: React.FC<NotePyramidProps> = ({
  topNotes,
  heartNotes,
  baseNotes,
  className = '',
}) => {
  const [activeLayer, setActiveLayer] = React.useState<ActiveLayer | null>(null);
  const rootRef = React.useRef<HTMLElement | null>(null);
  const ignoreNextClickRef = React.useRef(false);
  const prefersReducedMotion = useReducedMotion();
  const state = activeLayer ?? 'idle';

  React.useEffect(() => {
    if (!activeLayer) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActiveLayer(null);
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!root || !(event.target instanceof Node) || root.contains(event.target)) return;
      setActiveLayer(null);
    };

    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [activeLayer]);

  const layers: LayerConfig[] = [
    {
      key: 'top',
      title: 'Top Notes',
      ariaLabel: 'Reveal top notes',
      notes: topNotes,
      positionClass: 'left-[30%] top-[5%] h-[26%] w-[40%]',
      seamClass: 'top-[28%]',
      zIndex: 30,
      style: topLayerStyle,
    },
    {
      key: 'heart',
      title: 'Heart Notes',
      ariaLabel: 'Reveal heart notes',
      notes: heartNotes,
      positionClass: 'left-[20%] top-[30%] h-[27%] w-[60%]',
      seamClass: 'top-[53%]',
      zIndex: 20,
      style: heartLayerStyle,
    },
    {
      key: 'base',
      title: 'Base Notes',
      ariaLabel: 'Reveal base notes',
      notes: baseNotes,
      positionClass: 'left-[7%] top-[55%] h-[32%] w-[86%]',
      seamClass: 'top-[78%]',
      zIndex: 10,
      style: baseLayerStyle,
    },
  ];

  const selectedLayer = layers.find((layer) => layer.key === activeLayer);
  const handleLayerActivate = React.useCallback((layer: ActiveLayer) => {
    setActiveLayer((current) => (current === layer ? null : layer));
  }, []);

  return (
    <section
      ref={rootRef}
      className={`flex h-full min-h-0 flex-col items-center justify-center px-3 py-5 sm:px-5 ${className}`}
      onClick={() => setActiveLayer(null)}
    >
      <div
        className="relative w-full max-w-[23rem] aspect-[1/1.05] shrink-0 sm:max-w-[25rem]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="absolute left-1/2 top-[2%] h-[92%] w-px -translate-x-1/2 bg-gradient-to-b from-transparent via-scent-accent/28 to-transparent" />
        <div className="absolute inset-x-[5%] bottom-[1%] h-[22%] rounded-[50%] bg-[radial-gradient(ellipse_at_center,rgba(216,151,49,0.24),rgba(216,151,49,0.06)_42%,transparent_72%)] blur-sm" />
        <div className="absolute inset-x-[12%] bottom-[8%] h-[9%] rounded-[50%] border border-scent-accent/16 bg-black/20 shadow-[0_18px_44px_rgba(0,0,0,0.7)]" />

        <MagneticTether className="top-[25%]" active={activeLayer === 'top' || activeLayer === 'heart'} />
        <MagneticTether className="top-[50%]" active={activeLayer === 'heart' || activeLayer === 'base'} />

        {layers.map((layer) => {
          const isActive = activeLayer === layer.key;
          const isMuted = Boolean(activeLayer && !isActive);
          return (
            <motion.button
              key={layer.key}
              type="button"
              aria-label={layer.ariaLabel}
              aria-pressed={isActive}
              className={`group/layer absolute cursor-pointer touch-manipulation select-none border-0 p-0 outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80 focus-visible:ring-offset-2 focus-visible:ring-offset-black ${layer.positionClass}`}
              style={{
                ...layer.style,
                zIndex: layer.zIndex,
                filter: `drop-shadow(0 8px 16px rgba(0,0,0,0.48)) ${
                  isActive ? 'brightness(1.14) saturate(1.08)' : isMuted ? 'brightness(0.72) saturate(0.72)' : 'brightness(0.98)'
                }`,
                WebkitTapHighlightColor: 'transparent',
                touchAction: 'manipulation',
              }}
              animate={{
                y: layerMotion[state][layer.key],
                scale: isActive ? 1.012 : 1,
              }}
              transition={prefersReducedMotion ? { duration: 0.01 } : transition}
              onClick={(event) => {
                event.stopPropagation();
                if (ignoreNextClickRef.current) {
                  ignoreNextClickRef.current = false;
                  return;
                }
                handleLayerActivate(layer.key);
              }}
              onPointerUp={(event) => {
                if (event.pointerType === 'mouse') return;
                event.stopPropagation();
                ignoreNextClickRef.current = true;
                handleLayerActivate(layer.key);
              }}
            >
              <span className="absolute left-1/2 top-[7%] h-[86%] w-px -translate-x-1/2 bg-gradient-to-b from-white/72 via-[#fff0c8]/62 to-transparent opacity-70" />
              <span className="absolute inset-x-[9%] top-[8%] h-px bg-gradient-to-r from-transparent via-[#f1bd63]/80 to-transparent opacity-80" />
              <span className="absolute inset-x-[10%] bottom-[16%] h-px bg-gradient-to-r from-transparent via-black/70 to-transparent opacity-80" />
              <span className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.04)_0%,transparent_34%,rgba(255,247,222,0.09)_50%,transparent_66%,rgba(0,0,0,0.22)_100%)]" />
              <span className={`absolute inset-0 transition-opacity duration-300 ${isActive ? 'opacity-100' : 'opacity-0 group-hover/layer:opacity-70'} bg-[radial-gradient(circle_at_50%_70%,rgba(244,180,72,0.22),transparent_44%)]`} />
            </motion.button>
          );
        })}

        <AnimatePresence mode="wait">
          {selectedLayer ? (
            <motion.div
              key={selectedLayer.key}
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              className={`absolute left-1/2 z-50 w-[84%] max-w-[20rem] -translate-x-1/2 ${selectedLayer.seamClass}`}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="border border-scent-accent/28 bg-black/70 px-3.5 py-3 text-center shadow-[0_14px_34px_rgba(0,0,0,0.58),0_0_26px_rgba(201,139,44,0.2),inset_0_1px_0_rgba(255,231,179,0.12)] backdrop-blur-md">
                <p className="text-[9px] font-bold uppercase tracking-[0.24em] text-scent-accent/88">
                  {selectedLayer.title}
                </p>
                <p className="mx-auto mt-1.5 max-w-[18rem] font-serif text-sm italic leading-snug text-white/82 sm:text-[0.95rem]">
                  {formatNotes(selectedLayer.notes)}
                </p>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="idle-pulse"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="pointer-events-none absolute left-1/2 top-[91%] z-50 flex -translate-x-1/2 items-center gap-2"
            >
              <span className="h-px w-10 bg-gradient-to-r from-transparent to-scent-accent/45" />
              <span className="h-1.5 w-1.5 rounded-full border border-scent-accent/40 bg-black shadow-[0_0_10px_rgba(201,139,44,0.38)]" />
              <span className="h-px w-10 bg-gradient-to-l from-transparent to-scent-accent/45" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
};
