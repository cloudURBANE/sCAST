import React, { useMemo } from 'react';
import {
  parseBeamMessage,
  type BeamBlock,
  type BeamInlineSegment,
} from '@/lib/beamMessageFormat';

/**
 * Renders a Beam Agent message. The agent answers in Markdown, so instead of
 * dumping raw `**` / `##` / `---` into a bubble we parse it into a small block
 * model (see `beamMessageFormat`) and map each block onto the app's existing
 * luxury typography tokens:
 *   - headings  → gold uppercase section labels ("From Your Vault", "New Bottles")
 *   - lists     → quiet gold-dot rows with the bottle name emphasized in cream
 *   - paragraphs→ muted prose
 * No new fonts, no Markdown characters reach the screen. A long structured
 * recommendation therefore reads as a scannable collection card, not a wall of
 * text.
 */

function renderSegments(segments: BeamInlineSegment[]): React.ReactNode {
  return segments.map((seg, i) =>
    seg.bold ? (
      <strong key={i} className="font-semibold text-foreground">
        {seg.text}
      </strong>
    ) : (
      <React.Fragment key={i}>{seg.text}</React.Fragment>
    ),
  );
}

const BeamBlockView: React.FC<{ block: BeamBlock; index: number }> = ({ block, index }) => {
  if (block.type === 'heading') {
    return (
      <p className={`scent-type-label text-scent-accent/90 ${index === 0 ? '' : 'mt-4'}`}>
        {renderSegments(block.segments)}
      </p>
    );
  }

  if (block.type === 'list') {
    // Ordered lists keep their ranking: "1. / 2. / 3." picks read as a ranked
    // shortlist, so the number renders as a quiet gold marker instead of being
    // flattened into the same dot every unordered row gets. Semantic <ol>/<ul>
    // so assistive tech announces the ordering too (custom markers, list-style
    // suppressed by the preflight reset).
    const ListTag = block.ordered ? 'ol' : 'ul';
    return (
      <ListTag className={`flex flex-col gap-1.5 ${index === 0 ? '' : 'mt-2'}`}>
        {block.items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 leading-relaxed">
            {block.ordered ? (
              <span
                aria-hidden
                className="min-w-[1.1em] shrink-0 text-right font-serif text-[0.85em] italic leading-relaxed text-scent-accent/75"
              >
                {i + 1}.
              </span>
            ) : (
              <span
                aria-hidden
                className="mt-[0.5em] h-1 w-1 shrink-0 rounded-full bg-scent-accent/60"
              />
            )}
            <span className="min-w-0">{renderSegments(item)}</span>
          </li>
        ))}
      </ListTag>
    );
  }

  return (
    <p className={`leading-relaxed ${index === 0 ? '' : 'mt-2.5'}`}>{renderSegments(block.segments)}</p>
  );
};

export const BeamMessage: React.FC<{ text: string; className?: string }> = ({ text, className }) => {
  const blocks = useMemo(() => parseBeamMessage(text), [text]);

  // Defensive fallback: if parsing yields nothing (e.g. an all-whitespace
  // payload), still show the trimmed text rather than an empty bubble.
  if (blocks.length === 0) {
    const fallback = text.trim();
    return fallback ? (
      <span className={`break-words [overflow-wrap:anywhere] ${className ?? ''}`}>{fallback}</span>
    ) : null;
  }

  return (
    // min-w-0 + break-words/overflow-wrap keep long unbroken tokens (URLs, long
    // fragrance names) wrapping inside the bubble's 92% cap instead of forcing
    // the bubble wider than the rounded overflow-hidden frame and clipping.
    <div className={`min-w-0 break-words [overflow-wrap:anywhere] ${className ?? ''}`}>
      {blocks.map((block, index) => (
        <BeamBlockView key={index} block={block} index={index} />
      ))}
    </div>
  );
};
