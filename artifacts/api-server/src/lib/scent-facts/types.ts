export type SourceClass = "retailer" | "fragrance_db" | "official_brand" | "other";

export type ScentFactInput = {
  fragranceName: string;
  sourceUrl?: string;
  save?: false;
};

export type ScentSource = {
  url: string;
  domain: string;
  text: string;
  source_class: SourceClass;
  note_signal_found: boolean;
};

export type ScentFactProfile = {
  brand: string;
  name: string;
  top_notes: string[];
  heart_notes: string[];
  base_notes: string[];
  accords: string[];
  confidence_score: number;
  source_urls: string[];
};

export type SourceSummaryEntry = {
  url: string;
  domain: string;
  source_class: SourceClass;
  note_signal_found: boolean;
};

export type NoteEvidence = {
  note: string;
  source_count: number;
  source_urls: string[];
  source_domains: string[];
  positions_seen: string[];
};

export type ScentFactProof = {
  readable_sources: number;
  supported_notes: string[];
  unsupported_notes_removed: string[];
  warnings: string[];
  source_summary: SourceSummaryEntry[];
  note_evidence: NoteEvidence[];
  confidence_reason: string;
};

export type ScentFactResult = {
  ok: true;
  provisional?: boolean;
  profile: ScentFactProfile;
  proof: ScentFactProof;
};
