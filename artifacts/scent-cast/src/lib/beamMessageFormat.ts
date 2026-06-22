/**
 * Beam Agent message formatting.
 *
 * The live Beam Agent answers in Markdown (it emits `**bold**`, `##` headings,
 * `---` rules, and `- ` bullet lists), and its raw tool transcript can leak
 * internal phrasing ("returned no unowned fragrances", repeated "Searching the
 * catalog… 0 fragrances found" rows). Rendering that string verbatim made the
 * concierge read like a debug log.
 *
 * This module is pure (no DOM / React) so it can be unit-tested under the node
 * test runner. It does three things:
 *   1. `cleanAgentText`   — drop internal/tool-transcript lines and collapse
 *                           consecutive duplicates.
 *   2. `parseBeamMessage` — turn the cleaned Markdown into a small block model
 *                           (headings / paragraphs / lists with inline bold) the
 *                           renderer maps onto the app's typography tokens, so no
 *                           raw `**` / `##` / `---` ever reaches the screen.
 *   3. `formatAgentResponse` — detect a catalog-unavailable answer and front it
 *                           with polished, user-facing copy.
 */

export type BeamInlineSegment = { text: string; bold?: boolean };

export type BeamBlock =
  | { type: 'heading'; segments: BeamInlineSegment[] }
  | { type: 'paragraph'; segments: BeamInlineSegment[] }
  | { type: 'list'; ordered: boolean; items: BeamInlineSegment[][] };

/** Polished, user-facing copy for the "catalog is unreachable" state. */
export const POLISHED_CATALOG_UNAVAILABLE =
  "I couldn't reach the full fragrance catalog right now, so I won't invent new bottles. " +
  'I can still build a strong rotation from your vault, or you can retry the catalog search.';

// Lines that are internal tool/debug chatter and must never render to the user.
const INTERNAL_LINE_PATTERNS: RegExp[] = [
  /^\s*tool[_\s-]?result\b/i,
  /^\s*(function|tool)[_\s-]?call\b/i,
  /^\s*<\/?tool/i,
  /^\s*\[tool/i,
  /^\s*(debug|trace|stderr|stdout)\b[:\s]/i,
  /returned no unowned fragrances?/i,
  /\bno unowned fragrances?\b/i,
  // "Searching the catalog… 0 fragrances found" style status rows.
  /^\s*searching the catalog\b.*$/i,
  /^\s*\d+\s+fragrances?\s+found\s*$/i,
  /^\s*\d+\s+results?\s+found\s*$/i,
  /^\s*0\s+(matches|candidates|results)\b/i,
];

// Phrases that mean "the external catalog did not give us anything to work with".
const CATALOG_UNAVAILABLE_PATTERNS: RegExp[] = [
  /returned no unowned fragrances?/i,
  /\bno unowned fragrances?\b/i,
  /could ?n[' ]?t\s+(reach|access|search|load|connect to|find)\b[^.]*\bcatalog/i,
  /\bcatalog\b[^.]*\b(unavailable|unreachable|is empty|is down|offline|returned (no|nothing|0|none))/i,
  /\bcatalog (search )?(is )?(currently )?(down|offline|unavailable|empty)\b/i,
  /\b0 fragrances? found\b/i,
];

/** True when the agent's raw answer signals an unreachable / empty catalog. */
export function detectCatalogUnavailable(raw: string): boolean {
  if (!raw) return false;
  return CATALOG_UNAVAILABLE_PATTERNS.some((re) => re.test(raw));
}

/**
 * Drop internal/tool-transcript lines and collapse consecutive duplicate lines
 * (the "Searching the catalog…" rows arrived several times in a row). Whitespace
 * inside kept lines is normalized; blank-line structure is preserved so the block
 * parser can still separate paragraphs.
 */
/**
 * Strip OpenAI "harmony" / gpt-oss control markup that can leak into a message when
 * a misconfigured model emits its raw channel transcript instead of just the final
 * answer (e.g. `<|start|>assistant<|channel|>commentary to=functions.x <|constrain|>
 * json<|message|>{…}<|call|>`). The api-server provider already scrubs this at the
 * source; this is the last-line client guard so the symptom can never render — and
 * it also cleans any message persisted before the server fix shipped. Plain answers
 * (no `<|`) are returned unchanged.
 */
export function stripHarmonyTokens(raw: string): string {
  if (!raw || !raw.includes('<|')) return raw ?? '';

  // Prefer the user-facing "final" channel when the harmony envelope wraps it.
  const finalChannel = raw.match(
    /<\|channel\|>\s*final\s*<\|message\|>([\s\S]*?)(?:<\|return\|>|<\|end\|>|<\|start\|>|$)/,
  );
  let text = finalChannel ? finalChannel[1] : raw;

  text = text
    // A whole tool-call / reasoning block: header → args → terminator.
    .replace(/<\|channel\|>\s*(?:commentary|analysis)[\s\S]*?(?:<\|call\|>|<\|end\|>|<\|return\|>)/g, '')
    // A role preamble such as "<|start|>assistant".
    .replace(/<\|start\|>\s*\w*/g, '')
    // Any remaining well-formed control token.
    .replace(/<\|[^|>]*\|>/g, '')
    // A dangling partial token from a truncated chunk.
    .replace(/<\|[^|>]*$/g, '')
    // A leftover tool-recipient header if its block was malformed.
    .replace(/\bto=functions\.[A-Za-z0-9_.]+/g, '');

  return text.trim();
}

export function cleanAgentText(raw: string): string {
  if (!raw) return '';
  raw = stripHarmonyTokens(raw);
  const out: string[] = [];
  let lastKept = '';
  let pendingBlank = false;

  for (const rawLine of raw.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/[ \t]+/g, ' ').trimEnd();
    if (line.trim().length === 0) {
      // Remember a blank so paragraphs stay separated, but never lead with it.
      if (out.length > 0) pendingBlank = true;
      continue;
    }
    if (INTERNAL_LINE_PATTERNS.some((re) => re.test(line))) continue;

    const normalized = line.trim().toLowerCase();
    if (normalized === lastKept) continue; // collapse repeated identical rows

    if (pendingBlank) {
      out.push('');
      pendingBlank = false;
    }
    out.push(line);
    lastKept = normalized;
  }

  return out.join('\n').trim();
}

/**
 * Format a raw agent response for display: clean internal lines, and when the
 * answer is a catalog-unavailable case, front it with polished copy (unless the
 * model already phrased it well).
 */
export function formatAgentResponse(raw: string): { text: string; catalogUnavailable: boolean } {
  const catalogUnavailable = detectCatalogUnavailable(raw);
  let text = cleanAgentText(raw);

  if (catalogUnavailable) {
    const alreadyPolished =
      /reach the full fragrance catalog|retry the catalog|from your vault/i.test(text);
    if (!alreadyPolished) {
      text = text.length ? `${POLISHED_CATALOG_UNAVAILABLE}\n\n${text}` : POLISHED_CATALOG_UNAVAILABLE;
    }
  }

  return { text, catalogUnavailable };
}

const HR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/; // ---, ***, ___ (with optional spaces)
const ATX_HEADING_RE = /^\s*#{1,6}\s+(.*\S)\s*$/;
const BOLD_HEADING_RE = /^\s*\*\*(.+?)\*\*\s*:?\s*$/; // a line that is only **Heading**
const BULLET_RE = /^\s*[-*•]\s+(.*\S)\s*$/;
const NUMBERED_RE = /^\s*\d+[.)]\s+(.*\S)\s*$/;

/**
 * Parse a single line of inline Markdown into segments, marking `**bold**` /
 * `__bold__` runs and stripping every other Markdown artifact (italic markers,
 * inline code backticks, link syntax, stray hashes). Always returns at least one
 * segment for non-empty input.
 */
export function parseInlineSegments(input: string): BeamInlineSegment[] {
  if (!input) return [];
  // Normalize links [text](url) -> text, and drop inline code backticks.
  let text = input
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1')
    .replace(/`+/g, '');

  const segments: BeamInlineSegment[] = [];
  const boldRe = /\*\*(.+?)\*\*|__(.+?)__/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const pushPlain = (chunk: string) => {
    // `stripResidualMarkdown` trims its chunk, which would fuse the space that
    // separates a plain run from an adjacent bold run ("**Sauvage Elixir** is" ->
    // "Sauvage Elixiris", "Runner-up: **Gabrielle** if" -> "Runner-up:Gabrielleif").
    // Re-add a single boundary space when the original chunk had surrounding
    // whitespace, and keep one separating space between back-to-back bold runs.
    const cleaned = stripResidualMarkdown(chunk);
    if (!cleaned) {
      if (/\s/.test(chunk) && segments.length > 0) segments.push({ text: ' ' });
      return;
    }
    const lead = /^\s/.test(chunk) ? ' ' : '';
    const trail = /\s$/.test(chunk) ? ' ' : '';
    segments.push({ text: `${lead}${cleaned}${trail}` });
  };

  while ((match = boldRe.exec(text)) !== null) {
    if (match.index > lastIndex) pushPlain(text.slice(lastIndex, match.index));
    const boldText = stripResidualMarkdown(match[1] ?? match[2] ?? '');
    if (boldText) segments.push({ text: boldText, bold: true });
    lastIndex = boldRe.lastIndex;
  }
  if (lastIndex < text.length) pushPlain(text.slice(lastIndex));

  return segments;
}

/** Remove leftover emphasis markers / hashes without eating in-word underscores. */
function stripResidualMarkdown(chunk: string): string {
  return chunk
    // _emphasis_ or *emphasis* wrapping a run of text -> the text
    .replace(/(^|[\s(])[*_](?=\S)([^*_]+?)(?<=\S)[*_](?=$|[\s).,!?;:])/g, '$1$2')
    .replace(/^#{1,6}\s*/, '') // stray leading heading hashes
    .replace(/\*+/g, '') // any orphan asterisks
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse cleaned agent Markdown into a block model. Headings (ATX `#` or a line
 * that is only `**Bold**`), bullet/numbered lists, and paragraphs are detected;
 * horizontal rules are dropped. Consecutive list items are grouped.
 */
export function parseBeamMessage(raw: string): BeamBlock[] {
  const cleaned = cleanAgentText(raw);
  if (!cleaned) return [];

  const blocks: BeamBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: BeamInlineSegment[][] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const segments = parseInlineSegments(paragraph.join(' '));
    if (segments.length) blocks.push({ type: 'paragraph', segments });
    paragraph = [];
  };
  const flushList = () => {
    if (list && list.items.length) blocks.push({ type: 'list', ordered: list.ordered, items: list.items });
    list = null;
  };

  for (const line of cleaned.split('\n')) {
    if (line.trim().length === 0) {
      flushParagraph();
      flushList();
      continue;
    }
    if (HR_RE.test(line)) {
      flushParagraph();
      flushList();
      continue;
    }

    const atx = line.match(ATX_HEADING_RE);
    const boldHeading = atx ? null : line.match(BOLD_HEADING_RE);
    if (atx || boldHeading) {
      flushParagraph();
      flushList();
      const segments = parseInlineSegments((atx?.[1] ?? boldHeading?.[1] ?? '').trim());
      if (segments.length) blocks.push({ type: 'heading', segments });
      continue;
    }

    const bullet = line.match(BULLET_RE);
    const numbered = bullet ? null : line.match(NUMBERED_RE);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      const segments = parseInlineSegments((bullet?.[1] ?? numbered?.[1] ?? '').trim());
      if (segments.length) list.items.push(segments);
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  return blocks;
}

/** Flatten a raw agent message to clean plain text (no Markdown), for a11y / fallback. */
export function toPlainText(raw: string): string {
  return parseBeamMessage(raw)
    .map((block) => {
      if (block.type === 'list') {
        return block.items.map((item) => item.map((s) => s.text).join('')).join('\n');
      }
      return block.segments.map((s) => s.text).join('');
    })
    .join('\n')
    .trim();
}
