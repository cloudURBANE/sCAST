export const OUD_WOOD_BETA_VIDEO_URL: string =
  (import.meta.env.VITE_OUD_WOOD_BETA_VIDEO_URL as string | undefined) ??
  '/beta/tom-ford-oud-wood.mp4';

function isOudWoodBeta(item: {
  brand?: string;
  name?: string;
  product?: { brand?: string; name?: string };
}): boolean {
  const brand = (item.brand ?? item.product?.brand ?? '').trim().toLowerCase();
  const name = (item.name ?? item.product?.name ?? '').trim().toLowerCase();
  return brand === 'tom ford' && name === 'oud wood';
}

export function betaVideoUrlForFragrance(item: {
  brand?: string;
  name?: string;
  product?: { brand?: string; name?: string };
}): string | null {
  if ((import.meta.env.VITE_OUD_WOOD_VIDEO_BETA as string | undefined) === '0') return null;
  if (!isOudWoodBeta(item)) return null;
  return OUD_WOOD_BETA_VIDEO_URL;
}
