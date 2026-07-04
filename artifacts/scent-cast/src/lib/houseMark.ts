/**
 * House mark resolution for search-result rows.
 *
 * The engine's search results carry no imagery, so the row anchor is a
 * two-letter monogram disc. For the houses we can identify with certainty,
 * we upgrade that disc to the house's actual mark (its favicon, served by
 * Google's public s2 favicon endpoint — no API key, aggressively CDN-cached,
 * and safe to hotlink). The lookup is deliberately a *curated allow-list*:
 * guessing `<brand>.com` for unknown houses would render Google's generic
 * globe placeholder, which cannot be detected client-side (the endpoint
 * answers 200 either way and CORS-taints canvas readback). Unknown houses —
 * and any load failure, including offline PWA sessions — keep the monogram,
 * so this is a pure progressive enhancement.
 */

/** Normalize a house/brand string into a stable lookup key. */
export function normalizeHouseKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Hand-verified house → primary web domain. Keys are `normalizeHouseKey`
 * output. Aliases (YSL, "Christian Dior", …) map to the same domain.
 */
const HOUSE_DOMAINS: Record<string, string> = {
  // Designer / heritage
  'creed': 'creedfragrances.com',
  'dior': 'dior.com',
  'christian dior': 'dior.com',
  'chanel': 'chanel.com',
  'guerlain': 'guerlain.com',
  'hermes': 'hermes.com',
  'tom ford': 'tomford.com',
  'yves saint laurent': 'yslbeauty.com',
  'ysl': 'yslbeauty.com',
  'giorgio armani': 'armanibeauty.com',
  'armani': 'armanibeauty.com',
  'emporio armani': 'armanibeauty.com',
  'versace': 'versace.com',
  'prada': 'prada.com',
  'gucci': 'gucci.com',
  'dolce gabbana': 'dolcegabbana.com',
  'givenchy': 'givenchy.com',
  'burberry': 'burberry.com',
  'valentino': 'valentino.com',
  'jean paul gaultier': 'jeanpaulgaultier.com',
  'paco rabanne': 'pacorabanne.com',
  'rabanne': 'pacorabanne.com',
  'carolina herrera': 'carolinaherrera.com',
  'calvin klein': 'calvinklein.com',
  'ralph lauren': 'ralphlauren.com',
  'hugo boss': 'hugoboss.com',
  'boss': 'hugoboss.com',
  'azzaro': 'azzaro.com',
  'montblanc': 'montblanc.com',
  'mont blanc': 'montblanc.com',
  'bvlgari': 'bulgari.com',
  'bulgari': 'bulgari.com',
  'cartier': 'cartier.com',
  'chloe': 'chloe.com',
  'lancome': 'lancome.com',
  'viktor rolf': 'viktor-rolf.com',
  'mugler': 'mugler.com',
  'thierry mugler': 'mugler.com',
  'kenzo': 'kenzo.com',
  'issey miyake': 'isseymiyake.com',
  'narciso rodriguez': 'narcisorodriguez.com',
  'salvatore ferragamo': 'ferragamo.com',
  'ferragamo': 'ferragamo.com',
  'bottega veneta': 'bottegaveneta.com',
  'louis vuitton': 'louisvuitton.com',
  'loewe': 'loewe.com',
  'balenciaga': 'balenciaga.com',
  'balmain': 'balmain.com',
  'boucheron': 'boucheron.com',
  'van cleef arpels': 'vancleefarpels.com',
  'elizabeth arden': 'elizabetharden.com',
  'elie saab': 'eliesaab.com',
  'lacoste': 'lacoste.com',
  'moschino': 'moschino.com',
  'coach': 'coach.com',
  'michael kors': 'michaelkors.com',
  'marc jacobs': 'marcjacobs.com',
  'estee lauder': 'esteelauder.com',
  'davidoff': 'zinodavidoff.com',

  // Niche
  'maison francis kurkdjian': 'franciskurkdjian.com',
  'francis kurkdjian': 'franciskurkdjian.com',
  'by kilian': 'bykilian.com',
  'kilian': 'bykilian.com',
  'kilian paris': 'bykilian.com',
  'byredo': 'byredo.com',
  'le labo': 'lelabofragrances.com',
  'diptyque': 'diptyqueparis.com',
  'frederic malle': 'fredericmalle.com',
  'editions de parfums frederic malle': 'fredericmalle.com',
  'serge lutens': 'sergelutens.com',
  'parfums de marly': 'parfums-de-marly.com',
  'amouage': 'amouage.com',
  'initio': 'initioparfums.com',
  'initio parfums prives': 'initioparfums.com',
  'xerjoff': 'xerjoff.com',
  'nishane': 'nishane.com',
  'penhaligon s': 'penhaligons.com',
  'acqua di parma': 'acquadiparma.com',
  'maison margiela': 'maisonmargiela.com',
  'margiela': 'maisonmargiela.com',
  'jo malone': 'jomalone.com',
  'jo malone london': 'jomalone.com',
  'juliette has a gun': 'juliettehasagun.com',
  'mancera': 'manceraparfums.com',
  'montale': 'montaleparfums.com',
  'tiziana terenzi': 'tizianaterenzi.com',
  'roja dove': 'rojaparfums.com',
  'roja parfums': 'rojaparfums.com',
  'clive christian': 'clivechristian.com',
  'bond no 9': 'bondno9.com',
  'atelier cologne': 'ateliercologne.com',
  'escentric molecules': 'escentric.com',
  'memo paris': 'memoparis.com',
  'bdk parfums': 'bdkparfums.com',
  'histoires de parfums': 'histoiresdeparfums.com',
  'zoologist': 'zoologistperfumes.com',
  'ds durga': 'dsanddurga.com',
  'd s durga': 'dsanddurga.com',
  'ormonde jayne': 'ormondejayne.com',
  'etat libre d orange': 'etatlibredorange.com',
  'l artisan parfumeur': 'artisanparfumeur.com',
  'vilhelm parfumerie': 'vilhelmparfumerie.com',

  // High-street / popular
  'lattafa': 'lattafa.com',
  'al haramain': 'alharamainperfumes.com',
  'rasasi': 'rasasi.com',
  'zara': 'zara.com',
  'abercrombie fitch': 'abercrombie.com',
  'victoria s secret': 'victoriassecret.com',
  'bath body works': 'bathandbodyworks.com',
  'kayali': 'kayalifragrances.com',
  'sol de janeiro': 'soldejaneiro.com',
  'juicy couture': 'juicycouture.com',
  'vera wang': 'verawang.com',
  'nautica': 'nautica.com',
};

/**
 * Session memo of mark URLs whose <img> load failed (offline, DNS, blocked).
 * Prevents every row of every subsequent search from re-attempting a host we
 * already know is unreachable this session.
 */
const failedMarkUrls = new Set<string>();

export function markHouseLogoFailed(url: string): void {
  failedMarkUrls.add(url);
}

/**
 * Resolve the house-mark image URL for a brand/house string, or null when the
 * house isn't in the curated map (or its mark already failed to load this
 * session). `sz=128` covers the 44–48px disc on 2–3× retina displays.
 */
export function resolveHouseLogoUrl(house: string | undefined | null): string | null {
  if (!house) return null;
  const domain = HOUSE_DOMAINS[normalizeHouseKey(house)];
  if (!domain) return null;
  const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
  return failedMarkUrls.has(url) ? null : url;
}
