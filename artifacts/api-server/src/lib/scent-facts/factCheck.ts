import type {
  NoteEvidence,
  ScentFactProfile,
  ScentFactProof,
  ScentSource,
  SourceSummaryEntry,
} from "./types";

type PositionLabel = "top" | "heart" | "base" | "accord";

const NOTE_SECTION_HEADERS = [
  "top notes",
  "middle notes",
  "heart notes",
  "base notes",
  "main accords",
  "fragrance notes",
  "key notes",
  "notes:",
];

const NOTE_SECTION_WINDOW = 600;

function normalizeForSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function noteAppearsInSource(note: string, source: ScentSource): boolean {
  const normalizedNote = normalizeForSearch(note);
  if (!normalizedNote) return false;
  return normalizeForSearch(source.text).includes(normalizedNote);
}

function noteInNoteSectionOf(note: string, source: ScentSource): boolean {
  const lowerText = source.text.toLowerCase();
  const lowerNote = normalizeForSearch(note);
  if (!lowerNote) return false;

  for (const header of NOTE_SECTION_HEADERS) {
    let searchFrom = 0;
    while (true) {
      const idx = lowerText.indexOf(header, searchFrom);
      if (idx === -1) break;
      const window = lowerText.slice(idx, idx + NOTE_SECTION_WINDOW);
      if (window.includes(lowerNote)) return true;
      searchFrom = idx + 1;
    }
  }
  return false;
}

function isHighQualitySource(source: ScentSource): boolean {
  const cls = source.source_class;
  return cls === "fragrance_db" || cls === "retailer" || cls === "official_brand";
}

function getSourcesForNote(
  note: string,
  sources: ScentSource[],
): { presentIn: ScentSource[]; inNoteSectionOf: ScentSource[] } {
  const presentIn: ScentSource[] = [];
  const inNoteSectionOf: ScentSource[] = [];

  for (const source of sources) {
    if (noteAppearsInSource(note, source)) {
      presentIn.push(source);
      if (noteInNoteSectionOf(note, source)) {
        inNoteSectionOf.push(source);
      }
    }
  }

  return { presentIn, inNoteSectionOf };
}

function shouldKeepNote(note: string, sources: ScentSource[]): boolean {
  const { presentIn, inNoteSectionOf } = getSourcesForNote(note, sources);

  if (presentIn.length >= 2) return true;

  if (presentIn.length === 1) {
    return isHighQualitySource(presentIn[0]) && inNoteSectionOf.length >= 1;
  }

  return false;
}

function buildNoteEvidence(
  note: string,
  position: PositionLabel,
  sources: ScentSource[],
): NoteEvidence | null {
  const { presentIn } = getSourcesForNote(note, sources);
  if (presentIn.length === 0) return null;

  return {
    note,
    source_count: presentIn.length,
    source_urls: presentIn.map((s) => s.url),
    source_domains: presentIn.map((s) => s.domain),
    positions_seen: [position],
  };
}

function mergeNoteEvidence(evidences: NoteEvidence[]): NoteEvidence[] {
  const byNote = new Map<string, NoteEvidence>();

  for (const ev of evidences) {
    const existing = byNote.get(ev.note);
    if (!existing) {
      byNote.set(ev.note, { ...ev, positions_seen: [...ev.positions_seen] });
    } else {
      const mergedUrls = [...new Set([...existing.source_urls, ...ev.source_urls])];
      const mergedDomains = [...new Set([...existing.source_domains, ...ev.source_domains])];
      const mergedPositions = [...new Set([...existing.positions_seen, ...ev.positions_seen])];
      byNote.set(ev.note, {
        note: ev.note,
        source_count: mergedUrls.length,
        source_urls: mergedUrls,
        source_domains: mergedDomains,
        positions_seen: mergedPositions,
      });
    }
  }

  return Array.from(byNote.values());
}

function computeConfidence(
  sources: ScentSource[],
  noteEvidence: NoteEvidence[],
  hasPyramid: { top: boolean; heart: boolean; base: boolean },
): { score: number; reason: string } {
  const sourceCount = sources.length;

  if (sourceCount === 0 || noteEvidence.length === 0) {
    return { score: 0, reason: "No readable sources or supported notes." };
  }

  const totalNotes = noteEvidence.length;
  const multiSourceNotes = noteEvidence.filter((e) => e.source_count >= 2).length;
  const multiSourceRatio = totalNotes > 0 ? multiSourceNotes / totalNotes : 0;
  const pyramidComplete = hasPyramid.top && hasPyramid.heart && hasPyramid.base;

  const classSet = new Set(
    sources.map((s) => s.source_class).filter((c) => c !== "other"),
  );
  const hasDiversity = classSet.size >= 2;

  let score: number;
  let reason: string;

  if (sourceCount >= 3 && multiSourceRatio >= 0.5 && pyramidComplete) {
    score = 0.88;
    if (sourceCount >= 4) score += 0.04;
    if (multiSourceRatio >= 0.75) score += 0.04;
    if (hasDiversity) score += 0.02;
    score = Math.min(1.0, score);
    reason = `${sourceCount} sources, strong agreement (${Math.round(multiSourceRatio * 100)}% multi-source), full pyramid`;
  } else if (sourceCount >= 2 && multiSourceRatio >= 0.25) {
    score = 0.72;
    if (sourceCount >= 3) score += 0.06;
    if (pyramidComplete) score += 0.05;
    if (hasDiversity) score += 0.02;
    score = Math.min(0.84, score);
    reason = `${sourceCount} sources, mostly consistent notes`;
  } else if (sourceCount >= 1) {
    score = 0.52;
    if (pyramidComplete) score += 0.1;
    if (multiSourceRatio >= 0.3) score += 0.05;
    score = Math.min(0.69, score);
    reason =
      sourceCount === 1
        ? "Single source; notes limited to clearly stated pyramid entries"
        : "Limited cross-source agreement";
  } else {
    score = 0.2;
    reason = "Very weak evidence";
  }

  return { score: Math.max(0, Math.min(1, score)), reason };
}

export function factCheckProfile(
  profile: ScentFactProfile,
  sources: ScentSource[],
): { profile: ScentFactProfile; proof: ScentFactProof } {
  type FilterResult = { kept: string[]; removed: string[] };

  function filterNotes(notes: string[]): FilterResult {
    const kept: string[] = [];
    const removed: string[] = [];
    for (const note of notes) {
      if (shouldKeepNote(note, sources)) {
        kept.push(note);
      } else {
        removed.push(note);
      }
    }
    return { kept, removed };
  }

  const top = filterNotes(profile.top_notes);
  const heart = filterNotes(profile.heart_notes);
  const base = filterNotes(profile.base_notes);
  const accords = filterNotes(profile.accords);

  const allKept = [...top.kept, ...heart.kept, ...base.kept, ...accords.kept];
  const allRemoved = [...top.removed, ...heart.removed, ...base.removed, ...accords.removed];

  // Build per-position evidence then merge across positions
  const rawEvidences: NoteEvidence[] = [];
  for (const note of top.kept) {
    const ev = buildNoteEvidence(note, "top", sources);
    if (ev) rawEvidences.push(ev);
  }
  for (const note of heart.kept) {
    const ev = buildNoteEvidence(note, "heart", sources);
    if (ev) rawEvidences.push(ev);
  }
  for (const note of base.kept) {
    const ev = buildNoteEvidence(note, "base", sources);
    if (ev) rawEvidences.push(ev);
  }
  for (const note of accords.kept) {
    const ev = buildNoteEvidence(note, "accord", sources);
    if (ev) rawEvidences.push(ev);
  }
  const noteEvidence = mergeNoteEvidence(rawEvidences);

  const warnings: string[] = [];
  if (sources.length === 1) {
    warnings.push("Only one readable source; treat result as provisional.");
  }
  if (!top.kept.length) warnings.push("No source-supported top notes found.");
  if (!heart.kept.length) warnings.push("No source-supported heart notes found.");
  if (!base.kept.length) warnings.push("No source-supported base notes found.");

  for (const ev of noteEvidence) {
    if (ev.positions_seen.length > 1) {
      warnings.push(
        `"${ev.note}" appears in different pyramid positions across sources: ${ev.positions_seen.join(", ")}`,
      );
    }
  }

  const hasPyramid = {
    top: top.kept.length > 0,
    heart: heart.kept.length > 0,
    base: base.kept.length > 0,
  };

  const { score, reason } = computeConfidence(sources, noteEvidence, hasPyramid);

  const sourceSummary: SourceSummaryEntry[] = sources.map((s) => ({
    url: s.url,
    domain: s.domain,
    source_class: s.source_class,
    note_signal_found: s.note_signal_found,
  }));

  return {
    profile: {
      ...profile,
      top_notes: top.kept,
      heart_notes: heart.kept,
      base_notes: base.kept,
      accords: accords.kept,
      confidence_score: Number(score.toFixed(2)),
      source_urls: sources.map((s) => s.url),
    },
    proof: {
      readable_sources: sources.length,
      supported_notes: [...new Set(allKept)],
      unsupported_notes_removed: [...new Set(allRemoved)],
      warnings,
      source_summary: sourceSummary,
      note_evidence: noteEvidence,
      confidence_reason: reason,
    },
  };
}
