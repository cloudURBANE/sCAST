import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
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

interface PostComposerProps {
  authToken: string | null;
  onSignIn: () => void;
}

export interface PostComposerHandle {
  /** Expand the composer, scroll it into view, and move focus into the form. */
  open: (preset?: { type?: CommunityPostType | null; tag?: string | null }) => void;
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

function battleOptionKey(snapshot: Pick<CommunityFragranceSnapshot, 'name'>): string {
  return snapshot.name.trim();
}

function snapshotFromWardrobeItem(item: Record<string, unknown>, index: number): BattleFragranceCandidate | null {
  const name = firstString(item.name, objectRecord(item.product).name);
  const brand = firstString(item.brand, item.house, objectRecord(item.product).brand);
  if (!name || !brand) return null;

  const imageUrl = firstString(item.imageUrl, item.image_url);
  const family = firstString(item.family);
  return {
    id: firstString(item._dbId, item.id) ?? `wardrobe:${index}:${brand}:${name}`,
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
    const family = firstString((result as Record<string, unknown>).family);
    return {
      name,
      brand,
      imageUrl: directImageUrl,
      ...(family ? { family } : {}),
    };
  }

  const payload = detailPayloadFor(result);
  if (!payload) {
    return { name, brand };
  }

  const detail = await getFragranceDetails(payload);
  const imageUrl = detailImageUrl(detail);
  const family = firstString(detail.family, (detail as Record<string, unknown>).family);
  return {
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
        className="scent-lux-input h-12 w-full rounded-[var(--radius-scent)] pl-11 pr-12 text-base text-[#fff7ec] placeholder:text-scent-text-subtle"
      />
      {selected ? (
        <button
          type="button"
          onClick={onClear}
          aria-label={`Clear ${label}`}
          className="absolute right-2 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-scent-text-muted transition-colors hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
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
          <span className="block truncate font-serif text-base italic text-[#fff7ec]">{selected.name}</span>
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
              <span className="block truncate font-serif text-base italic text-[#fff7ec]">{candidate.name}</span>
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
  { authToken, onSignIn },
  ref,
) {
  const [composerOpen, setComposerOpen] = useState(false);
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
  const fragranceAbortRef = useRef<AbortController | null>(null);
  const battleAAbortRef = useRef<AbortController | null>(null);
  const battleBAbortRef = useRef<AbortController | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
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
    }),
    [],
  );

  const addTagsFromInput = (value: string) => {
    const nextTags = value
      .split(',')
      .map(sanitizeCommunityTag)
      .filter(Boolean);
    if (nextTags.length === 0) return;

    setTags((current) => {
      const merged = [...current];
      for (const nextTag of nextTags) {
        if (!merged.includes(nextTag)) merged.push(nextTag);
        if (merged.length >= 8) break;
      }
      return merged;
    });
    setTagInput('');
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
    setStatusMessage(null);

    try {
      const response = await searchFragrances(query, { signal: controller.signal });
      setFragranceResults(response.results.slice(0, 6));
      if (response.results.length === 0) {
        setStatusMessage('No catalog matches found.');
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setStatusMessage(err instanceof Error ? err.message : 'Catalog search failed.');
    } finally {
      if (fragranceAbortRef.current === controller) {
        fragranceAbortRef.current = null;
      }
      setSearchingFragrance(false);
    }
  };

  const attachFragrance = async (result: FragranceSearchResult) => {
    if (selectedFragrances.length >= 3) {
      setStatusMessage('Attach up to three catalog fragrances.');
      return;
    }

    const key = firstString(result.id, result.source_url, `${result.brand ?? result.house}:${result.name}`) ?? result.name;
    setSelectingFragranceId(key);
    setStatusMessage(null);

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
      setStatusMessage(err instanceof Error ? err.message : 'Fragrance could not be attached.');
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
    setStatusMessage(null);
    try {
      const fallbackSnapshot: CommunityFragranceSnapshot = {
        name: candidate.name,
        brand: candidate.brand,
        ...(candidate.imageUrl ? { imageUrl: candidate.imageUrl } : {}),
        ...(candidate.family ? { family: candidate.family } : {}),
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
      setStatusMessage(err instanceof Error ? err.message : 'Fragrance could not be selected.');
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
      setStatusMessage('Sign in to open a room.');
      onSignIn();
      return;
    }

    const trimmedBody = body.trim();
    if (!trimmedBody) {
      setStatusMessage('Tell the room what to discuss before opening.');
      return;
    }

    const metadata = buildMetadata();
    if (!metadata) {
      setStatusMessage(
        postType === 'battle'
          ? 'Pick two different fragrances from your vault or the catalog.'
          : 'Battle rooms need two options.',
      );
      return;
    }

    const postFragrances =
      postType === 'battle'
        ? [battleASelection, battleBSelection].filter(
            (fragrance): fragrance is CommunityFragranceSnapshot => fragrance !== null,
          )
        : selectedFragrances;

    setStatusMessage(null);
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
      setStatusMessage('Room opened in the community.');
      // Bring the composer/feed back into view so the freshly created room is
      // visible right after the form collapses, instead of leaving the user
      // scrolled down inside the (now closed) editor.
      requestAnimationFrame(() => {
        sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : 'Post could not be created.');
    }
  };

  if (!composerOpen) {
    return (
      <section
        ref={sectionRef}
        className="relative w-full overflow-hidden border-b border-scent-accent/14 p-3 sm:p-6"
      >
        {/* Mobile: a compact "start a room" bar instead of the full marketing
            block, so the forum's starting point stays present without eating the
            viewport on small screens. */}
        <div className="flex items-center gap-2.5 sm:hidden">
          <button
            type="button"
            onClick={() => {
              setComposerOpen(true);
              setStatusMessage(null);
            }}
            aria-expanded="false"
            aria-label="Start a community room"
            className="scent-lux-input flex h-11 flex-1 items-center rounded-full px-4 text-left text-sm text-scent-text-subtle"
          >
            Start a room&hellip;
          </button>
          <button
            type="button"
            onClick={() => {
              setComposerOpen(true);
              setStatusMessage(null);
            }}
            aria-hidden="true"
            tabIndex={-1}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-scent-accent/28 bg-black/78 text-[#fff7ec] shadow-[0_4px_12px_rgba(212,175,55,0.15)] transition-all duration-200 hover:border-scent-accent/78 hover:bg-scent-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35"
          >
            <Plus size={18} strokeWidth={2.2} className="text-[#fff7ec]" aria-hidden="true" />
          </button>
        </div>

        {/* Desktop: full forum hero with the floating + control. */}
        <button
          type="button"
          onClick={() => {
            setComposerOpen(true);
            setStatusMessage(null);
          }}
          aria-expanded="false"
          aria-label="Start a community room"
          className="absolute right-5 top-5 z-10 hidden h-10 w-10 items-center justify-center rounded-full border border-scent-accent/28 bg-black/78 text-[#fff7ec] shadow-[0_4px_12px_rgba(212,175,55,0.15)] transition-all duration-200 hover:border-scent-accent/78 hover:bg-scent-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35 sm:flex"
        >
          <Plus size={18} strokeWidth={2.2} className="text-[#fff7ec]" aria-hidden="true" />
        </button>
        <div className="mx-auto hidden max-w-2xl flex-col items-center px-12 text-center sm:flex">
          <p className="scent-type-label text-scent-accent">
            Community forum
          </p>
          <h2 className="mt-4 text-balance font-serif text-2xl italic leading-tight text-[#fff7ec] sm:text-4xl">
            Rooms already moving through the lounge.
          </h2>
          <p className="mt-4 max-w-xl text-base leading-7 text-scent-text-muted">
            Ask a question, share your SOTD, run a battle, or check if a bottle is worth it.
          </p>
        </div>

        {statusMessage ? (
          <p className="mx-auto mt-4 max-w-2xl rounded-[14px] border border-scent-accent/12 bg-black/58 px-4 py-3 text-center text-sm text-scent-text-muted sm:mt-6 sm:text-base">
            {statusMessage}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section
      ref={sectionRef}
      className="w-full border-b border-scent-accent/14 p-4 sm:p-6"
    >
      <form onSubmit={submitPost} className="space-y-4 sm:space-y-5">
        <div className="relative flex flex-col items-center gap-2 text-center">
          <div className="min-w-0 px-10 sm:px-14">
            <p className="scent-type-label text-scent-accent">
              Community forum
            </p>
            <h2 className="mt-1 font-serif text-2xl italic leading-tight text-[#fff7ec] sm:text-3xl">
              Start a room
            </h2>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-scent-text-muted sm:text-base sm:leading-7">
              {activeRoom.hint}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setComposerOpen(false)}
            aria-expanded="true"
            aria-label="Close composer"
            className="absolute right-0 top-0 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-scent-accent/18 bg-black/70 text-scent-text-muted transition-colors hover:border-scent-accent/36 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35"
          >
            <X size={16} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </div>

        <div
          className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0"
          role="listbox"
          aria-label="Room type"
        >
          {ROOMS.map(({ type, label, shortLabel, Icon }) => (
            <button
              key={type}
              type="button"
              onClick={() => setPostType(type)}
              role="option"
              aria-label={label}
              aria-selected={postType === type}
              aria-pressed={postType === type}
              className={[
                'inline-flex min-h-11 min-w-[7rem] snap-start items-center justify-center gap-2 rounded-full border px-3 py-2 text-center scent-type-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35',
                postType === type
                  ? 'border-scent-accent/48 bg-scent-accent/[0.08] text-[#fff7ec]'
                  : 'border-scent-accent/16 bg-black/54 text-scent-text-muted hover:border-scent-accent/34 hover:text-[#fff7ec]',
              ].join(' ')}
            >
              <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
              {shortLabel}
            </button>
          ))}
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
          <input
            ref={titleInputRef}
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={140}
            placeholder="Optional room title"
            aria-label="Room name"
            className="scent-lux-input h-12 w-full rounded-[var(--radius-scent)] px-4 text-base text-[#fff7ec] placeholder:text-scent-text-subtle"
          />
          <input
            type="text"
            value={tagInput}
            onChange={(event) => setTagInput(event.target.value)}
            onKeyDown={submitTagKey}
            onBlur={() => addTagsFromInput(tagInput)}
            placeholder="Optional tags, comma separated"
            aria-label="Room tags"
            className="scent-lux-input h-12 w-full rounded-[var(--radius-scent)] px-4 text-base text-[#fff7ec] placeholder:text-scent-text-subtle"
          />
        </div>

        {tags.length > 0 ? (
          <div className="flex flex-wrap justify-center gap-2">
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setTags((current) => current.filter((item) => item !== tag))}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/54 px-3 py-1.5 scent-type-chip text-scent-text-muted transition-colors hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35"
              >
                #{tag}
                <X size={12} strokeWidth={1.8} aria-hidden="true" />
              </button>
            ))}
          </div>
        ) : null}

        {postType === 'sotd' ? (
          <div className="grid gap-4 md:grid-cols-3">
            <input
              type="text"
              value={weather}
              onChange={(event) => setWeather(event.target.value)}
              maxLength={80}
              placeholder="Weather (optional)"
              aria-label="Weather"
              className="scent-lux-input h-11 rounded-full px-4 text-base text-[#fff7ec] placeholder:text-scent-text-subtle"
            />
            <input
              type="text"
              value={occasion}
              onChange={(event) => setOccasion(event.target.value)}
              maxLength={80}
              placeholder="Occasion (optional)"
              aria-label="Occasion"
              className="scent-lux-input h-11 rounded-full px-4 text-base text-[#fff7ec] placeholder:text-scent-text-subtle"
            />
            <input
              type="text"
              value={mood}
              onChange={(event) => setMood(event.target.value)}
              maxLength={80}
              placeholder="Mood (optional)"
              aria-label="Mood"
              className="scent-lux-input h-11 rounded-full px-4 text-base text-[#fff7ec] placeholder:text-scent-text-subtle"
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

        {postType === 'worth_it' ? (
          <input
            type="text"
            value={priceContext}
            onChange={(event) => setPriceContext(event.target.value)}
            maxLength={120}
            placeholder="Price context (optional)"
            aria-label="Price context"
            className="scent-lux-input h-11 w-full rounded-full px-4 text-base text-[#fff7ec] placeholder:text-scent-text-subtle"
          />
        ) : null}

        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={5}
          maxLength={4000}
          placeholder={bodyPlaceholder}
          aria-label="Room discussion"
          className="scent-lux-input min-h-40 w-full resize-y rounded-[var(--radius-scent)] px-4 py-3 text-base leading-7 text-[#fff7ec] placeholder:text-scent-text-subtle"
        />

        {postType !== 'battle' ? (
        <div className="space-y-4 rounded-[18px] border border-scent-accent/12 bg-black/72 p-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div className="relative min-w-0">
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
                className="scent-lux-input h-11 w-full rounded-full pl-11 pr-4 text-base text-[#fff7ec] placeholder:text-scent-text-subtle"
              />
            </div>
            <button
              type="button"
              onClick={() => void searchCatalog()}
              disabled={searchingFragrance || !fragranceQuery.trim()}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-scent-accent/24 bg-black/58 px-4 py-2 scent-type-chip text-scent-text-muted transition-colors hover:border-scent-accent/42 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35 disabled:pointer-events-none disabled:opacity-55"
            >
              {searchingFragrance ? (
                <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
              ) : (
                <Search size={14} strokeWidth={1.8} aria-hidden="true" />
              )}
              Search
            </button>
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
                      <span className="block truncate font-serif text-base italic text-[#fff7ec]">
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
                  <div className="flex h-16 w-[3.25rem] items-center justify-center overflow-hidden rounded-[10px] bg-white/[0.035]">
                    {fragrance.imageUrl ? (
                      <img
                        src={fragrance.imageUrl}
                        alt={`${fragrance.name} by ${fragrance.brand}`}
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <span className="px-1 text-center scent-type-placeholder">No image</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-serif text-base italic leading-tight text-[#fff7ec]">
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
                    className="inline-flex h-11 w-11 items-center justify-center rounded-full text-scent-text-muted transition-colors hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35"
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
          <p className="rounded-[14px] border border-scent-accent/12 bg-black/58 px-4 py-3 text-center text-base text-scent-text-muted">
            {statusMessage}
          </p>
        ) : null}

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="scent-type-meta uppercase">
            {body.trim().length}/4000
          </p>
          <button
            type="submit"
            disabled={createPost.isPending || (authToken ? !body.trim() : false)}
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
