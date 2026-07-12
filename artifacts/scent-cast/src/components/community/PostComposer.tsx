import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  BadgeDollarSign,
  Check,
  LoaderCircle,
  MessageCircleQuestion,
  Plus,
  Search,
  Send,
  Sun,
  Swords,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  getFragranceDetails,
  searchFragrances,
  type FragranceDetail,
  type FragranceDetailRequestPayload,
  type FragranceSearchResult,
} from '@/lib/fragranceApi';
import {
  COMMUNITY_POST_TYPES,
  type CommunityFragranceSnapshot,
  type CommunityPostType,
  sanitizeCommunityTag,
  useCreateCommunityPost,
} from '@/components/community/communityPosts';
import { useWardrobeItems } from '@/context/WardrobeContext';
import { BottleImage } from '@/components/BottleImage';
import { sanitizeFamilyLabel } from '@/lib/wardrobeSearchSuggest';

interface ComposerRoom {
  type: CommunityPostType;
  label: string;
  shortLabel: string;
  hint: string;
  Icon: LucideIcon;
}

const ROOMS: ComposerRoom[] = [
  { type: 'question', label: 'Ask a question', shortLabel: 'Ask', hint: 'Start with the question. Title, tags, and fragrance are optional.', Icon: MessageCircleQuestion },
  { type: 'sotd', label: 'SOTD', shortLabel: 'SOTD', hint: 'Share the wear. Weather, mood, and occasion can stay blank.', Icon: Sun },
  { type: 'battle', label: 'Battle', shortLabel: 'Battle', hint: 'Pick two fragrances from your vault or the catalog, then add the prompt.', Icon: Swords },
  { type: 'worth_it', label: 'Price check', shortLabel: 'Price', hint: 'Add the price only if it helps. The room can still start from the discussion.', Icon: BadgeDollarSign },
];

// Each post type gets a direct, action-oriented submit label.
const SUBMIT_LABELS: Record<CommunityPostType, string> = {
  question: 'Post your question',
  sotd: 'Post your SOTD',
  battle: 'Start the battle',
  worth_it: 'Post price check',
};

// Status messages double as validation errors, neutral notices, and success
// confirmations. Distinct tones let people (and screen readers, via aria-live)
// tell a rejected post from an opened room at a glance.
type StatusTone = 'info' | 'success' | 'error';

const STATUS_TONE_CLASSES: Record<StatusTone, string> = {
  info: 'border-scent-accent/12 bg-black/58 text-scent-text-muted',
  success: 'border-emerald-400/30 bg-emerald-400/[0.08] text-emerald-100',
  error: 'border-red-500/35 bg-red-500/[0.08] text-red-100',
};

const MAX_TAGS = 8;
const MAX_BODY_LENGTH = 4000;

interface PostComposerProps {
  authToken: string | null;
  onSignIn: () => void;
  /** Fired whenever the composer's open/closed state changes (expand, collapse,
      imperative open/close). Lets the page enforce composer/search exclusivity. */
  onOpenChange?: (open: boolean) => void;
}

export interface PostComposerHandle {
  /** Expand the composer, scroll it into view, and move focus into the form. */
  open: (preset?: { type?: CommunityPostType | null; tag?: string | null }) => void;
  /** Collapse the composer back to its starting bar. */
  close: () => void;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const trimmed = String(value).trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isAllowedCatalogImageUrl(value: string | undefined): value is string {
  if (!value) return false;
  if (value.toLowerCase().startsWith('data:')) return false;
  if (value.startsWith('/api/image-objects/')) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function searchResultImageUrl(result: FragranceSearchResult): string | undefined {
  const record = result as Record<string, unknown>;
  const product = objectRecord(record.product);
  const raw = objectRecord(record.raw);
  return firstString(
    record.imageUrl,
    record.image_url,
    record.image,
    product.imageUrl,
    product.image_url,
    product.image,
    raw.imageUrl,
    raw.image_url,
    raw.image,
  );
}

function detailImageUrl(detail: FragranceDetail): string | undefined {
  const raw = objectRecord(detail.raw);
  return firstString(
    detail.imageUrl,
    detail.image_url,
    detail.image,
    raw.imageUrl,
    raw.image_url,
    raw.image,
  );
}

function detailPayloadFor(result: FragranceSearchResult): FragranceDetailRequestPayload | null {
  const id = firstString(result.id);
  const sourceUrl = firstString(result.source_url);
  const origin = result.origin === 'app' ? 'app' : 'srt';

  if (id) {
    return {
      id,
      ...(sourceUrl ? { source_url: sourceUrl } : {}),
      origin,
    };
  }

  if (sourceUrl) {
    return { source_url: sourceUrl, origin: 'app' };
  }

  return null;
}

type BattleFragranceCandidate = CommunityFragranceSnapshot & {
  id: string;
  source: 'wardrobe' | 'global';
  result?: FragranceSearchResult;
};

function snapshotIdentityKey(snapshot: Pick<CommunityFragranceSnapshot, 'brand' | 'name'>): string {
  return `${snapshot.brand.trim().toLowerCase()}::${snapshot.name.trim().toLowerCase()}`;
}

function stableFragranceId(brand: string, name: string): string {
  const part = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return `catalog:${part(brand)}:${part(name)}`;
}

function battleOptionKey(snapshot: Pick<CommunityFragranceSnapshot, 'name'>): string {
  return snapshot.name.trim();
}

function snapshotFromWardrobeItem(item: Record<string, unknown>, index: number): BattleFragranceCandidate | null {
  const name = firstString(item.name, objectRecord(item.product).name);
  const brand = firstString(item.brand, item.house, objectRecord(item.product).brand);
  if (!name || !brand) return null;

  const imageUrl = firstString(item.imageUrl, item.image_url);
  const family = sanitizeFamilyLabel(firstString(item.family));
  return {
    id: firstString(item._dbId, item.id) ?? `wardrobe:${index}:${brand}:${name}`,
    fragranceId: stableFragranceId(brand, name),
    source: 'wardrobe',
    name,
    brand,
    ...(isAllowedCatalogImageUrl(imageUrl) ? { imageUrl } : {}),
    ...(family ? { family } : {}),
  };
}

function candidateFromSearchResult(result: FragranceSearchResult): BattleFragranceCandidate | null {
  const name = firstString(result.name);
  const brand = firstString(result.brand, result.house);
  if (!name || !brand) return null;
  const imageUrl = searchResultImageUrl(result);
  return {
    id: firstString(result.id, result.source_url, `global:${brand}:${name}`) ?? `global:${brand}:${name}`,
    fragranceId: stableFragranceId(brand, name),
    source: 'global',
    name,
    brand,
    result,
    ...(isAllowedCatalogImageUrl(imageUrl) ? { imageUrl } : {}),
  };
}

function filterWardrobeCandidates(candidates: BattleFragranceCandidate[], query: string): BattleFragranceCandidate[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const terms = normalized.split(/\s+/).filter(Boolean);
  return candidates
    .filter((candidate) => {
      const haystack = `${candidate.brand} ${candidate.name}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .slice(0, 6);
}

function mergeBattleCandidates(
  wardrobe: BattleFragranceCandidate[],
  global: BattleFragranceCandidate[],
): BattleFragranceCandidate[] {
  const seen = new Set<string>();
  const merged: BattleFragranceCandidate[] = [];
  for (const candidate of [...wardrobe, ...global]) {
    const key = snapshotIdentityKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
    if (merged.length >= 8) break;
  }
  return merged;
}

async function snapshotFromSearchResult(result: FragranceSearchResult): Promise<CommunityFragranceSnapshot> {
  const name = firstString(result.name);
  const brand = firstString(result.brand, result.house);
  if (!name || !brand) throw new Error('Catalog result is missing a fragrance name or house.');

  const directImageUrl = searchResultImageUrl(result);
  if (isAllowedCatalogImageUrl(directImageUrl)) {
    const family = sanitizeFamilyLabel(firstString((result as Record<string, unknown>).family));
    return {
      fragranceId: stableFragranceId(brand, name),
      name,
      brand,
      imageUrl: directImageUrl,
      ...(family ? { family } : {}),
    };
  }

  const payload = detailPayloadFor(result);
  if (!payload) {
    return { fragranceId: stableFragranceId(brand, name), name, brand };
  }

  const detail = await getFragranceDetails(payload);
  const imageUrl = detailImageUrl(detail);
  const family = sanitizeFamilyLabel(firstString(detail.family, (detail as Record<string, unknown>).family));
  return {
    fragranceId: stableFragranceId(brand, name),
    name: firstString(detail.name, name) ?? name,
    brand: firstString(detail.brand, detail.house, brand) ?? brand,
    ...(isAllowedCatalogImageUrl(imageUrl) ? { imageUrl } : {}),
    ...(family ? { family } : {}),
  };
}

interface BattleFragrancePickerProps {
  label: string;
  value: string;
  selected: CommunityFragranceSnapshot | null;
  results: BattleFragranceCandidate[];
  loading: boolean;
  selecting: boolean;
  onQueryChange: (value: string) => void;
  onSelect: (candidate: BattleFragranceCandidate) => void;
  onClear: () => void;
}

const BattleFragrancePicker: React.FC<BattleFragrancePickerProps> = ({
  label,
  value,
  selected,
  results,
  loading,
  selecting,
  onQueryChange,
  onSelect,
  onClear,
}) => (
  <div className="relative min-w-0">
    <label className="mb-2 block scent-type-label text-scent-accent/82">{label}</label>
    <div className="relative">
      <Search
        size={15}
        strokeWidth={1.8}
        className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-scent-accent"
        aria-hidden="true"
      />
      <input
        type="search"
        value={value}
        onChange={(event) => onQueryChange(event.target.value)}
        maxLength={120}
        placeholder="Search your wardrobe and catalog"
        aria-label={label}
        aria-autocomplete="list"
        className="scent-lux-input h-12 w-full rounded-[var(--radius-scent)] pl-11 pr-12 text-base text-foreground placeholder:text-scent-text-subtle"
      />
      {selected ? (
        <button
          type="button"
          onClick={onClear}
          aria-label={`Clear ${label}`}
          className="absolute right-2 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-scent-text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
        >
          <X size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      ) : loading ? (
        <LoaderCircle
          size={16}
          className="absolute right-4 top-1/2 -translate-y-1/2 animate-spin text-scent-accent"
          aria-hidden="true"
        />
      ) : null}
    </div>

    {selected ? (
      <div className="mt-2 flex items-center gap-2 rounded-[14px] border border-scent-accent/18 bg-scent-accent/[0.06] px-3 py-2 text-left">
        <Check size={15} className="shrink-0 text-scent-accent" aria-hidden="true" />
        <span className="min-w-0">
          <span className="block truncate font-serif text-base italic text-foreground">{selected.name}</span>
          <span className="block truncate scent-type-label text-scent-accent/82">{selected.brand}</span>
        </span>
      </div>
    ) : null}

    {results.length > 0 && !selected ? (
      <div className="absolute left-0 right-0 top-full z-30 mt-2 max-h-72 overflow-y-auto rounded-[18px] border border-scent-accent/28 bg-neutral-950/98 p-2 shadow-[0_24px_48px_rgba(0,0,0,0.78)]">
        {results.map((candidate) => (
          <button
            key={`${candidate.source}:${candidate.id}`}
            type="button"
            onClick={() => onSelect(candidate)}
            disabled={selecting}
            className="grid w-full grid-cols-[1fr_auto] items-center gap-3 rounded-[14px] px-3 py-2.5 text-left transition-colors hover:bg-scent-accent/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 disabled:pointer-events-none disabled:opacity-55"
          >
            <span className="min-w-0">
              <span className="block truncate font-serif text-base italic text-foreground">{candidate.name}</span>
              <span className="mt-1 block truncate scent-type-label text-scent-accent/82">{candidate.brand}</span>
            </span>
            <span className="rounded-full border border-scent-accent/18 px-2 py-1 scent-type-meta uppercase text-scent-text-muted">
              {candidate.source === 'wardrobe' ? 'Vault' : 'Catalog'}
            </span>
          </button>
        ))}
      </div>
    ) : null}
  </div>
);

export const PostComposer = forwardRef<PostComposerHandle, PostComposerProps>(function PostComposer(
  { authToken, onSignIn, onOpenChange },
  ref,
) {
  const [composerOpen, setComposerOpenState] = useState(false);
  // Centralize composer open/close so every caller (chips, +, imperative
  // open()/close(), submit) notifies the page, which uses it to keep the
  // composer and the search panel mutually exclusive.
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  // Mirror of composerOpen for the notify-on-change check. The parent must be
  // notified from the event handler itself — NOT from inside the state
  // updater, which React runs while rendering this component; calling the
  // page's setState there trips "Cannot update a component while rendering a
  // different component" and can drop the page-side update.
  const composerOpenValueRef = useRef(false);
  const setComposerOpen = useCallback((next: boolean) => {
    if (composerOpenValueRef.current !== next) {
      composerOpenValueRef.current = next;
      onOpenChangeRef.current?.(next);
    }
    setComposerOpenState(next);
  }, []);
  const [postType, setPostType] = useState<CommunityPostType>('question');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [weather, setWeather] = useState('');
  const [occasion, setOccasion] = useState('');
  const [mood, setMood] = useState('');
  const [battleA, setBattleA] = useState('');
  const [battleB, setBattleB] = useState('');
  const [battleASelection, setBattleASelection] = useState<CommunityFragranceSnapshot | null>(null);
  const [battleBSelection, setBattleBSelection] = useState<CommunityFragranceSnapshot | null>(null);
  const [battleAResults, setBattleAResults] = useState<BattleFragranceCandidate[]>([]);
  const [battleBResults, setBattleBResults] = useState<BattleFragranceCandidate[]>([]);
  const [searchingBattleA, setSearchingBattleA] = useState(false);
  const [searchingBattleB, setSearchingBattleB] = useState(false);
  const [selectingBattleSide, setSelectingBattleSide] = useState<'a' | 'b' | null>(null);
  const [priceContext, setPriceContext] = useState('');
  const [fragranceQuery, setFragranceQuery] = useState('');
  const [fragranceResults, setFragranceResults] = useState<FragranceSearchResult[]>([]);
  const [searchingFragrance, setSearchingFragrance] = useState(false);
  const [selectingFragranceId, setSelectingFragranceId] = useState<string | null>(null);
  const [selectedFragrances, setSelectedFragrances] = useState<CommunityFragranceSnapshot[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusTone, setStatusTone] = useState<StatusTone>('info');
  const fragranceAbortRef = useRef<AbortController | null>(null);
  const battleAAbortRef = useRef<AbortController | null>(null);
  const battleBAbortRef = useRef<AbortController | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const createPost = useCreateCommunityPost(authToken);
  const wardrobeItems = useWardrobeItems();
  const wardrobeBattleCandidates = useMemo(
    () =>
      wardrobeItems
        .map((item, index) => snapshotFromWardrobeItem(item as unknown as Record<string, unknown>, index))
        .filter((candidate): candidate is BattleFragranceCandidate => candidate !== null),
    [wardrobeItems],
  );
  const activeRoom = ROOMS.find((room) => room.type === postType) ?? ROOMS[0]!;
  const bodyPlaceholder = postType === 'question'
    ? 'What are you trying to figure out?'
    : postType === 'sotd'
      ? 'What are you wearing today, and how is it working?'
      : postType === 'battle'
        ? 'What should people judge between these two?'
        : 'What bottle, size, condition, and price are you checking?';

  const notify = (message: string, tone: StatusTone = 'info') => {
    setStatusMessage(message);
    setStatusTone(tone);
  };
  const clearStatus = () => setStatusMessage(null);

  // Live battle validation so the submit button and an inline hint reflect what's
  // missing instead of letting the user fill the whole form and bounce on submit.
  const battleMissing = !battleASelection || !battleBSelection;
  const battleDuplicate =
    !battleMissing && snapshotIdentityKey(battleASelection) === snapshotIdentityKey(battleBSelection);
  const battleReady = !battleMissing && !battleDuplicate;
  const battleHint = postType === 'battle' && !battleReady
    ? battleDuplicate
      ? 'Pick two different fragrances to start the battle.'
      : 'Pick two fragrances from your vault or the catalog to start the battle.'
    : null;

  const hasBody = body.trim().length > 0;
  const meetsTypeRequirements = postType !== 'battle' || battleReady;
  const canSubmit = hasBody && meetsTypeRequirements;
  const bodyLength = body.length;
  const bodyNearLimit = bodyLength >= MAX_BODY_LENGTH - 200;

  const requestSubmit = () => {
    formRef.current?.requestSubmit();
  };

  useEffect(() => {
    return () => {
      fragranceAbortRef.current?.abort();
      battleAAbortRef.current?.abort();
      battleBAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (postType !== 'battle') return undefined;

    const runBattleSearch = (
      query: string,
      selected: CommunityFragranceSnapshot | null,
      abortRef: React.MutableRefObject<AbortController | null>,
      setResults: React.Dispatch<React.SetStateAction<BattleFragranceCandidate[]>>,
      setSearching: React.Dispatch<React.SetStateAction<boolean>>,
    ) => {
      const trimmed = query.trim();
      abortRef.current?.abort();
      if (selected || trimmed.length < 2) {
        setResults([]);
        setSearching(false);
        return undefined;
      }

      const wardrobeMatches = filterWardrobeCandidates(wardrobeBattleCandidates, trimmed);
      setResults(wardrobeMatches);
      const controller = new AbortController();
      abortRef.current = controller;
      const timer = window.setTimeout(() => {
        setSearching(true);
        searchFragrances(trimmed, { signal: controller.signal })
          .then((response) => {
            const globalMatches = response.results
              .map(candidateFromSearchResult)
              .filter((candidate): candidate is BattleFragranceCandidate => candidate !== null);
            setResults(mergeBattleCandidates(wardrobeMatches, globalMatches));
          })
          .catch((err) => {
            if (err instanceof Error && err.name === 'AbortError') return;
            setResults(wardrobeMatches);
          })
          .finally(() => {
            if (abortRef.current === controller) {
              abortRef.current = null;
              setSearching(false);
            }
          });
      }, 240);

      return () => {
        window.clearTimeout(timer);
        controller.abort();
      };
    };

    const cleanupA = runBattleSearch(
      battleA,
      battleASelection,
      battleAAbortRef,
      setBattleAResults,
      setSearchingBattleA,
    );
    const cleanupB = runBattleSearch(
      battleB,
      battleBSelection,
      battleBAbortRef,
      setBattleBResults,
      setSearchingBattleB,
    );

    return () => {
      cleanupA?.();
      cleanupB?.();
    };
  }, [battleA, battleASelection, battleB, battleBSelection, postType, wardrobeBattleCandidates]);

  // Debounced search-as-you-type for the "Attach a fragrance" input, so the
  // standalone Search button is unnecessary. Mirrors the battle picker: abort
  // the in-flight request on each keystroke and only fire at >=2 chars.
  useEffect(() => {
    if (postType === 'battle') return undefined;
    const trimmed = fragranceQuery.trim();
    if (trimmed.length < 2) {
      fragranceAbortRef.current?.abort();
      fragranceAbortRef.current = null;
      setFragranceResults([]);
      return undefined;
    }

    const timer = window.setTimeout(() => {
      fragranceAbortRef.current?.abort();
      const controller = new AbortController();
      fragranceAbortRef.current = controller;
      setSearchingFragrance(true);
      searchFragrances(trimmed, { signal: controller.signal })
        .then((response) => {
          setFragranceResults(response.results.slice(0, 6));
        })
        .catch((err) => {
          if (err instanceof Error && err.name === 'AbortError') return;
          setFragranceResults([]);
        })
        .finally(() => {
          if (fragranceAbortRef.current === controller) {
            fragranceAbortRef.current = null;
            setSearchingFragrance(false);
          }
        });
    }, 280);

    return () => window.clearTimeout(timer);
  }, [fragranceQuery, postType]);

  useImperativeHandle(
    ref,
    () => ({
      open: (preset) => {
        if (preset?.type && COMMUNITY_POST_TYPES.includes(preset.type)) {
          setPostType(preset.type);
        }
        if (preset?.tag) {
          const nextTag = sanitizeCommunityTag(preset.tag);
          if (nextTag) {
            setTags((current) => (current.includes(nextTag) ? current : [nextTag, ...current].slice(0, 8)));
          }
        }
        setComposerOpen(true);
        setStatusMessage(null);
        // Wait for the expanded form to mount, then bring it into view and focus it.
        requestAnimationFrame(() => {
          sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          requestAnimationFrame(() => titleInputRef.current?.focus());
        });
      },
      close: () => {
        setComposerOpen(false);
      },
    }),
    [setComposerOpen],
  );

  const addTagsFromInput = (value: string) => {
    const nextTags = value
      .split(',')
      .map(sanitizeCommunityTag)
      .filter(Boolean);
    if (nextTags.length === 0) return;

    const merged = [...tags];
    let limitHit = false;
    for (const nextTag of nextTags) {
      if (merged.length >= MAX_TAGS) {
        limitHit = true;
        break;
      }
      if (!merged.includes(nextTag)) merged.push(nextTag);
    }
    setTags(merged);
    setTagInput('');
    if (limitHit) notify(`You can add up to ${MAX_TAGS} tags.`, 'info');
  };

  const submitTagKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' && event.key !== ',') return;
    event.preventDefault();
    addTagsFromInput(tagInput);
  };

  const searchCatalog = async () => {
    const query = fragranceQuery.trim();
    if (!query) return;

    fragranceAbortRef.current?.abort();
    const controller = new AbortController();
    fragranceAbortRef.current = controller;
    setSearchingFragrance(true);
    clearStatus();

    try {
      const response = await searchFragrances(query, { signal: controller.signal });
      setFragranceResults(response.results.slice(0, 6));
      if (response.results.length === 0) {
        notify('No catalog matches found.', 'info');
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      notify(err instanceof Error ? err.message : 'Catalog search failed.', 'error');
    } finally {
      if (fragranceAbortRef.current === controller) {
        fragranceAbortRef.current = null;
      }
      setSearchingFragrance(false);
    }
  };

  const attachFragrance = async (result: FragranceSearchResult) => {
    if (selectedFragrances.length >= 3) {
      notify('Attach up to three catalog fragrances.', 'info');
      return;
    }

    const key = firstString(result.id, result.source_url, `${result.brand ?? result.house}:${result.name}`) ?? result.name;
    setSelectingFragranceId(key);
    clearStatus();

    try {
      const snapshot = await snapshotFromSearchResult(result);
      setSelectedFragrances((current) => {
        const exists = current.some(
          (item) =>
            item.name.toLowerCase() === snapshot.name.toLowerCase() &&
            item.brand.toLowerCase() === snapshot.brand.toLowerCase(),
        );
        return exists ? current : [...current, snapshot].slice(0, 3);
      });
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Fragrance could not be attached.', 'error');
    } finally {
      setSelectingFragranceId(null);
    }
  };

  const removeFragrance = (fragrance: CommunityFragranceSnapshot) => {
    setSelectedFragrances((current) =>
      current.filter(
        (item) =>
          item.name !== fragrance.name ||
          item.brand !== fragrance.brand ||
          item.imageUrl !== fragrance.imageUrl,
      ),
    );
  };

  const selectBattleCandidate = async (side: 'a' | 'b', candidate: BattleFragranceCandidate) => {
    setSelectingBattleSide(side);
    clearStatus();
    try {
      const fallbackSnapshot: CommunityFragranceSnapshot = {
        fragranceId: stableFragranceId(candidate.brand, candidate.name),
        name: candidate.name,
        brand: candidate.brand,
        ...(candidate.imageUrl ? { imageUrl: candidate.imageUrl } : {}),
        ...(sanitizeFamilyLabel(candidate.family) ? { family: sanitizeFamilyLabel(candidate.family) ?? undefined } : {}),
      };
      let snapshot = fallbackSnapshot;
      if (candidate.result) {
        try {
          snapshot = await snapshotFromSearchResult(candidate.result);
        } catch {
          snapshot = fallbackSnapshot;
        }
      }
      if (side === 'a') {
        setBattleA(snapshot.name);
        setBattleASelection(snapshot);
        setBattleAResults([]);
      } else {
        setBattleB(snapshot.name);
        setBattleBSelection(snapshot);
        setBattleBResults([]);
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Fragrance could not be selected.', 'error');
    } finally {
      setSelectingBattleSide(null);
    }
  };

  const clearBattleSelection = (side: 'a' | 'b') => {
    if (side === 'a') {
      setBattleA('');
      setBattleASelection(null);
      setBattleAResults([]);
    } else {
      setBattleB('');
      setBattleBSelection(null);
      setBattleBResults([]);
    }
  };

  const buildMetadata = (): Record<string, unknown> | null => {
    if (postType === 'question') return {};
    if (postType === 'sotd') {
      return {
        ...(weather.trim() ? { weather: weather.trim() } : {}),
        ...(occasion.trim() ? { occasion: occasion.trim() } : {}),
        ...(mood.trim() ? { mood: mood.trim() } : {}),
      };
    }
    if (postType === 'battle') {
      if (!battleASelection || !battleBSelection) return null;
      if (snapshotIdentityKey(battleASelection) === snapshotIdentityKey(battleBSelection)) return null;
      const options = [battleOptionKey(battleASelection), battleOptionKey(battleBSelection)].filter(Boolean);
      if (options.length !== 2) return null;
      const [leftOption = '', rightOption = ''] = options;
      if (leftOption.toLowerCase() === rightOption.toLowerCase()) return null;
      return { options: [leftOption, rightOption] };
    }
    return priceContext.trim() ? { price_context: priceContext.trim() } : {};
  };

  const resetComposer = () => {
    setTitle('');
    setBody('');
    setTagInput('');
    setTags([]);
    setWeather('');
    setOccasion('');
    setMood('');
    setBattleA('');
    setBattleB('');
    setBattleASelection(null);
    setBattleBSelection(null);
    setBattleAResults([]);
    setBattleBResults([]);
    setPriceContext('');
    setFragranceQuery('');
    setFragranceResults([]);
    setSelectedFragrances([]);
  };

  const submitPost = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authToken) {
      notify('Sign in to open a room.', 'info');
      onSignIn();
      return;
    }

    const trimmedBody = body.trim();
    if (!trimmedBody) {
      notify('Tell the room what to discuss before opening.', 'error');
      return;
    }

    const metadata = buildMetadata();
    if (!metadata) {
      notify(
        battleDuplicate
          ? 'Pick two different fragrances from your vault or the catalog.'
          : 'Pick two fragrances from your vault or the catalog to start the battle.',
        'error',
      );
      return;
    }

    const postFragrances =
      postType === 'battle'
        ? [battleASelection, battleBSelection].filter(
            (fragrance): fragrance is CommunityFragranceSnapshot => fragrance !== null,
          )
        : selectedFragrances;

    clearStatus();
    try {
      await createPost.mutateAsync({
        type: postType,
        title: title.trim() || null,
        body: trimmedBody,
        metadata,
        tags,
        fragrances: postFragrances,
      });
      resetComposer();
      setComposerOpen(false);
      notify('Room opened in the community.', 'success');
      // Bring the composer/feed back into view so the freshly created room is
      // visible right after the form collapses, instead of leaving the user
      // scrolled down inside the (now closed) editor.
      requestAnimationFrame(() => {
        sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Post could not be created.', 'error');
    }
  };

  if (!composerOpen) {
    // Collapsed: the panel toolbar (community.tsx) owns the "Start a room"
    // trigger and the page hero (CommunityHero) owns the forum's label and
    // pitch, so the collapsed composer renders no hero of its own — that
    // duplication is what made this surface read as two competing controls.
    // The only thing it surfaces here is a post-submit status line (e.g. the
    // "Room opened in the community" confirmation that fires after collapse),
    // so it stays out of the layout entirely when there is nothing to say.
    if (!statusMessage) {
      return (
        <section
          ref={sectionRef}
          aria-hidden="true"
          style={{ scrollMarginTop: 'calc(var(--topbar-h) + 1rem)' }}
        />
      );
    }
    return (
      <section
        ref={sectionRef}
        className="w-full overflow-hidden border-b border-scent-accent/14 p-3 sm:p-6"
        style={{ scrollMarginTop: 'calc(var(--topbar-h) + 1rem)' }}
      >
        {/* Same tone + live-region semantics as the in-form status line, so the
            post-submit confirmation keeps its success styling and gets announced
            after the form collapses. */}
        <p
          role="status"
          aria-live="polite"
          className={`mx-auto max-w-2xl rounded-[14px] border px-4 py-3 text-center text-sm sm:text-base ${STATUS_TONE_CLASSES[statusTone]}`}
        >
          {statusMessage}
        </p>
      </section>
    );
  }

  return (
    <section
      ref={sectionRef}
      className="w-full border-b border-scent-accent/14 p-4 sm:p-6"
      style={{ scrollMarginTop: 'calc(var(--topbar-h) + 1rem)' }}
    >
      <form
        ref={formRef}
        onSubmit={submitPost}
        onKeyDown={(event) => {
          // Single-line inputs implicitly submit the form on Enter, which would
          // post the room prematurely (or trip validation) while the user is
          // still moving between fields. Only the body textarea (Cmd/Ctrl+Enter)
          // and the submit button commit the post. Inputs with their own Enter
          // handling (tags, fragrance search) already preventDefault upstream.
          if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
            event.preventDefault();
          }
        }}
        className="space-y-4 sm:space-y-5"
      >
        {/* No "Community forum" eyebrow and no in-form close button here — the
            page hero already owns the forum's label, and the panel toolbar
            (community.tsx) owns the single Start a room / Close toggle. The
            heading + room hint are the only contextual cue for the open editor,
            so the surface never reads as duplicate controls. */}
        <div className="flex flex-col items-center gap-2 px-2 text-center">
          <h2 className="font-serif text-2xl italic leading-tight text-foreground sm:text-3xl">
            Start a room
          </h2>
          <p className="mx-auto max-w-xl text-sm leading-6 text-scent-text-muted sm:text-base sm:leading-7">
            {activeRoom.hint}
          </p>
        </div>

        <div
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
          role="group"
          aria-label="Room type"
        >
          {ROOMS.map(({ type, label, shortLabel, Icon }) => (
            <button
              key={type}
              type="button"
              onClick={() => {
                setPostType(type);
                // Requirements change with the room type; drop any stale notice
                // (e.g. a battle validation error) so it doesn't linger.
                clearStatus();
              }}
              aria-label={label}
              aria-pressed={postType === type}
              className={[
                'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full border px-3 py-2 text-center scent-type-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35',
                postType === type
                  ? 'border-scent-accent/48 bg-scent-accent/[0.08] text-foreground'
                  : 'border-scent-accent/16 bg-black/54 text-scent-text-muted hover:border-scent-accent/34 hover:text-foreground',
              ].join(' ')}
            >
              <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
              {shortLabel}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input
            ref={titleInputRef}
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={140}
            placeholder="Optional room title"
            aria-label="Room name"
            className="scent-lux-input h-12 w-full rounded-[var(--radius-scent)] px-4 text-base text-foreground placeholder:text-scent-text-subtle"
          />
          <input
            type="text"
            value={tagInput}
            onChange={(event) => setTagInput(event.target.value)}
            onKeyDown={submitTagKey}
            onBlur={() => addTagsFromInput(tagInput)}
            placeholder="Optional tags, comma separated"
            aria-label="Room tags"
            className="scent-lux-input h-12 w-full rounded-[var(--radius-scent)] px-4 text-base text-foreground placeholder:text-scent-text-subtle"
          />
        </div>

        {tags.length > 0 ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setTags((current) => current.filter((item) => item !== tag))}
                aria-label={`Remove tag ${tag}`}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/54 px-3 py-1.5 scent-type-chip text-scent-text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35"
              >
                #{tag}
                <X size={12} strokeWidth={1.8} aria-hidden="true" />
              </button>
            ))}
            <span className="scent-type-meta uppercase text-scent-text-subtle">{tags.length}/{MAX_TAGS}</span>
          </div>
        ) : null}

        {postType === 'sotd' ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 md:gap-4">
            <input
              type="text"
              value={weather}
              onChange={(event) => setWeather(event.target.value)}
              maxLength={80}
              placeholder="Weather (optional)"
              aria-label="Weather"
              className="scent-lux-input h-11 rounded-full px-4 text-base text-foreground placeholder:text-scent-text-subtle"
            />
            <input
              type="text"
              value={occasion}
              onChange={(event) => setOccasion(event.target.value)}
              maxLength={80}
              placeholder="Occasion (optional)"
              aria-label="Occasion"
              className="scent-lux-input h-11 rounded-full px-4 text-base text-foreground placeholder:text-scent-text-subtle"
            />
            <input
              type="text"
              value={mood}
              onChange={(event) => setMood(event.target.value)}
              maxLength={80}
              placeholder="Mood (optional)"
              aria-label="Mood"
              className="scent-lux-input h-11 rounded-full px-4 text-base text-foreground placeholder:text-scent-text-subtle"
            />
          </div>
        ) : null}

        {postType === 'battle' ? (
          <div className="grid gap-4 md:grid-cols-2">
            <BattleFragrancePicker
              label="Option A"
              value={battleA}
              selected={battleASelection}
              results={battleAResults}
              loading={searchingBattleA}
              selecting={selectingBattleSide === 'a'}
              onQueryChange={(value) => {
                setBattleA(value);
                setBattleASelection(null);
              }}
              onSelect={(candidate) => void selectBattleCandidate('a', candidate)}
              onClear={() => clearBattleSelection('a')}
            />
            <BattleFragrancePicker
              label="Option B"
              value={battleB}
              selected={battleBSelection}
              results={battleBResults}
              loading={searchingBattleB}
              selecting={selectingBattleSide === 'b'}
              onQueryChange={(value) => {
                setBattleB(value);
                setBattleBSelection(null);
              }}
              onSelect={(candidate) => void selectBattleCandidate('b', candidate)}
              onClear={() => clearBattleSelection('b')}
            />
          </div>
        ) : null}

        {battleHint ? (
          <p className="text-center scent-type-meta uppercase text-scent-accent/82">{battleHint}</p>
        ) : null}

        {postType === 'worth_it' ? (
          <input
            type="text"
            value={priceContext}
            onChange={(event) => setPriceContext(event.target.value)}
            maxLength={120}
            placeholder="Price context (optional)"
            aria-label="Price context"
            className="scent-lux-input h-11 w-full rounded-full px-4 text-base text-foreground placeholder:text-scent-text-subtle"
          />
        ) : null}

        <div>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              // Power-user affordance: submit without reaching for the mouse.
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                requestSubmit();
              }
            }}
            rows={5}
            maxLength={MAX_BODY_LENGTH}
            placeholder={bodyPlaceholder}
            aria-label="Room discussion"
            className="scent-lux-input min-h-40 w-full resize-y rounded-[var(--radius-scent)] px-4 py-3 text-base leading-7 text-foreground placeholder:text-scent-text-subtle"
          />
          {/* Live character count sits directly under the textarea, right-aligned. */}
          <p className={`mt-1.5 text-right scent-type-meta uppercase ${bodyNearLimit ? 'text-scent-accent' : 'text-scent-text-subtle'}`}>
            {bodyLength}/{MAX_BODY_LENGTH}
          </p>
        </div>

        {postType !== 'battle' ? (
        <div className="space-y-4 rounded-[18px] border border-scent-accent/12 bg-black/72 p-4">
          <div className="relative w-full min-w-0">
            <Search
              size={16}
              strokeWidth={1.8}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-scent-accent"
              aria-hidden="true"
            />
            <input
              type="search"
              value={fragranceQuery}
              onChange={(event) => setFragranceQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void searchCatalog();
                }
              }}
              placeholder="Attach a fragrance"
              aria-label="Search fragrance to attach"
              aria-autocomplete="list"
              className="scent-lux-input h-11 w-full rounded-full pl-11 pr-11 text-base text-foreground placeholder:text-scent-text-subtle"
            />
            {searchingFragrance ? (
              <LoaderCircle
                size={16}
                className="absolute right-4 top-1/2 -translate-y-1/2 animate-spin text-scent-accent"
                aria-hidden="true"
              />
            ) : null}
          </div>

          {fragranceResults.length > 0 ? (
            <div className="grid gap-2 md:grid-cols-2">
              {fragranceResults.map((result) => {
                const key = firstString(result.id, result.source_url, `${result.brand ?? result.house}:${result.name}`) ?? result.name;
                const busy = selectingFragranceId === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => void attachFragrance(result)}
                    disabled={busy || selectedFragrances.length >= 3}
                    className="grid min-h-16 grid-cols-[1fr_auto] items-center gap-3 rounded-[14px] border border-white/10 bg-black/62 px-4 py-3 text-left transition-colors hover:border-scent-accent/28 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35 disabled:pointer-events-none disabled:opacity-55"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-serif text-base italic text-foreground">
                        {result.name}
                      </span>
                      <span className="mt-1 block truncate scent-type-label text-scent-accent">
                        {firstString(result.brand, result.house) ?? 'House unavailable'}
                      </span>
                    </span>
                    {busy ? (
                      <LoaderCircle size={16} className="animate-spin text-scent-accent" aria-hidden="true" />
                    ) : (
                      <Plus size={16} className="text-scent-accent" aria-hidden="true" />
                    )}
                  </button>
                );
              })}
            </div>
          ) : null}

          {selectedFragrances.length > 0 ? (
            <div className="flex flex-wrap justify-center gap-4">
              {selectedFragrances.map((fragrance) => (
                <div
                  key={`${fragrance.brand}:${fragrance.name}:${fragrance.imageUrl}`}
                  className="grid w-full max-w-[18rem] grid-cols-[3.25rem_1fr_auto] items-center gap-3 rounded-[14px] border border-scent-accent/14 bg-black/62 p-2 sm:w-auto"
                >
                  <div className="relative h-16 w-[3.25rem] overflow-hidden rounded-[10px] bg-white/[0.035]">
                    {/* Render-budget-aware thumbnail (BottleImage handles its own
                        missing-image placeholder) instead of a raw <img>. */}
                    <BottleImage
                      src={fragrance.imageUrl}
                      alt={`${fragrance.name} by ${fragrance.brand}`}
                      variant="thumb"
                      className="absolute inset-0"
                      loading="lazy"
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-serif text-base italic leading-tight text-foreground">
                      {fragrance.name}
                    </p>
                    <p className="mt-1 truncate scent-type-label text-scent-accent">
                      {fragrance.brand}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeFragrance(fragrance)}
                    aria-label={`Remove ${fragrance.name}`}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-full text-scent-text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35"
                  >
                    <X size={14} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        ) : null}

        {statusMessage ? (
          <p
            role="status"
            aria-live="polite"
            className={`rounded-[14px] border px-4 py-3 text-center text-base ${STATUS_TONE_CLASSES[statusTone]}`}
          >
            {statusMessage}
          </p>
        ) : null}

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <span aria-hidden="true" className="hidden scent-type-meta uppercase text-scent-text-subtle sm:inline">
            Ctrl/⌘ + Enter to post
          </span>
          <button
            type="submit"
            disabled={createPost.isPending || (authToken ? !canSubmit : false)}
            className="scent-primary-button inline-flex min-h-12 items-center justify-center gap-2 rounded-[var(--radius-scent)] px-6 py-3 text-sm font-bold uppercase tracking-[0.18em] disabled:pointer-events-none disabled:opacity-60"
          >
            {createPost.isPending ? (
              <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <Send size={16} strokeWidth={1.8} aria-hidden="true" />
            )}
            <span>{authToken ? SUBMIT_LABELS[postType] : 'Sign in to post'}</span>
          </button>
        </div>
      </form>
    </section>
  );
});

PostComposer.displayName = 'PostComposer';
