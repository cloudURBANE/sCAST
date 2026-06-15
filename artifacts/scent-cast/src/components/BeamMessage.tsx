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
      <strong key={i} className="font-semibold text-[#fff7ec]">
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
      <p className={`scent-type-label text-scent-accent/90 ${index === 0 ? '' : 'mt-3.5'}`}>
        {renderSegments(block.segments)}
      </p>
    );
  }

  if (block.type === 'list') {
    return (
      <ul className={`flex flex-col gap-1.5 ${index === 0 ? '' : 'mt-2'}`}>
        {block.items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 leading-relaxed">
            <span
              aria-hidden
              className="mt-[0.5em] h-1 w-1 shrink-0 rounded-full bg-scent-accent/60"
            />
            <span className="min-w-0">{renderSegments(item)}</span>
          </li>
        ))}
      </ul>
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
    return fallback ? <span className={className}>{fallback}</span> : null;
  }

  return (
    <div className={className}>
      {blocks.map((block, index) => (
        <BeamBlockView key={index} block={block} index={index} />
      ))}
    </div>
  );
};
