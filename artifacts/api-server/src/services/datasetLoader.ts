import fragrancesRaw from "../data/fragrances.json" with { type: "json" };

export interface FragranceData {
  name: string;
  brand: string;
  family: string;
  notes: string[];
  pyramid?: {
    top: string[];
    heart: string[];
    base: string[];
  };
  description: string;
  imageUrl?: string;
  perfumer?: string;
}

const dataset: FragranceData[] = fragrancesRaw as FragranceData[];

export function loadDataset(): FragranceData[] {
  return dataset;
}
