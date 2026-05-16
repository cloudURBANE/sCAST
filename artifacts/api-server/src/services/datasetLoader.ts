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

function stripBundledImageFallbacks(items: FragranceData[]): FragranceData[] {
  return items.map(({ imageUrl: _imageUrl, ...item }) => item);
}

const dataset: FragranceData[] = stripBundledImageFallbacks(fragrancesRaw as FragranceData[]);

export function loadDataset(): FragranceData[] {
  return dataset;
}
