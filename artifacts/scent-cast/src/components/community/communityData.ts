import { useQuery } from '@tanstack/react-query';

export interface CommunityFragranceEntry {
  id: string;
  name: string;
  brand: string;
  imageUrl: string;
  curator: string;
  family?: string;
  topNotes?: string[];
  heartNotes?: string[];
  baseNotes?: string[];
}

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

export function useCommunityFragrances() {
  return useQuery({
    queryKey: ['community', 'featured', 'v1'],
    queryFn: async (): Promise<CommunityFragranceEntry[]> => SEED,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
