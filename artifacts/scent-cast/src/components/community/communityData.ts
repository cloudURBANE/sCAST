import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { BottleImageAdjustment } from '@/lib/bottleImageAdjustment';
import { normalizeApiBaseUrl } from '@/lib/imageProxy';

export interface CommunityFragranceEntry {
  id: string;
  name: string;
  brand: string;
  imageUrl: string;
  curator: string;
  imageAdjustment?: BottleImageAdjustment | null;
  family?: string;
  topNotes?: string[];
  heartNotes?: string[];
  baseNotes?: string[];
}

type CommunityApiPayload = {
  fragrances?: unknown[];
};

const SEED: CommunityFragranceEntry[] = [
  { id: 'seed:1', name: 'Bleu de Chanel', brand: 'Chanel', imageUrl: 'https://fimgs.net/mdimg/perfume/375x500.10421.jpg', curator: '@maison', family: 'Woody Aromatic', topNotes: ['Grapefruit', 'Lemon', 'Mint'], heartNotes: ['Ginger', 'Nutmeg', 'Jasmine'], baseNotes: ['Cedar', 'Sandalwood', 'Labdanum'] },
  { id: 'seed:2', name: 'Sauvage Elixir', brand: 'Dior', imageUrl: 'https://fimgs.net/mdimg/perfume/375x500.69611.jpg', curator: '@noir', family: 'Spicy', topNotes: ['Cinnamon', 'Cardamom', 'Nutmeg'], heartNotes: ['Lavender', 'Licorice'], baseNotes: ['Sandalwood', 'Patchouli', 'Amber'] },
  { id: 'seed:3', name: 'Aventus', brand: 'Creed', imageUrl: 'https://fimgs.net/mdimg/perfume/375x500.9828.jpg', curator: '@vault', family: 'Fruity Chypre', topNotes: ['Pineapple', 'Bergamot', 'Apple'], heartNotes: ['Birch', 'Patchouli', 'Jasmine'], baseNotes: ['Musk', 'Oakmoss', 'Vanilla'] },
  { id: 'seed:4', name: 'Tobacco Vanille', brand: 'Tom Ford', imageUrl: 'https://fimgs.net/mdimg/perfume/375x500.1825.jpg', curator: '@ember', family: 'Oriental Spicy', topNotes: ['Tobacco Leaf', 'Spices'], heartNotes: ['Vanilla', 'Cocoa', 'Tonka'], baseNotes: ['Dry Fruits', 'Wood'] },
  { id: 'seed:5', name: 'Oud Wood', brand: 'Tom Ford', imageUrl: 'https://fimgs.net/mdimg/perfume/375x500.1827.jpg', curator: '@oud', family: 'Woody Oriental', topNotes: ['Cardamom', 'Pink Pepper'], heartNotes: ['Oud', 'Rosewood', 'Sandalwood'], baseNotes: ['Vanilla', 'Amber', 'Vetiver'] },
  { id: 'seed:6', name: 'Acqua di Gio', brand: 'Giorgio Armani', imageUrl: 'https://fimgs.net/mdimg/perfume/375x500.410.jpg', curator: '@coast', family: 'Aquatic', topNotes: ['Lime', 'Lemon', 'Bergamot', 'Jasmine'], heartNotes: ['Marine Notes', 'Peach', 'Calone'], baseNotes: ['Musk', 'Cedar', 'Amber'] },
  { id: 'seed:7', name: 'Black Orchid', brand: 'Tom Ford', imageUrl: 'https://fimgs.net/mdimg/perfume/375x500.1018.jpg', curator: '@noir', family: 'Oriental Floral', topNotes: ['Truffle', 'Gardenia', 'Bergamot'], heartNotes: ['Black Orchid', 'Lotus', 'Spices'], baseNotes: ['Patchouli', 'Vanilla', 'Sandalwood'] },
  { id: 'seed:8', name: 'Light Blue', brand: 'Dolce & Gabbana', imageUrl: 'https://fimgs.net/mdimg/perfume/375x500.485.jpg', curator: '@sicilia', family: 'Citrus', topNotes: ['Sicilian Lemon', 'Apple', 'Cedar'], heartNotes: ['Bamboo', 'Jasmine', 'White Rose'], baseNotes: ['Cedar', 'Amber', 'Musk'] },
  { id: 'seed:9', name: "La Nuit de L'Homme", brand: 'Yves Saint Laurent', imageUrl: 'https://fimgs.net/mdimg/perfume/375x500.6779.jpg', curator: '@parfumerie', family: 'Woody Aromatic', topNotes: ['Cardamom', 'Bergamot'], heartNotes: ['Lavender', 'Cedar'], baseNotes: ['Vetiver', 'Caraway', 'Coumarin'] },
  { id: 'seed:10', name: 'Spicebomb', brand: 'Viktor & Rolf', imageUrl: 'https://fimgs.net/mdimg/perfume/375x500.13628.jpg', curator: '@detonate', family: 'Oriental Spicy', topNotes: ['Pink Pepper', 'Bergamot', 'Grapefruit'], heartNotes: ['Cinnamon', 'Saffron', 'Paprika'], baseNotes: ['Tobacco', 'Leather', 'Vetiver'] },
  { id: 'seed:11', name: 'Layton', brand: 'Parfums de Marly', imageUrl: 'https://fimgs.net/mdimg/perfume/375x500.39681.jpg', curator: '@marly', family: 'Oriental Fougere', topNotes: ['Apple', 'Bergamot', 'Lavender'], heartNotes: ['Jasmine', 'Geranium', 'Cardamom'], baseNotes: ['Vanilla', 'Sandalwood', 'Guaiac Wood'] },
  { id: 'seed:12', name: 'Y Eau de Parfum', brand: 'Yves Saint Laurent', imageUrl: 'https://fimgs.net/mdimg/perfume/375x500.51410.jpg', curator: '@y', family: 'Aromatic Fougere', topNotes: ['Apple', 'Ginger', 'Bergamot'], heartNotes: ['Sage', 'Juniper', 'Geranium'], baseNotes: ['Tonka', 'Cedar', 'Amberwood'] },
];

export const COMMUNITY_FEATURED_USER_IDS: string[] = [];

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env?.VITE_API_BASE_URL as string | undefined);

function appApiUrl(path: string): string {
  return API_BASE_URL ? `${API_BASE_URL}${path}` : path;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

function stringList(value: unknown): string[] | undefined {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const strings = values
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, 8);
  return strings.length > 0 ? strings : undefined;
}

function normalizeCommunityEntry(value: unknown, index: number): CommunityFragranceEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = firstString(record.name);
  const brand = firstString(record.brand, record.house);
  const imageUrl = firstString(record.imageUrl, record.image_url);
  const family = firstString(record.family);
  const topNotes = stringList(record.topNotes);
  const heartNotes = stringList(record.heartNotes);
  const baseNotes = stringList(record.baseNotes);
  if (!name || !brand || !imageUrl) return null;

  return {
    id: firstString(record.id) ?? `community:${index}`,
    name,
    brand,
    imageUrl,
    curator: firstString(record.curator) ?? '@community',
    ...(record.imageAdjustment && typeof record.imageAdjustment === 'object' && !Array.isArray(record.imageAdjustment)
      ? { imageAdjustment: record.imageAdjustment as BottleImageAdjustment }
      : {}),
    ...(family ? { family } : {}),
    ...(topNotes ? { topNotes } : {}),
    ...(heartNotes ? { heartNotes } : {}),
    ...(baseNotes ? { baseNotes } : {}),
  };
}

async function fetchCommunityFragrances(): Promise<CommunityFragranceEntry[]> {
  try {
    const response = await fetch(appApiUrl('/api/community/fragrances'), {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Community API failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as CommunityApiPayload | unknown[];
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(payload.fragrances)
        ? payload.fragrances
        : [];
    const entries = rows
      .map((entry, index) => normalizeCommunityEntry(entry, index))
      .filter((entry): entry is CommunityFragranceEntry => entry !== null);

    if (entries.length > 0 || !import.meta.env.DEV) return entries;
  } catch (err) {
    if (!import.meta.env.DEV) throw err;
    console.warn('[community] Falling back to seed fragrances because the community API is unavailable.', err);
  }

  return SEED;
}

export function useCommunityFragrances() {
  return useQuery({
    queryKey: ['community', 'featured', 'v2'],
    queryFn: fetchCommunityFragrances,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
    placeholderData: keepPreviousData,
  });
}
