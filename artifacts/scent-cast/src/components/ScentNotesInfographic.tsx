import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Wind, Droplets, Leaf } from 'lucide-react';
import {
  collectMainAccordDisplayRows,
  type DerivedMetrics,
} from '@/lib/fragranceApi';

interface ScentNotesInfographicProps {
  /** Preferred — Railway `derived_metrics.notes` (+ main accords summary). */
  derivedMetrics?: DerivedMetrics | null;
  /** Legacy wardrobe pyramid when engine notes are absent. */
  legacyPyramid?: {
    top: string[];
    heart: string[];
    base: string[];
  };
}

const LAYER_INFO = {
  top: {
    title: "Top Notes",
    subtitle: "The Opening",
    description: "The first impression. Light, volatile molecules that evaporate within 15-30 minutes.",
    icon: Wind,
    color: "from-blue-200/20 to-blue-400/20",
    textColor: "text-blue-100"
  },
  heart: {
    title: "Heart Notes",
    subtitle: "The Soul",
    description: "The core personality. Develops after top notes fade, lasting 2-4 hours.",
    icon: Leaf,
    color: "from-emerald-200/20 to-emerald-400/20",
    textColor: "text-emerald-100"
  },
  base: {
    title: "Base Notes",
    subtitle: "The Foundation",
    description: "The lasting trail. Deep, heavy molecules that anchor the scent for 6+ hours.",
    icon: Droplets,
    color: "from-amber-200/20 to-amber-400/20",
    textColor: "text-amber-100"
  }
};

function resolvePyramid(
  derivedMetrics?: DerivedMetrics | null,
  legacy?: ScentNotesInfographicProps["legacyPyramid"],
): { top: string[]; heart: string[]; base: string[] } {
  const n = derivedMetrics?.notes;
  if (n) {
    return {
      top: [...(n.top ?? [])].filter(Boolean),
      heart: [...(n.heart ?? [])].filter(Boolean),
      base: [...(n.base ?? [])].filter(Boolean),
    };
  }
  if (legacy) {
    return {
      top: [...(legacy.top ?? [])].filter(Boolean),
      heart: [...(legacy.heart ?? [])].filter(Boolean),
      base: [...(legacy.base ?? [])].filter(Boolean),
    };
  }
  return { top: [], heart: [], base: [] };
}

function pyramidHasAnyNotes(p: { top: string[]; heart: string[]; base: string[] }): boolean {
  return p.top.length > 0 || p.heart.length > 0 || p.base.length > 0;
}

export const ScentNotesInfographic: React.FC<ScentNotesInfographicProps> = ({
  derivedMetrics,
  legacyPyramid,
}) => {
  const [hoveredLayer, setHoveredLayer] = React.useState<keyof typeof LAYER_INFO | null>(null);
  const levels = ['top', 'heart', 'base'] as const;
  const anchors = { top: { x: 200, y: 100 }, heart: { x: 200, y: 200 }, base: { x: 200, y: 310 } };

  const pyramid = resolvePyramid(derivedMetrics, legacyPyramid);
  const accordRows = collectMainAccordDisplayRows(derivedMetrics?.main_accords);
  const accordSummary = derivedMetrics?.main_accords?.accord_summary?.trim() ?? '';
  const hasAccordVisual = accordRows.length > 0 || Boolean(accordSummary);
  const hasPyramid = pyramidHasAnyNotes(pyramid);

  if (!hasPyramid && !hasAccordVisual) {
    return (
      <div
        id="scent-notes-infographic"
        className="relative w-full max-w-4xl mx-auto py-12 px-4 border border-white/10 bg-white/[0.02] rounded-[2rem] text-center"
      >
        <p className="text-sm italic text-white/45 font-serif">Notes unavailable for this fragrance.</p>
      </div>
    );
  }

  return (
    <div id="scent-notes-infographic" className="relative w-full max-w-4xl mx-auto py-12 px-4 select-none outline-none">
      {accordSummary ? (
        <p className="text-center text-sm sm:text-base italic text-white/68 font-serif leading-relaxed mb-10 max-w-2xl mx-auto">
          {accordSummary}
        </p>
      ) : null}
      {hasAccordVisual && accordRows.length > 0 ? (
        <div className="flex flex-wrap justify-center gap-2 mb-12">
          {accordRows.slice(0, 12).map((row) => (
            <span
              key={row.label}
              className="border border-scent-accent/22 bg-scent-accent/[0.06] px-3 py-1.5 text-[10px] uppercase tracking-[0.14em] text-white/70 font-bold rounded-full"
            >
              {typeof row.score === 'number' ? `${row.label} · ${Math.round(row.score)}` : row.label}
            </span>
          ))}
        </div>
      ) : null}

      {hasPyramid ? (
      <>
      <div className="flex flex-col lg:flex-row gap-16 items-start">
        <div className="relative w-full lg:w-[450px] aspect-square shrink-0">
          <svg viewBox="0 0 400 400" className="w-full h-full drop-shadow-[0_0_50px_rgba(255,255,255,0.03)] overflow-visible">
            <defs>
              <linearGradient id="grad-glass" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="rgba(255,255,255,0.08)" />
                <stop offset="100%" stopColor="rgba(255,255,255,0.02)" />
              </linearGradient>
            </defs>
            <motion.path
              d="M 200 40 L 265 140 L 135 140 Z"
              fill={hoveredLayer === 'top' ? 'rgba(59, 130, 246, 0.2)' : 'url(#grad-glass)'}
              stroke={hoveredLayer === 'top' ? 'rgba(59, 130, 246, 0.5)' : 'rgba(255,255,255,0.1)'}
              strokeWidth="1"
              className="cursor-pointer transition-colors duration-300"
              onMouseEnter={() => setHoveredLayer('top')}
              onMouseLeave={() => setHoveredLayer(null)}
              onClick={() => setHoveredLayer(hoveredLayer === 'top' ? null : 'top')}
              animate={{ scale: hoveredLayer === 'top' ? 1.08 : 1, y: hoveredLayer === 'top' ? -8 : 0 }}
              style={{ originX: "200px", originY: "90px" }}
              transition={{ type: "spring", stiffness: 300, damping: 20 }}
            />
            <motion.path
              d="M 135 145 L 265 145 L 330 250 L 70 250 Z"
              fill={hoveredLayer === 'heart' ? 'rgba(16, 185, 129, 0.15)' : 'url(#grad-glass)'}
              stroke={hoveredLayer === 'heart' ? 'rgba(16, 185, 129, 0.4)' : 'rgba(255,255,255,0.1)'}
              strokeWidth="1"
              className="cursor-pointer transition-colors duration-300"
              onMouseEnter={() => setHoveredLayer('heart')}
              onMouseLeave={() => setHoveredLayer(null)}
              onClick={() => setHoveredLayer(hoveredLayer === 'heart' ? null : 'heart')}
              animate={{ scale: hoveredLayer === 'heart' ? 1.05 : 1, y: hoveredLayer === 'heart' ? -4 : 0 }}
              style={{ originX: "200px", originY: "197px" }}
              transition={{ type: "spring", stiffness: 300, damping: 20 }}
            />
            <motion.path
              d="M 70 255 L 330 255 L 390 360 L 10 360 Z"
              fill={hoveredLayer === 'base' ? 'rgba(245, 158, 11, 0.15)' : 'url(#grad-glass)'}
              stroke={hoveredLayer === 'base' ? 'rgba(245, 158, 11, 0.4)' : 'rgba(255,255,255,0.1)'}
              strokeWidth="1"
              className="cursor-pointer transition-colors duration-300"
              onMouseEnter={() => setHoveredLayer('base')}
              onMouseLeave={() => setHoveredLayer(null)}
              onClick={() => setHoveredLayer(hoveredLayer === 'base' ? null : 'base')}
              animate={{ scale: hoveredLayer === 'base' ? 1.03 : 1, y: hoveredLayer === 'base' ? 4 : 0 }}
              style={{ originX: "200px", originY: "307px" }}
              transition={{ type: "spring", stiffness: 300, damping: 20 }}
            />
            <text x="200" y="115" textAnchor="middle" className="text-[10px] fill-white/20 uppercase tracking-[0.4em] font-sans font-bold pointer-events-none">Top</text>
            <text x="200" y="215" textAnchor="middle" className="text-[10px] fill-white/20 uppercase tracking-[0.4em] font-sans font-bold pointer-events-none">Heart</text>
            <text x="200" y="325" textAnchor="middle" className="text-[10px] fill-white/20 uppercase tracking-[0.4em] font-sans font-bold pointer-events-none">Base</text>
          </svg>

          <div className="absolute inset-0 pointer-events-none overflow-visible">
            <AnimatePresence>
              {hoveredLayer && (
                <motion.div key={`notes-${hoveredLayer}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0">
                  {pyramid[hoveredLayer].map((note, i) => {
                    const total = Math.max(pyramid[hoveredLayer].length, 1);
                    const angle = ((i / total) * 360 - 90) * (Math.PI / 180);
                    const radius = 170 + (i % 2 === 0 ? 10 : -10);
                    const anchor = anchors[hoveredLayer];
                    const tx = Math.cos(angle) * radius;
                    const ty = Math.sin(angle) * (radius * 0.6);
                    return (
                      <motion.div
                        key={`${hoveredLayer}-${note}-${i}`}
                        initial={{ opacity: 0, x: `${anchor.x}px`, y: `${anchor.y}px`, scale: 0.5 }}
                        animate={{ opacity: 1, x: `calc(${anchor.x}px + ${tx}px)`, y: `calc(${anchor.y}px + ${ty}px)`, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.5 }}
                        transition={{ type: "spring", stiffness: 150, damping: 15, delay: i * 0.04 }}
                        className="absolute -translate-x-1/2 -translate-y-1/2"
                        style={{ left: 0, top: 0 }}
                      >
                        <div className="flex items-center gap-2 px-3 py-1.5 bg-black/60 backdrop-blur-md border border-white/10 rounded-full shadow-xl">
                          <div className={`w-1.5 h-1.5 rounded-full bg-gradient-to-tr ${LAYER_INFO[hoveredLayer].color} animate-pulse`} />
                          <span className="text-[10px] font-serif italic text-white/90 whitespace-nowrap tracking-wide">{note}</span>
                        </div>
                      </motion.div>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        <div className="flex-1 min-h-[400px]">
          <AnimatePresence mode="wait">
            {hoveredLayer ? (
              <motion.div
                key={hoveredLayer}
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3, ease: "easeOut" }}
                className={`p-10 rounded-[2rem] border border-white/10 bg-gradient-to-br ${LAYER_INFO[hoveredLayer].color} backdrop-blur-3xl sticky top-24`}
              >
                <div className="flex items-center gap-6 mb-8">
                  <div className="p-4 bg-white/10 rounded-2xl shadow-inner">
                    {React.createElement(LAYER_INFO[hoveredLayer].icon, { size: 28, className: LAYER_INFO[hoveredLayer].textColor })}
                  </div>
                  <div>
                    <h3 className={`text-3xl font-serif italic ${LAYER_INFO[hoveredLayer].textColor} tracking-tight`}>{LAYER_INFO[hoveredLayer].title}</h3>
                    <p className="text-[11px] uppercase tracking-[0.4em] text-white/40 font-bold">{LAYER_INFO[hoveredLayer].subtitle}</p>
                  </div>
                </div>
                <div className="space-y-6">
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.2em] text-white/30 font-bold mb-3 font-sans">Molecular Role</p>
                    <p className="text-base text-white/80 leading-relaxed font-sans font-light">{LAYER_INFO[hoveredLayer].description}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.2em] text-white/30 font-bold mb-4 font-sans">Active Notes</p>
                    <div className="flex flex-wrap gap-2">
                      {pyramid[hoveredLayer].map((note, idx) => (
                        <div key={`${note}-${idx}`} className="px-4 py-2 bg-white/5 border border-white/10 rounded-xl text-xs italic text-white font-serif hover:bg-white/10 transition-colors">
                          {note}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className="p-12 rounded-[2rem] border border-white/5 bg-white/[0.02] flex flex-col items-center justify-center text-center h-full min-h-[400px] border-dashed"
              >
                <div className="relative mb-8">
                  <div className="absolute inset-0 bg-white/10 blur-3xl rounded-full" />
                  <Wind className="text-white/20 relative z-10 animate-pulse" size={64} strokeWidth={1} />
                </div>
                <h4 className="text-white font-serif italic text-2xl mb-4 tracking-tight">Digital Scent Map</h4>
                <p className="text-white/40 text-sm max-w-[280px] font-sans leading-relaxed">
                  The pyramid visualizes the temporal breakdown of sensory molecules. Hover or tap to analyze specific layers.
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-20 pt-10 border-t border-white/5">
        {levels.map(level => (
          <motion.div
            key={level}
            className={`p-6 rounded-2xl transition-all border ${hoveredLayer === level ? 'bg-white/5 border-white/20' : 'bg-transparent border-transparent'}`}
            onMouseEnter={() => setHoveredLayer(level)}
            onMouseLeave={() => setHoveredLayer(null)}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-2 h-2 rounded-full bg-gradient-to-tr ${LAYER_INFO[level].color}`} />
              <p className="text-[11px] uppercase tracking-[0.3em] text-white/60 font-bold">{level}</p>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-2">
              {pyramid[level].map((note, idx) => (
                <p key={`${note}-${idx}`} className="text-sm text-white/40 font-serif italic hover:text-white/80 transition-colors cursor-default">{note}</p>
              ))}
            </div>
          </motion.div>
        ))}
      </div>
      </>
      ) : null}
    </div>
  );
};
