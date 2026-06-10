// Hard floor below which an image is treated as a thumbnail/icon, not a packshot.
// Measured against live Serper payloads (YSL Libre / MYSLF / Y "Le Parfum", 2026-06):
// the official YSL CDN (yslbeautyus.com / yslbeauty.com) serves 320×320, Sephora 350×350,
// Macy's 328×400, Bloomingdale's 320×400 — i.e. the *highest-trust* packshots are 320–350px.
// A 500px floor `-Infinity`'d exactly those before the trusted-host bonus could apply, leaving
// brand-new releases imageless. The ranking score below already rewards larger dimensions
// (`Math.min(4, floor(min/400))`), so a hard 500 floor was redundant punishment. 300 still
// rejects favicons/sprites while admitting every real packshot observed in the wild.
const MIN_IMAGE_WIDTH = 300;
const MIN_IMAGE_HEIGHT = 300;
const MIN_ASPECT_RATIO = 0.5;
const MAX_ASPECT_RATIO = 2;

const BLOCKED_HOST_HINTS = [
  "pinterest",
  "pinimg",
  "etsy",
  "ebay",
  "poshmark",
  "depop",
  "mercari",
  "dreamstime",
  "alamy",
  "shutterstock",
  "istock",
  "freepik",
  "123rf",
  "vecteezy",
  // Social / embed crawlers often return HTML wrappers, not direct image bytes.
  "instagram",
  "lookaside",
  "fbsbx",
  "fbcdn",
  "tiktok",
  "twitter",
  "t.co",
];

const TRUSTED_HOST_HINTS = [
  "fragrantica",
  "fimgs.net",
  "sephora",
  "ulta",
  "macys",
  "nordstrom",
  "dior",
  "chanel",
  "ysl",
  "tomford",
  "gucci",
];

/** Substring matches — long phrases and unambiguous product nouns. */
const REQUIRED_TEXT_HINTS = [
  "perfume",
  "fragrance",
  "bottle",
  "eau de parfum",
  "eau de toilette",
  "eau de cologne",
  "extrait de parfum",
  "cologne",
  "extrait",
  "elixir",
];

/** Word-boundary matches — retailer titles often use abbreviations (e.g. "Sauvage EDP 100ml"). */
const REQUIRED_WORD_HINTS = ["edp", "edt", "edc", "parfum"];

const BLOCKED_TEXT_HINTS = [
  "gift set",
  "box set",
  "discovery set",
  "sample",
  "sample 2",
  "sample vial",
  "spray sample",
  "carded sample",
  "decant",
  "tester",
  "tester 2",
  "tester bottle",
  "mini",
  "miniature",
  "travel spray",
  "travel size",
  "vial",
  "2ml",
  "2 ml",
  "1.5ml",
  "1.5 ml",
  "dupe",
  "inspired by",
  "box only",
  "with box",
  "boxed",
  "in box",
  "box packaging",
  "box and bottle",
  "bottle and box",
  "box +",
  "+ box",
  "& box",
  "and box",
  "with packaging",
  "with case",
  "gift box",
  "gift packaging",
  "coffret",
  "carton",
  "display box",
  "wooden box",
  "packaging only",
  "value set",
  "holiday set",
  "set of",
  "bundle",
  "lot of",
  "review",
  "render",
  "3d model",
  "mockup",
  "houseplant",
  "potted plant",
  "monstera",
  "fiddle leaf",
  "plant background",
  "succulent",
  "lush greenery",
];

const STRONG_DETAIL_HINTS = [
  "no box",
  "single bottle",
  "bottle only",
  "fragrance bottle",
  "perfume bottle",
  "centered",
  "centered bottle",
  "product photo",
  "packshot",
  "transparent background",
  "isolated",
  "studio shot",
  "plain background",
];

export type SerperImageScoringInput = {
  imageUrl?: string;
  title?: string;
  source?: string;
  imageWidth?: number;
  imageHeight?: number;
};

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function includesAnyWord(text: string, terms: string[]): boolean {
  return terms.some((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
}

function hasBottleSignal(text: string): boolean {
  return includesAny(text, REQUIRED_TEXT_HINTS) || includesAnyWord(text, REQUIRED_WORD_HINTS);
}

function countMatches(text: string, terms: string[]): number {
  return terms.reduce((count, term) => (text.includes(term) ? count + 1 : count), 0);
}

function getHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function scoreSerperImageCandidate(candidate: SerperImageScoringInput): number {
  const imageUrl = candidate.imageUrl ?? "";
  const host = getHost(imageUrl);
  if (!imageUrl || !isValidHttpUrl(imageUrl)) return -Infinity;
  if (BLOCKED_HOST_HINTS.some((hint) => host.includes(hint))) return -Infinity;
  let pathname = "";
  try {
    pathname = new URL(imageUrl).pathname.toLowerCase();
  } catch {
    pathname = "";
  }
  if (pathname.includes("lookaside")) return -Infinity;
  if (/\.(svg|gif)(\?.*)?$/i.test(imageUrl)) return -Infinity;

  const width = toNumber(candidate.imageWidth);
  const height = toNumber(candidate.imageHeight);
  if (width && height) {
    if (width < MIN_IMAGE_WIDTH || height < MIN_IMAGE_HEIGHT) return -Infinity;
    const aspect = width / height;
    if (aspect < MIN_ASPECT_RATIO || aspect > MAX_ASPECT_RATIO) return -Infinity;
  }

  const text = `${candidate.title ?? ""} ${candidate.source ?? ""}`.toLowerCase();
  if (includesAny(text, BLOCKED_TEXT_HINTS)) return -Infinity;
  const bottleSignal = hasBottleSignal(text);
  const strongDetailMatches = countMatches(text, STRONG_DETAIL_HINTS);
  const trustedHost = TRUSTED_HOST_HINTS.some((hint) => host.includes(hint));
  if (!bottleSignal && !trustedHost) return -Infinity;

  let score = 0;
  if (bottleSignal) score += 4;
  if (trustedHost) score += 5;
  score += Math.min(5, strongDetailMatches);
  if (/\.png(\?.*)?$/i.test(imageUrl)) score += 2;
  if (width && height) {
    score += Math.min(4, Math.floor(Math.min(width, height) / 400));

    // Aspect ratio as a visual proxy for "single bottle vs. bottle + box".
    // Text filtering can only catch boxes the title *names*; many retailer and
    // marketplace shots show the bottle standing next to its carton with a
    // title that never says "box". A lone perfume bottle is markedly taller
    // than wide (portrait), whereas a bottle-plus-box composition (or a
    // lifestyle/flat-lay shot) is square or landscape. So reward portrait
    // framing and penalize wide framing to bias ranking toward clean,
    // single-bottle packshots without needing to see the pixels.
    const aspect = width / height;
    if (aspect <= 0.85) {
      score += 3; // tall, bottle-shaped — most likely a single bottle
    } else if (aspect >= 1.15) {
      score -= 3; // wide — disproportionately bottle+box, sets, or lifestyle
    }
  } else {
    // Missing Serper dimension metadata — soft penalty rather than silent pass.
    score -= 2;
  }

  return score;
}
