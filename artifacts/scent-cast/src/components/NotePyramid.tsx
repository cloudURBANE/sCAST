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
  zIndex: number;
  style: React.CSSProperties;
};

const layerMotion: Record<ActiveLayer | 'idle', Record<ActiveLayer, number>> = {
  idle: { top: 0, heart: 0, base: 0 },
  top: { top: -38, heart: 0, base: 0 },
  heart: { top: -30, heart: 0, base: 30 },
  base: { top: -36, heart: -34, base: 0 },
};

const transition = {
  duration: 0.42,
  ease: [0.22, 1, 0.36, 1],
} as const;

const topLayerStyle: React.CSSProperties = {
  clipPath: 'polygon(50% 2%, 94% 88%, 50% 100%, 6% 88%)',
  background:
    'radial-gradient(circle at 62% 28%, rgba(255,238,174,0.38), transparent 24%), linear-gradient(90deg, rgba(83,49,11,0.96) 0%, rgba(139,85,20,0.95) 47%, rgba(249,200,94,0.98) 51%, rgba(120,71,15,0.98) 100%), repeating-linear-gradient(135deg, rgba(255,255,255,0.08) 0 1px, transparent 1px 10px)',
  boxShadow:
    'inset 0 0 0 1px rgba(255,222,143,0.64), inset 0 -16px 30px rgba(61,30,5,0.44), 0 0 24px rgba(224,154,52,0.23)',
};

const heartLayerStyle: React.CSSProperties = {
  clipPath: 'polygon(22% 7%, 78% 7%, 96% 73%, 50% 96%, 4% 73%)',
  background:
    'radial-gradient(circle at 64% 31%, rgba(255,255,255,0.13), transparent 23%), linear-gradient(90deg, rgba(22,31,29,0.98), rgba(31,49,43,0.98) 48%, rgba(75,87,79,0.96) 52%, rgba(18,25,23,0.99)), repeating-linear-gradient(130deg, transparent 0 14px, rgba(255,255,255,0.055) 15px 16px, transparent 17px 31px)',
  boxShadow:
    'inset 0 0 0 1px rgba(219,171,82,0.42), inset 0 15px 22px rgba(255,232,162,0.04), inset 0 -18px 26px rgba(0,0,0,0.5), 0 0 18px rgba(214,148,47,0.12)',
};

const baseLayerStyle: React.CSSProperties = {
  clipPath: 'polygon(17% 8%, 83% 8%, 98% 72%, 50% 97%, 2% 72%)',
  background:
    'radial-gradient(circle at 62% 29%, rgba(255,255,255,0.08), transparent 26%), linear-gradient(90deg, rgba(6,7,7,0.99), rgba(17,19,20,0.99) 48%, rgba(45,45,43,0.95) 52%, rgba(8,8,8,1)), repeating-linear-gradient(120deg, transparent 0 16px, rgba(255,255,255,0.045) 17px 18px, transparent 19px 35px)',
  boxShadow:
    'inset 0 0 0 1px rgba(214,146,53,0.44), inset 0 -22px 30px rgba(0,0,0,0.58), 0 20px 34px rgba(0,0,0,0.44), 0 0 22px rgba(214,148,47,0.13)',
};

function formatNotes(notes: string[]) {
  return notes.length > 0 ? notes.join(', ') : 'No notes detected.';
}

export const NotePyramid: React.FC<NotePyramidProps> = ({
  topNotes,
  heartNotes,
  baseNotes,
  className = '',
}) => {
  const [activeLayer, setActiveLayer] = React.useState<ActiveLayer | null>(null);
  const rootRef = React.useRef<HTMLElement | null>(null);
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
      positionClass: 'left-[32%] top-[8%] h-[32%] w-[36%]',
      zIndex: 30,
      style: topLayerStyle,
    },
    {
      key: 'heart',
      title: 'Heart Notes',
      ariaLabel: 'Reveal heart notes',
      notes: heartNotes,
      positionClass: 'left-[23%] top-[37%] h-[27%] w-[54%]',
      zIndex: 20,
      style: heartLayerStyle,
    },
    {
      key: 'base',
      title: 'Base Notes',
      ariaLabel: 'Reveal base notes',
      notes: baseNotes,
      positionClass: 'left-[12%] top-[57%] h-[32%] w-[76%]',
      zIndex: 10,
      style: baseLayerStyle,
    },
  ];

  const selectedLayer = layers.find((layer) => layer.key === activeLayer);

  return (
    <section
      ref={rootRef}
      className={`flex h-full min-h-0 flex-col items-center justify-center px-3 py-3 sm:px-5 ${className}`}
      onClick={() => setActiveLayer(null)}
    >
      <div className="mb-2.5 h-px w-full max-w-[21rem] bg-gradient-to-r from-transparent via-scent-accent/52 to-transparent shadow-[0_0_14px_rgba(201,139,44,0.22)]" />

      <div
        className="relative w-full max-w-[24rem] aspect-[1.85/1] shrink-0"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="absolute inset-x-[14%] bottom-[2%] h-[18%] rounded-[50%] bg-[radial-gradient(ellipse_at_center,rgba(216,151,49,0.22),rgba(216,151,49,0.05)_42%,transparent_70%)] blur-sm" />
        {layers.map((layer) => {
          const isActive = activeLayer === layer.key;
          return (
            <motion.button
              key={layer.key}
              type="button"
              aria-label={layer.ariaLabel}
              aria-pressed={isActive}
              className={`group/layer absolute cursor-pointer border-0 p-0 outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80 focus-visible:ring-offset-2 focus-visible:ring-offset-black ${layer.positionClass}`}
              style={{
                ...layer.style,
                zIndex: layer.zIndex,
                filter: `drop-shadow(0 8px 16px rgba(0,0,0,0.48)) ${
                  isActive ? 'brightness(1.12) saturate(1.08)' : 'brightness(0.98)'
                }`,
              }}
              animate={{ y: prefersReducedMotion ? 0 : layerMotion[state][layer.key] }}
              transition={prefersReducedMotion ? { duration: 0.01 } : transition}
              onClick={() => setActiveLayer((current) => (current === layer.key ? null : layer.key))}
            >
              <span className="absolute left-1/2 top-[8%] h-[84%] w-px -translate-x-1/2 bg-gradient-to-b from-white/78 via-[#fff0c8]/70 to-transparent opacity-65" />
              <span className="absolute inset-x-[7%] top-[8%] h-px bg-gradient-to-r from-transparent via-[#f1bd63]/80 to-transparent opacity-80" />
              <span className="absolute inset-0 opacity-0 transition-opacity duration-300 group-hover/layer:opacity-100 bg-[radial-gradient(circle_at_50%_72%,rgba(244,180,72,0.18),transparent_42%)]" />
            </motion.button>
          );
        })}
      </div>

      <div
        className="mt-2.5 flex min-h-[3.9rem] w-full max-w-[24rem] items-start justify-center text-center"
        onClick={(event) => event.stopPropagation()}
      >
        <AnimatePresence mode="wait">
          {selectedLayer ? (
            <motion.div
              key={selectedLayer.key}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              className="w-full"
            >
              <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-scent-accent">
                {selectedLayer.title}
              </p>
              <p className="mx-auto mt-1.5 max-w-[23rem] font-serif text-sm italic leading-relaxed text-white/76 sm:text-base">
                {formatNotes(selectedLayer.notes)}
              </p>
            </motion.div>
          ) : (
            <motion.p
              key="prompt"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="pt-2 text-[10px] font-bold uppercase tracking-[0.24em] text-white/28"
            >
              Tap a layer to reveal notes
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
};
