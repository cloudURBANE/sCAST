import React, { useMemo } from 'react';
import { Check, Eye, Plus, Sparkles } from 'lucide-react';
import { BottleImage } from '@/components/BottleImage';
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
  /** Add the travel-kit's new lane to the vault (host owns the wardrobe write). */
  onAddNewPicks?: (items: BeamProposalItem[], proposalId?: string) => void;
  /** Open one new pick in the wardrobe detail card (host-provided). */
  onViewItem?: (item: BeamProposalItem) => void;
  /** This kit's new lane has already been curated — flip Add to an "Added" state. */
  added?: boolean;
  /**
   * A vault curation is currently in flight (this kit's or another's). The Add
   * button disables so it never reads as tappable while the host handler would
   * silently drop the tap.
   */
  adding?: boolean;
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
      className="w-full min-w-0 max-w-[92%] self-start overflow-hidden rounded-[calc(var(--radius-scent)-10px)] border border-scent-accent/32 bg-[linear-gradient(180deg,rgba(212,175,55,0.07),rgba(0,0,0,0.28))] p-4 text-left"
      data-testid={testId}
      role="group"
      aria-label={ariaLabel}
    >
      <p className="scent-type-label flex items-center justify-center gap-1.5 text-center text-scent-accent/90">
        <Sparkles size={12} aria-hidden className="shrink-0" />
        <span className="min-w-0 break-words">{label}</span>
      </p>
      {children}
    </div>
  );
}

/** Small accord pills, shared across cards. */
function AccordChips({ accords }: { accords: string[] }): React.ReactElement | null {
  if (accords.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap justify-center gap-1.5">
      {accords.slice(0, 6).map((accord) => (
        <li
          key={accord}
          className="max-w-full break-words rounded-full border border-scent-accent/22 bg-scent-accent/[0.06] px-2 py-0.5 scent-type-label text-[10px] text-scent-text-muted"
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
    const valueVertices = AXES.map((axis, i) => pointAt(i, r * clamp01(vector[axis.key])));
    const valuePoints = valueVertices.map((p) => p.join(','));
    const labels = AXES.map((axis, i) => {
      const [lx, ly] = pointAt(i, r + 11);
      return { label: axis.label, x: lx, y: ly };
    });
    return { rings, valuePoints: valuePoints.join(' '), valueVertices, labels, pointAt };
  }, [cx, cy, r, vector]);

  // Spell the six values out for assistive tech — the polygon alone is silent.
  const radarDescription = AXES.map(
    (axis) => `${axis.label} ${Math.round(clamp01(vector[axis.key]) * 100)}%`,
  ).join(', ');

  return (
    // Cap the radar at its natural 168px but let it shrink with the card so it
    // never forces horizontal overflow on a 320px (iPhone SE) column. The SVG
    // scales via its viewBox — no fixed pixel width/height attributes.
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="mx-auto mt-3 block h-auto w-full max-w-[168px]"
      role="img"
      aria-label={`Scent profile radar: ${radarDescription}`}
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
      {/* Vertex markers anchor each axis reading so the shape is legible even
          where the polygon hugs the center. Static dots — no motion cost. */}
      {geometry.valueVertices.map(([vx, vy], i) => (
        <circle key={AXES[i].key} cx={vx} cy={vy} r={2} fill="rgba(212,175,55,0.9)" />
      ))}
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
        const percent = Math.round(value * 100);
        return (
          // The label + filled track only communicate visually; give assistive
          // tech the reading directly and hide the decorative spans.
          <li key={axis.key} className="flex items-center gap-1.5" aria-label={`${axis.label} ${percent}%`}>
            <span aria-hidden className="w-9 shrink-0 scent-type-label text-[9px] text-scent-text-subtle">{axis.label}</span>
            <span aria-hidden className="relative h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-scent-accent/70"
                style={{ width: `${percent}%` }}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Server-resolved bottle packshot for a card. Every card payload already
 * carries `imageUrl` (proxied, bg-removed, resized by the image pipeline) —
 * rendering it is what makes these cards read as the product, not a text log.
 * Renders nothing when the record has no image, so a chat card never shows the
 * dashed "No image" placeholder `BottleImage` uses on vault tiles.
 */
function CardPackshot({
  imageUrl,
  name,
  brand,
  className,
}: {
  imageUrl?: string;
  name: string;
  brand: string;
  className: string;
}): React.ReactElement | null {
  if (!imageUrl || !imageUrl.trim()) return null;
  return (
    <BottleImage
      src={imageUrl}
      alt={`${brand} ${name}`.trim()}
      variant="thumb"
      className={className}
    />
  );
}

function FragranceHeading({ fragrance }: { fragrance: BeamCardFragrance }): React.ReactElement {
  return (
    <>
      {fragrance.brand ? (
        <p className="mt-2 break-words text-center font-serif text-[10px] uppercase tracking-[0.2em] text-scent-text-muted">
          {fragrance.brand}
        </p>
      ) : null}
      <p className="break-words text-center font-serif italic text-xl leading-tight text-[#fff7ec]">
        {fragrance.name}
      </p>
      {fragrance.owned ? (
        <p className="mt-1.5 text-center">
          <span className="inline-flex items-center rounded-full border border-scent-accent/30 bg-scent-accent/[0.08] px-1.5 py-0.5 scent-type-label text-[9px] text-scent-accent/90">
            In vault
          </span>
        </p>
      ) : null}
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
  const hasVector = vectorHasSignal(fragrance.scentVector);
  const hasAccords = fragrance.accords.length > 0;
  const hasPyramid = Boolean(pyramid && (pyramid.top.length || pyramid.heart.length || pyramid.base.length));
  // A profile with no chartable vector, no accords, no pyramid, and no caption
  // would render an almost-empty card (just the name) — show a graceful line
  // instead of a hollow frame.
  const hasAnyDetail = hasVector || hasAccords || hasPyramid || Boolean(caption);

  return (
    <CardShell label="Scent profile" testId="beam-card-scent-profile" ariaLabel={`Scent profile for ${fragrance.name}`}>
      <CardPackshot
        imageUrl={fragrance.imageUrl}
        name={fragrance.name}
        brand={fragrance.brand}
        className="mx-auto mt-3 h-24 w-24"
      />
      <FragranceHeading fragrance={fragrance} />
      {hasVector ? <ScentRadar vector={fragrance.scentVector!} /> : null}
      {hasAccords ? <AccordChips accords={fragrance.accords} /> : null}
      {hasPyramid ? (
        <dl className="mt-3 flex flex-col gap-1.5 border-t border-scent-accent/12 pt-2.5 text-center">
          {([['Top', pyramid!.top], ['Heart', pyramid!.heart], ['Base', pyramid!.base]] as const).map(([tier, notes]) =>
            notes.length ? (
              <div key={tier}>
                <dt className="scent-type-label text-[9px] text-scent-text-subtle">{tier}</dt>
                <dd className="break-words text-[12px] text-scent-text-muted">{notes.join(', ')}</dd>
              </div>
            ) : null,
          )}
        </dl>
      ) : null}
      {caption ? (
        <p className="mt-3 break-words text-center text-[12.5px] italic leading-relaxed text-scent-text-muted">{caption}</p>
      ) : null}
      {!hasAnyDetail ? (
        <p className="mt-3 break-words text-center text-[12.5px] italic leading-relaxed text-scent-text-muted">
          Nothing to chart yet — the notes for this one aren&rsquo;t in the catalog.
        </p>
      ) : null}
    </CardShell>
  );
}

function CompareColumn({
  fragrance,
  imageSlot,
}: {
  fragrance: BeamCardFragrance;
  /** Keep both columns vertically aligned when EITHER side has a packshot. */
  imageSlot: boolean;
}): React.ReactElement {
  return (
    <div className="min-w-0 flex-1 text-center">
      {imageSlot ? (
        <div className="mx-auto mb-1.5 h-16 w-16">
          <CardPackshot
            imageUrl={fragrance.imageUrl}
            name={fragrance.name}
            brand={fragrance.brand}
            className="h-full w-full"
          />
        </div>
      ) : null}
      {/* Two-line clamp instead of a hard truncate: niche names ("Ombré Leather
          Parfum") stay legible without letting one column stretch the row. */}
      <p className="line-clamp-2 break-words font-serif italic text-[13px] leading-tight text-[#fff7ec] sm:text-[15px]">{fragrance.name}</p>
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

/** Case-insensitive dedupe preserving first casing — a term can arrive as both a shared note AND a shared accord. */
function dedupeSharedTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const key = term.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(term.trim());
  }
  return out;
}

function CompareCard({ card }: { card: Extract<BeamCardData, { kind: 'compare' }> }): React.ReactElement {
  const imageSlot = Boolean(card.a.imageUrl?.trim() || card.b.imageUrl?.trim());
  const sharedTerms = dedupeSharedTerms([...card.sharedNotes, ...card.sharedAccords]).slice(0, 6);
  return (
    <CardShell label="Side by side" testId="beam-card-compare" ariaLabel={`Comparing ${card.a.name} and ${card.b.name}`}>
      <div className="mt-2 flex items-start gap-3">
        <CompareColumn fragrance={card.a} imageSlot={imageSlot} />
        <div className="w-px self-stretch bg-gradient-to-b from-transparent via-scent-accent/20 to-transparent" aria-hidden />
        <CompareColumn fragrance={card.b} imageSlot={imageSlot} />
      </div>
      <div className="mt-3 flex items-center justify-center gap-2 border-t border-scent-accent/12 pt-2.5">
        <span
          className="max-w-full break-words rounded-full border border-scent-accent/32 bg-scent-accent/[0.08] px-2.5 py-1 text-center scent-type-label text-[10px] text-scent-accent"
          aria-label={`${card.overlapPercent} percent overlap, ${BAND_COPY[card.band]}`}
        >
          {card.overlapPercent}% · {BAND_COPY[card.band]}
        </span>
      </div>
      {sharedTerms.length > 0 ? (
        <p className="mt-2 break-words text-center text-[11.5px] text-scent-text-muted">
          <span className="scent-type-label text-[9px] text-scent-text-subtle">Shared&nbsp;</span>
          {sharedTerms.join(', ')}
        </p>
      ) : null}
      {card.verdict ? (
        <p className="mt-2 break-words text-center text-[12.5px] italic leading-relaxed text-scent-text-muted">
          {card.verdict}
        </p>
      ) : null}
    </CardShell>
  );
}

function TravelKitCard({
  card,
  onAddNewPicks,
  onViewItem,
  added,
  adding,
}: {
  card: Extract<BeamCardData, { kind: 'travel_kit' }>;
  onAddNewPicks?: (items: BeamProposalItem[], proposalId?: string) => void;
  onViewItem?: (item: BeamProposalItem) => void;
  added?: boolean;
  adding?: boolean;
}): React.ReactElement {
  // Per-lane image slots: rows only reserve the packshot column when at least
  // one pick in that lane actually has artwork, so an art-less kit keeps the
  // original tight text alignment.
  const ownedLaneHasImages = card.ownedPicks.some((pick) => pick.imageUrl?.trim());
  const newLaneHasImages = card.newPicks.some((pick) => pick.imageUrl?.trim());
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
              <li
                key={`owned-${pick.brand}-${pick.name}-${index}`}
                // Center only when a packshot sits in the row; art-less lanes
                // keep the original baseline alignment untouched.
                className={`flex min-w-0 ${ownedLaneHasImages ? 'items-center' : 'items-baseline'} justify-between gap-3`}
              >
                {ownedLaneHasImages ? (
                  <span className="h-9 w-8 shrink-0">
                    <CardPackshot imageUrl={pick.imageUrl} name={pick.name} brand={pick.brand} className="h-full w-full" />
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate font-serif italic text-[13px] text-[#fff7ec]">{pick.name}</span>
                <span className="max-w-[45%] shrink-0 truncate scent-type-label text-[9px] text-scent-text-subtle">{pick.brand}</span>
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
              <li
                key={`new-${pick.brand}-${pick.name}-${index}`}
                className={`flex min-w-0 ${newLaneHasImages ? 'items-center' : 'items-baseline'} justify-between gap-2 sm:gap-3`}
              >
                {newLaneHasImages ? (
                  <span className="h-9 w-8 shrink-0">
                    <CardPackshot imageUrl={pick.imageUrl} name={pick.name} brand={pick.brand} className="h-full w-full" />
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate font-serif italic text-[13px] text-[#fff7ec]">{pick.name}</span>
                <span className="max-w-[35%] shrink-0 truncate scent-type-label text-[9px] text-scent-text-subtle">{pick.brand}</span>
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
              <p className="mt-3 flex items-center justify-center gap-1.5 scent-type-label text-[10px] text-scent-accent">
                <Check size={13} aria-hidden />
                Added to your vault
              </p>
            ) : (
              <div className="mt-3 flex flex-col items-center text-center">
                <button
                  type="button"
                  onClick={() => onAddNewPicks(card.newPicks, card.proposalId)}
                  disabled={adding}
                  className="inline-flex min-h-11 max-w-full items-center justify-center gap-1.5 rounded-full border border-scent-accent/42 px-4 py-2 text-center scent-type-chip text-[11px] text-[#fff7ec] transition-colors hover:bg-scent-accent/12 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Plus size={14} aria-hidden className="shrink-0" />
                  <span className="min-w-0 break-words">
                    {card.newPicks.length > 1 ? `Add ${card.newPicks.length} new to vault` : 'Add new to vault'}
                  </span>
                </button>
                <p className="mt-2 break-words scent-type-label text-[9px] text-scent-text-subtle/65">
                  New picks save only when you tap Add to vault.
                </p>
              </div>
            )
          ) : null}
        </section>
      ) : null}
    </CardShell>
  );
}

/** Dispatch a card payload to its renderer. Unknown kinds render nothing. */
function BeamCardImpl({ card, onAddNewPicks, onViewItem, added, adding }: BeamCardProps): React.ReactElement | null {
  switch (card.kind) {
    case 'scent_profile':
      return <ScentProfileCard card={card} />;
    case 'compare':
      return <CompareCard card={card} />;
    case 'travel_kit':
      return (
        <TravelKitCard
          card={card}
          onAddNewPicks={onAddNewPicks}
          onViewItem={onViewItem}
          added={added}
          adding={adding}
        />
      );
    default:
      return null;
  }
}

/**
 * Memoized so card-type Beam messages (radar SVGs, compare tables, travel kits)
 * don't re-render on every composer keystroke. The parent panel re-renders on
 * each input change, but BeamCard's props (card, the useCallback-stable
 * onAddNewPicks/onViewItem, and the by-value `added`) are referentially stable,
 * so the shallow compare skips untouched cards.
 */
export const BeamCard = React.memo(BeamCardImpl);

export default BeamCard;
