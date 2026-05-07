export type ScentFactInput = {
  fragranceName: string;
  sourceUrl?: string;
  save?: false;
};

export type ScentSource = {
  url: string;
  domain: string;
  text: string;
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

export type ScentFactProof = {
  readable_sources: number;
  supported_notes: string[];
  unsupported_notes_removed: string[];
  warnings: string[];
};

export type ScentFactResult = {
  ok: true;
  profile: ScentFactProfile;
  proof: ScentFactProof;
};
