import React, { useMemo } from 'react';
import { Check, Eye, Plus, Sparkles } from 'lucide-react';
import type {
  BeamCard as BeamCardData,
  BeamCardFragrance,
  BeamProposalItem,
  BeamScentVector,
} from '@/lib/beamAgentClient';

/**
 * Renders a native UI card the Beam Agent chose to surface mid-conversation.
 * Every datum is server-resolved from a real catalog/vault record (see the
 * `beam_show_scent_profile` / `beam_compare_fragrances` / `beam_present_travel_kit`
 * tools), so this component only presents — it never fabricates a value. The
 * visual language matches the mission panel's reveal card: gold accent on dark
 * glass, serif italic names, `scent-type-label` micro-caps.
 */

type BeamCardProps = {
  card: BeamCardData;
  /** Reduced-motion / iPad performance mode: drop the entrance animation. */
  calmMotion?: boolean;
  /** Add the travel-kit's new lane to the vault (host owns the wardrobe write). */
  onAddNewPicks?: (items: BeamProposalItem[], proposalId?: string) => void;
  /** Open one new pick in the wardrobe detail card (host-provided). */
  onViewItem?: (item: BeamProposalItem) => void;
  /** This kit's new lane has already been curated — flip Add to an "Added" state. */
  added?: boolean;
};

const AXES: Array<{ key: keyof BeamScentVector; label: string }> = [
  { key: 'freshness', label: 'Fresh' },
  { key: 'sweetness', label: 'Sweet' },
  { key: 'woodiness', label: 'Woody' },
  { key: 'spice', label: 'Spice' },
  { key: 'warmth', label: 'Warm' },
  { key: 'musk', label: 'Musk' },
];

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Whether a scent vector carries enough signal to chart. A present-but-all-zero
 * (or near-zero) vector would draw a radar collapsed to a single center dot — it
 * reads as a rendering bug, so we fall back to accord chips instead.
 */
function vectorHasSignal(vector: BeamScentVector | undefined): boolean {
  if (!vector) return false;
  const total = AXES.reduce((sum, axis) => sum + clamp01(vector[axis.key]), 0);
  return total > 0.15;
}

/** Outer card shell — one consistent frame for all card kinds. */
function CardShell({
  label,
  testId,
  ariaLabel,
  children,
}: {
  label: string;
  testId: string;
  ariaLabel: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      className="max-w-[92%] self-start rounded-[calc(var(--radius-scent)-10px)] border border-scent-accent/32 bg-[linear-gradient(180deg,rgba(212,175,55,0.07),rgba(0,0,0,0.28))] p-4 text-left"
      data-testid={testId}
      role="group"
      aria-label={ariaLabel}
    >
      <p className="scent-type-label flex items-center gap-1.5 text-scent-accent">
        <Sparkles size={12} aria-hidden />
        {label}
      </p>
      {children}
    </div>
  );
}

/** Small accord pills, shared across cards. */
function AccordChips({ accords }: { accords: string[] }): React.ReactElement | null {
  if (accords.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {accords.slice(0, 6).map((accord) => (
        <li
          key={accord}
          className="rounded-full border border-scent-accent/22 bg-scent-accent/[0.06] px-2 py-0.5 scent-type-label text-[10px] text-scent-text-muted"
        >
          {accord}
        </li>
      ))}
    </ul>
  );
}

/**
 * The 6-axis scent fingerprint as a hexagonal radar. Pure SVG (no canvas/RAF) so
 * it is static for screenshots and friendly to reduced-motion and agent vision.
 */
function ScentRadar({ vector, size = 168 }: { vector: BeamScentVector; size?: number }): React.ReactElement {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 28; // leave room for labels
  const geometry = useMemo(() => {
    const angleFor = (i: number): number => (-90 + i * 60) * (Math.PI / 180);
    const pointAt = (i: number, radius: number): [number, number] => [
      cx + radius * Math.cos(angleFor(i)),
      cy + radius * Math.sin(angleFor(i)),
    ];
    const rings = [0.33, 0.66, 1].map((scale) =>
      AXES.map((_, i) => pointAt(i, r * scale).join(',')).join(' '),
    );
    const valuePoints = AXES.map((axis, i) => pointAt(i, r * clamp01(vector[axis.key]))).map((p) => p.join(','));
    const labels = AXES.map((axis, i) => {
      const [lx, ly] = pointAt(i, r + 11);
      return { label: axis.label, x: lx, y: ly };
    });
    return { rings, valuePoints: valuePoints.join(' '), labels, pointAt };
  }, [cx, cy, r, vector]);

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      className="mx-auto block"
      role="img"
      aria-label="Scent profile radar across six axes"
    >
      {geometry.rings.map((ring, i) => (
        <polygon
          key={i}
          points={ring}
          fill="none"
          stroke="rgba(212,175,55,0.16)"
          strokeWidth={1}
        />
      ))}
      {AXES.map((_, i) => {
        const [x, y] = geometry.pointAt(i, r);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="rgba(212,175,55,0.12)" strokeWidth={1} />;
      })}
      <polygon
        points={geometry.valuePoints}
        fill="rgba(212,175,55,0.22)"
        stroke="rgba(212,175,55,0.85)"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      {geometry.labels.map((l) => (
        <text
          key={l.label}
          x={l.x}
          y={l.y}
          fill="rgba(255,247,236,0.62)"
          fontSize={9}
          textAnchor="middle"
          dominantBaseline="middle"
          style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}
        >
          {l.label}
        </text>
      ))}
    </svg>
  );
}

/** Compact horizontal bars for the 6 axes — used in the compare columns. */
function AxisBars({ vector }: { vector: BeamScentVector }): React.ReactElement {
  return (
    <ul className="mt-2 flex flex-col gap-1">
      {AXES.map((axis) => {
        const value = clamp01(vector[axis.key]);
        return (
          <li key={axis.key} className="flex items-center gap-1.5">
            <span className="w-9 shrink-0 scent-type-label text-[9px] text-scent-text-subtle">{axis.label}</span>
            <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-scent-accent/70"
                style={{ width: `${Math.round(value * 100)}%` }}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function FragranceHeading({ fragrance }: { fragrance: BeamCardFragrance }): React.ReactElement {
  return (
    <>
      {fragrance.brand ? (
        <p className="mt-2 font-serif text-[10px] uppercase tracking-[0.2em] text-scent-text-muted">{fragrance.brand}</p>
      ) : null}
      <p className="font-serif italic text-xl leading-tight text-[#fff7ec]">
        {fragrance.name}
        {fragrance.owned ? (
          <span className="ml-2 align-middle rounded-full border border-scent-accent/30 bg-scent-accent/[0.08] px-1.5 py-0.5 scent-type-label text-[9px] text-scent-accent">
            In vault
          </span>
        ) : null}
      </p>
    </>
  );
}

const BAND_COPY: Record<'high' | 'moderate' | 'some' | 'low', string> = {
  high: 'High overlap',
  moderate: 'Moderate overlap',
  some: 'Some overlap',
  low: 'Low overlap',
};

function ScentProfileCard({ card }: { card: Extract<BeamCardData, { kind: 'scent_profile' }> }): React.ReactElement {
  const { fragrance, pyramid, caption } = card;
  return (
    <CardShell label="Scent profile" testId="beam-card-scent-profile" ariaLabel={`Scent profile for ${fragrance.name}`}>
      <FragranceHeading fragrance={fragrance} />
      {vectorHasSignal(fragrance.scentVector) ? (
        <>
          <ScentRadar vector={fragrance.scentVector!} />
          <AccordChips accords={fragrance.accords} />
        </>
      ) : (
        <AccordChips accords={fragrance.accords} />
      )}
      {pyramid && (pyramid.top.length || pyramid.heart.length || pyramid.base.length) ? (
        <dl className="mt-3 flex flex-col gap-1 border-t border-scent-accent/12 pt-2.5">
          {([['Top', pyramid.top], ['Heart', pyramid.heart], ['Base', pyramid.base]] as const).map(([tier, notes]) =>
            notes.length ? (
              <div key={tier} className="flex gap-2">
                <dt className="w-9 shrink-0 scent-type-label text-[9px] text-scent-text-subtle">{tier}</dt>
                <dd className="min-w-0 flex-1 text-[12px] text-scent-text-muted">{notes.join(', ')}</dd>
              </div>
            ) : null,
          )}
        </dl>
      ) : null}
      {caption ? <p className="mt-3 text-[12.5px] italic leading-relaxed text-scent-text-muted">{caption}</p> : null}
    </CardShell>
  );
}

function CompareColumn({ fragrance }: { fragrance: BeamCardFragrance }): React.ReactElement {
  return (
    <div className="min-w-0 flex-1">
      <p className="truncate font-serif italic text-[13px] leading-tight text-[#fff7ec] sm:text-[15px]">{fragrance.name}</p>
      <p className="truncate scent-type-label text-[9px] text-scent-text-subtle">{fragrance.brand}</p>
      {fragrance.owned ? (
        <p className="mt-1 scent-type-label text-[9px] text-scent-accent">In your vault</p>
      ) : null}
      {vectorHasSignal(fragrance.scentVector) ? (
        <AxisBars vector={fragrance.scentVector!} />
      ) : (
        <AccordChips accords={fragrance.accords} />
      )}
    </div>
  );
}

function CompareCard({ card }: { card: Extract<BeamCardData, { kind: 'compare' }> }): React.ReactElement {
  return (
    <CardShell label="Side by side" testId="beam-card-compare" ariaLabel={`Comparing ${card.a.name} and ${card.b.name}`}>
      <div className="mt-2 flex items-start gap-3">
        <CompareColumn fragrance={card.a} />
        <div className="w-px self-stretch bg-gradient-to-b from-transparent via-scent-accent/20 to-transparent" aria-hidden />
        <CompareColumn fragrance={card.b} />
      </div>
      <div className="mt-3 flex items-center justify-center gap-2 border-t border-scent-accent/12 pt-2.5">
        <span
          className="rounded-full border border-scent-accent/32 bg-scent-accent/[0.08] px-2.5 py-1 scent-type-label text-[10px] text-scent-accent"
          aria-label={`${card.overlapPercent} percent overlap, ${BAND_COPY[card.band]}`}
        >
          {card.overlapPercent}% · {BAND_COPY[card.band]}
        </span>
      </div>
      {card.sharedNotes.length || card.sharedAccords.length ? (
        <p className="mt-2 text-center text-[11.5px] text-scent-text-muted">
          <span className="scent-type-label text-[9px] text-scent-text-subtle">Shared&nbsp;</span>
          {[...card.sharedNotes, ...card.sharedAccords].slice(0, 6).join(', ')}
        </p>
      ) : null}
      {card.verdict ? (
        <p className="mt-2 text-center text-[12.5px] italic leading-relaxed text-scent-text-muted">{card.verdict}</p>
      ) : null}
    </CardShell>
  );
}

function TravelKitCard({
  card,
  onAddNewPicks,
  onViewItem,
  added,
}: {
  card: Extract<BeamCardData, { kind: 'travel_kit' }>;
  onAddNewPicks?: (items: BeamProposalItem[], proposalId?: string) => void;
  onViewItem?: (item: BeamProposalItem) => void;
  added?: boolean;
}): React.ReactElement {
  return (
    <CardShell
      label={card.title ? `${card.title} kit` : 'Your kit'}
      testId="beam-card-travel-kit"
      ariaLabel={card.title ? `${card.title} travel kit` : 'Your travel kit'}
    >
      {card.ownedPicks.length > 0 ? (
        <section className="mt-2.5">
          <p className="scent-type-label text-[9px] text-scent-text-subtle">From your vault</p>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {card.ownedPicks.map((pick, index) => (
              <li key={`owned-${pick.brand}-${pick.name}-${index}`} className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="min-w-0 flex-1 truncate font-serif italic text-[13px] text-[#fff7ec]">{pick.name}</span>
                <span className="scent-type-label shrink-0 text-[9px] text-scent-text-subtle">{pick.brand}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {card.newPicks.length > 0 ? (
        <section className="mt-3 border-t border-scent-accent/12 pt-2.5">
          <p className="scent-type-label text-[9px] text-scent-text-subtle">New to try</p>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {card.newPicks.map((pick, index) => (
              <li key={`new-${pick.brand}-${pick.name}-${index}`} className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="min-w-0 flex-1 truncate font-serif italic text-[13px] text-[#fff7ec]">{pick.name}</span>
                <span className="scent-type-label shrink-0 text-[9px] text-scent-text-subtle">{pick.brand}</span>
                {onViewItem ? (
                  <button
                    type="button"
                    onClick={() => onViewItem(pick)}
                    aria-label={`View details for ${pick.name}`}
                    className="-my-1 inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full px-2 py-1 scent-type-label text-[10px] text-scent-accent transition-colors hover:text-[#fff7ec]"
                  >
                    <Eye size={13} aria-hidden />
                    <span>View</span>
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {onAddNewPicks ? (
            added ? (
              <p className="mt-3 inline-flex items-center gap-1.5 scent-type-label text-[10px] text-scent-accent">
                <Check size={13} aria-hidden />
                Added to your vault
              </p>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => onAddNewPicks(card.newPicks, card.proposalId)}
                  className="mt-3 inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-scent-accent/42 px-4 py-2 scent-type-chip text-[11px] text-[#fff7ec] transition-colors hover:bg-scent-accent/12"
                >
                  <Plus size={14} aria-hidden />
                  {card.newPicks.length > 1 ? `Add ${card.newPicks.length} new to vault` : 'Add new to vault'}
                </button>
                <p className="mt-2 flex items-center gap-1 scent-type-label text-[9px] text-scent-text-subtle">
                  <Check size={11} aria-hidden />
                  New picks save only when you tap Add to vault.
                </p>
              </>
            )
          ) : null}
        </section>
      ) : null}
    </CardShell>
  );
}

/** Dispatch a card payload to its renderer. Unknown kinds render nothing. */
export function BeamCard({ card, onAddNewPicks, onViewItem, added }: BeamCardProps): React.ReactElement | null {
  switch (card.kind) {
    case 'scent_profile':
      return <ScentProfileCard card={card} />;
    case 'compare':
      return <CompareCard card={card} />;
    case 'travel_kit':
      return <TravelKitCard card={card} onAddNewPicks={onAddNewPicks} onViewItem={onViewItem} added={added} />;
    default:
      return null;
  }
}

export default BeamCard;
