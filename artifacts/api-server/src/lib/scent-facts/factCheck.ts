import type { ScentFactProfile, ScentFactProof, ScentSource } from "./types";

function normalizeForSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function noteAppearsInSources(note: string, sources: ScentSource[]): boolean {
  const normalizedNote = normalizeForSearch(note);
  if (!normalizedNote) return false;

  return sources.some((source) => {
    const text = normalizeForSearch(source.text);
    return text.includes(normalizedNote);
  });
}

function filterSupported(notes: string[], sources: ScentSource[]) {
  const supported: string[] = [];
  const unsupported: string[] = [];

  for (const note of notes) {
    if (noteAppearsInSources(note, sources)) {
      supported.push(note);
    } else {
      unsupported.push(note);
    }
  }

  return { supported, unsupported };
}

export function factCheckProfile(
  profile: ScentFactProfile,
  sources: ScentSource[],
): { profile: ScentFactProfile; proof: ScentFactProof } {
  const top = filterSupported(profile.top_notes, sources);
  const heart = filterSupported(profile.heart_notes, sources);
  const base = filterSupported(profile.base_notes, sources);
  const accords = filterSupported(profile.accords, sources);

  const unsupported = [
    ...top.unsupported,
    ...heart.unsupported,
    ...base.unsupported,
    ...accords.unsupported,
  ];
  const supported = [
    ...top.supported,
    ...heart.supported,
    ...base.supported,
    ...accords.supported,
  ];

  const warnings: string[] = [];
  if (sources.length < 2) {
    warnings.push("Only one readable source; treat result as provisional.");
  }
  if (!top.supported.length) warnings.push("No source-supported top notes found.");
  if (!heart.supported.length) warnings.push("No source-supported heart notes found.");
  if (!base.supported.length) warnings.push("No source-supported base notes found.");

  const totalOriginalNotes =
    profile.top_notes.length +
    profile.heart_notes.length +
    profile.base_notes.length +
    profile.accords.length;

  const supportRatio = totalOriginalNotes === 0 ? 0 : supported.length / totalOriginalNotes;

  let adjustedConfidence = profile.confidence_score;
  adjustedConfidence *= supportRatio || 0.3;
  if (sources.length >= 2) adjustedConfidence += 0.08;
  if (sources.length >= 3) adjustedConfidence += 0.05;
  if (unsupported.length) adjustedConfidence -= Math.min(0.25, unsupported.length * 0.04);

  adjustedConfidence = Math.max(0, Math.min(1, adjustedConfidence));

  return {
    profile: {
      ...profile,
      top_notes: top.supported,
      heart_notes: heart.supported,
      base_notes: base.supported,
      accords: accords.supported,
      confidence_score: Number(adjustedConfidence.toFixed(2)),
      source_urls: sources.map((s) => s.url),
    },
    proof: {
      readable_sources: sources.length,
      supported_notes: [...new Set(supported)],
      unsupported_notes_removed: [...new Set(unsupported)],
      warnings,
    },
  };
}
