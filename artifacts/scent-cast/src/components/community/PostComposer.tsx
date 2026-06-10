import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  BadgeDollarSign,
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
  type CommunityFragranceSnapshot,
  type CommunityPostType,
  sanitizeCommunityTag,
  useCreateCommunityPost,
} from '@/components/community/communityPosts';

interface ComposerRoom {
  type: CommunityPostType;
  label: string;
  Icon: LucideIcon;
}

const ROOMS: ComposerRoom[] = [
  { type: 'question', label: 'Ask a question', Icon: MessageCircleQuestion },
  { type: 'sotd', label: 'SOTD', Icon: Sun },
  { type: 'battle', label: 'Battle', Icon: Swords },
  { type: 'worth_it', label: 'Price Check', Icon: BadgeDollarSign },
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
  open: () => void;
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
  if (!payload) throw new Error('Catalog result is missing a detail lookup id.');

  const detail = await getFragranceDetails(payload);
  const imageUrl = detailImageUrl(detail);
  if (!isAllowedCatalogImageUrl(imageUrl)) {
    throw new Error('Catalog image is unavailable for this fragrance.');
  }

  const family = firstString(detail.family, (detail as Record<string, unknown>).family);
  return {
    name: firstString(detail.name, name) ?? name,
    brand: firstString(detail.brand, detail.house, brand) ?? brand,
    imageUrl,
    ...(family ? { family } : {}),
  };
}

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
  const [priceContext, setPriceContext] = useState('');
  const [fragranceQuery, setFragranceQuery] = useState('');
  const [fragranceResults, setFragranceResults] = useState<FragranceSearchResult[]>([]);
  const [searchingFragrance, setSearchingFragrance] = useState(false);
  const [selectingFragranceId, setSelectingFragranceId] = useState<string | null>(null);
  const [selectedFragrances, setSelectedFragrances] = useState<CommunityFragranceSnapshot[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const fragranceAbortRef = useRef<AbortController | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const createPost = useCreateCommunityPost(authToken);

  useEffect(() => {
    return () => fragranceAbortRef.current?.abort();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      open: () => {
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
      const options = [battleA.trim(), battleB.trim()].filter(Boolean);
      if (options.length !== 2) return null;
      return { options };
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
      setStatusMessage('Battle rooms need two options.');
      return;
    }

    setStatusMessage(null);
    try {
      await createPost.mutateAsync({
        type: postType,
        title: title.trim() || null,
        body: trimmedBody,
        metadata,
        tags,
        fragrances: selectedFragrances,
      });
      resetComposer();
      setComposerOpen(false);
      setStatusMessage('Room opened in the community.');
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : 'Post could not be created.');
    }
  };

  if (!composerOpen) {
    return (
      <section
        ref={sectionRef}
        className="relative mx-auto w-full max-w-[960px] overflow-hidden rounded-[var(--radius-scent)] border border-scent-accent/24 bg-[linear-gradient(180deg,rgba(10,9,7,0.88),rgba(0,0,0,0.96))] p-6 shadow-[0_18px_44px_-30px_rgba(0,0,0,0.95),0_0_0_1px_rgba(212,175,55,0.06),inset_0_1px_0_rgba(255,236,183,0.06)]"
      >
        <button
          type="button"
          onClick={() => {
            setComposerOpen(true);
            setStatusMessage(null);
          }}
          aria-expanded="false"
          className="absolute right-4 top-4 z-10 inline-flex min-h-11 items-center justify-center rounded-full border border-scent-accent/28 bg-black/78 px-4 py-2 scent-type-chip text-[#fff7ec] shadow-[0_14px_28px_-18px_rgba(212,175,55,0.38)] transition-colors hover:border-scent-accent/48 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35 sm:right-5 sm:top-5"
        >
          Start
        </button>
        <div className="mx-auto flex max-w-2xl flex-col items-center px-9 text-center sm:px-12">
          <p className="scent-type-label text-scent-accent">
            Community forum
          </p>
          <h2 className="mt-4 text-balance font-serif text-3xl italic leading-tight text-[#fff7ec] sm:text-4xl">
            Rooms already moving through the lounge.
          </h2>
          <p className="mt-4 max-w-xl text-base leading-7 text-scent-text-muted">
            Ask a question, share your SOTD, run a battle, or check if a bottle is worth it.
          </p>
        </div>

        {statusMessage ? (
          <p className="mx-auto mt-6 max-w-2xl rounded-[14px] border border-scent-accent/12 bg-black/58 px-4 py-3 text-center text-base text-scent-text-muted">
            {statusMessage}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section
      ref={sectionRef}
      className="mx-auto w-full max-w-[960px] rounded-[var(--radius-scent)] border border-scent-accent/24 bg-[linear-gradient(180deg,rgba(10,9,7,0.88),rgba(0,0,0,0.96))] p-6 shadow-[0_18px_44px_-30px_rgba(0,0,0,0.95),0_0_0_1px_rgba(212,175,55,0.06),inset_0_1px_0_rgba(255,236,183,0.06)]"
    >
      <form onSubmit={submitPost} className="space-y-6">
        <div className="relative flex flex-col items-center gap-4 text-center">
          <div className="min-w-0 px-10 sm:px-14">
            <p className="scent-type-label text-scent-accent">
              Community forum
            </p>
            <h2 className="mt-2 font-serif text-3xl italic leading-tight text-[#fff7ec]">
              Start a room
            </h2>
            <p className="mt-4 max-w-2xl text-base leading-7 text-scent-text-muted">
              Ask a question, share your SOTD, run a battle, or check if a bottle is worth it.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setComposerOpen(false)}
            aria-expanded="true"
            className="absolute right-0 top-0 inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-full border border-scent-accent/18 bg-black/70 px-4 py-2 scent-type-chip text-scent-text-muted transition-colors hover:border-scent-accent/36 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35"
          >
            <X size={13} strokeWidth={1.8} aria-hidden="true" />
            Close
          </button>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {ROOMS.map(({ type, label, Icon }) => (
            <button
              key={type}
              type="button"
              onClick={() => setPostType(type)}
              aria-pressed={postType === type}
              className={[
                'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border px-3 py-2 text-center scent-type-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35',
                postType === type
                  ? 'border-scent-accent/48 bg-scent-accent/[0.08] text-[#fff7ec]'
                  : 'border-scent-accent/16 bg-black/54 text-scent-text-muted hover:border-scent-accent/34 hover:text-[#fff7ec]',
              ].join(' ')}
            >
              <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
          <input
            ref={titleInputRef}
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={140}
            placeholder="Name the room"
            aria-label="Room name"
            className="scent-lux-input h-12 w-full rounded-[var(--radius-scent)] px-4 text-base text-[#fff7ec] placeholder:text-scent-text-subtle"
          />
          <input
            type="text"
            value={tagInput}
            onChange={(event) => setTagInput(event.target.value)}
            onKeyDown={submitTagKey}
            onBlur={() => addTagsFromInput(tagInput)}
            placeholder="Add vibe tags"
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
              placeholder="Weather"
              aria-label="Weather"
              className="scent-lux-input h-11 rounded-full px-4 text-base text-[#fff7ec] placeholder:text-scent-text-subtle"
            />
            <input
              type="text"
              value={occasion}
              onChange={(event) => setOccasion(event.target.value)}
              maxLength={80}
              placeholder="Occasion"
              aria-label="Occasion"
              className="scent-lux-input h-11 rounded-full px-4 text-base text-[#fff7ec] placeholder:text-scent-text-subtle"
            />
            <input
              type="text"
              value={mood}
              onChange={(event) => setMood(event.target.value)}
              maxLength={80}
              placeholder="Mood"
              aria-label="Mood"
              className="scent-lux-input h-11 rounded-full px-4 text-base text-[#fff7ec] placeholder:text-scent-text-subtle"
            />
          </div>
        ) : null}

        {postType === 'battle' ? (
          <div className="grid gap-4 md:grid-cols-2">
            <input
              type="text"
              value={battleA}
              onChange={(event) => setBattleA(event.target.value)}
              maxLength={80}
              placeholder="Option A"
              aria-label="Battle option A"
              className="scent-lux-input h-11 rounded-full px-4 text-base text-[#fff7ec] placeholder:text-scent-text-subtle"
            />
            <input
              type="text"
              value={battleB}
              onChange={(event) => setBattleB(event.target.value)}
              maxLength={80}
              placeholder="Option B"
              aria-label="Battle option B"
              className="scent-lux-input h-11 rounded-full px-4 text-base text-[#fff7ec] placeholder:text-scent-text-subtle"
            />
          </div>
        ) : null}

        {postType === 'worth_it' ? (
          <input
            type="text"
            value={priceContext}
            onChange={(event) => setPriceContext(event.target.value)}
            maxLength={120}
            placeholder="Price context"
            aria-label="Price context"
            className="scent-lux-input h-11 w-full rounded-full px-4 text-base text-[#fff7ec] placeholder:text-scent-text-subtle"
          />
        ) : null}

        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={5}
          maxLength={4000}
          placeholder="What should the room discuss?"
          aria-label="Room discussion"
          className="scent-lux-input min-h-40 w-full resize-y rounded-[var(--radius-scent)] px-4 py-3 text-base leading-7 text-[#fff7ec] placeholder:text-scent-text-subtle"
        />

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
                    <img
                      src={fragrance.imageUrl}
                      alt={`${fragrance.name} by ${fragrance.brand}`}
                      className="h-full w-full object-contain"
                    />
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
