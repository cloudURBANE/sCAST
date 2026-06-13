import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { normalizeApiBaseUrl } from '@/lib/imageProxy';

export const COMMUNITY_POST_TYPES = ['question', 'sotd', 'battle', 'worth_it'] as const;

export type CommunityPostType = (typeof COMMUNITY_POST_TYPES)[number];
export type CommunityReactionTargetType = 'post' | 'comment';

export interface CommunityAuthor {
  id: string;
  email: string;
  shareId: string;
  pictureUrl?: string;
  // Public display name the member chose in profile settings. Absent until set;
  // the UI falls back to the Google email local-part rather than the full email.
  username?: string;
}

export interface CommunityFragranceSnapshot {
  name: string;
  brand: string;
  imageUrl?: string;
  family?: string;
}

export interface CommunityPost {
  id: string;
  postType: CommunityPostType;
  title: string | null;
  body: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  author: CommunityAuthor;
  tags: string[];
  fragrances: CommunityFragranceSnapshot[];
  counts: {
    comments: number;
    reactions: Record<string, number>;
  };
  votes: Record<string, number>;
  // Viewer's own state ([]/null when anonymous). Lets the UI show pressed
  // reactions and the picked battle option without a second request.
  viewerReactions: string[];
  viewerVote: string | null;
  // Viewer's own "why it won" reason for a battle pick (null when unset/anon).
  // Server-persisted so the resolved arena state syncs across devices.
  viewerVoteReason: string | null;
}

export interface CommunityComment {
  id: string;
  postId: string;
  parentCommentId: string | null;
  body: string;
  createdAt: string;
  author: CommunityAuthor;
  counts: {
    reactions: Record<string, number>;
  };
  viewerReactions: string[];
}

export interface CommunityPostsPage {
  posts: CommunityPost[];
  nextCursor: string | null;
}

export interface CommunityPostDetail {
  post: CommunityPost;
  comments: CommunityComment[];
}

export interface CommunityPostFilters {
  type?: CommunityPostType | null;
  tag?: string | null;
  q?: string | null;
  limit?: number;
}

export interface CreateCommunityPostInput {
  type: CommunityPostType;
  title?: string | null;
  body: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  fragrances?: CommunityFragranceSnapshot[];
}

export interface CreateCommunityCommentInput {
  postId: string;
  body: string;
}

export interface ToggleCommunityReactionInput {
  targetType: CommunityReactionTargetType;
  targetId: string;
  reaction: string;
}

export interface ToggleCommunityReactionResult {
  active: boolean;
  targetType: CommunityReactionTargetType;
  targetId: string;
  reactions: Record<string, number>;
}

export interface CreateCommunityVoteInput {
  postId: string;
  choice: string;
  // Optional "why it won" reason key. Omit to leave any existing reason intact
  // (a plain pick switch); pass a value to record/update it; pass null to clear.
  reason?: string | null;
}

export interface CreateCommunityVoteResult {
  postId: string;
  choice: string;
  reason: string | null;
  votes: Record<string, number>;
}

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env?.VITE_API_BASE_URL as string | undefined);
const COMMUNITY_POSTS_ROOT_KEY = ['community', 'posts'] as const;
const COMMUNITY_POST_DETAIL_ROOT_KEY = ['community', 'post-detail'] as const;
const COMMUNITY_POPULAR_TAGS_ROOT_KEY = ['community', 'popular-tags'] as const;

function appApiUrl(path: string): string {
  return API_BASE_URL ? `${API_BASE_URL}${path}` : path;
}

function authHeaders(authToken: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authToken}`,
  };
}

function requireAuthToken(authToken: string | null | undefined): string {
  if (!authToken) {
    throw new Error('Sign in required.');
  }
  return authToken;
}

async function apiErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.clone().json()) as { error?: unknown; detail?: unknown; message?: unknown };
    for (const value of [data.error, data.detail, data.message]) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch {
    try {
      const text = await res.text();
      if (text.trim()) return text.trim();
    } catch {
      return fallback;
    }
  }

  return fallback;
}

async function readJson<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    throw new Error(await apiErrorMessage(res, fallback));
  }
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new Error(fallback);
  }
}

export function sanitizeCommunityTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 32);
}

function normalizeFilters(filters: CommunityPostFilters): Required<Pick<CommunityPostFilters, 'limit'>> &
  Omit<CommunityPostFilters, 'limit'> {
  const type = filters.type && COMMUNITY_POST_TYPES.includes(filters.type) ? filters.type : null;
  const tag = filters.tag ? sanitizeCommunityTag(filters.tag) || null : null;
  const q = filters.q?.trim() || null;
  const limit = Math.max(1, Math.min(24, filters.limit ?? 12));

  return { type, tag, q, limit };
}

function postsQueryUrl(filters: CommunityPostFilters, cursor?: string | null): string {
  const normalized = normalizeFilters(filters);
  const params = new URLSearchParams();
  params.set('limit', String(normalized.limit));
  if (normalized.type) params.set('type', normalized.type);
  if (normalized.tag) params.set('tag', normalized.tag);
  if (normalized.q) params.set('q', normalized.q);
  if (cursor) params.set('cursor', cursor);
  return appApiUrl(`/api/community/posts?${params.toString()}`);
}

// Read endpoints are public but optionally authenticated: a token lets the server
// fold in the viewer's own reactions/vote. Send it when present.
function readHeaders(authToken?: string | null): HeadersInit {
  return authToken
    ? { Accept: 'application/json', Authorization: `Bearer ${authToken}` }
    : { Accept: 'application/json' };
}

async function fetchPublicCommunityRead(url: string, authToken?: string | null): Promise<Response> {
  const response = await fetch(url, {
    headers: readHeaders(authToken),
  });

  if (authToken && (response.status === 401 || response.status === 403)) {
    return fetch(url, {
      headers: readHeaders(null),
    });
  }

  return response;
}

export async function fetchCommunityPostsPage(
  filters: CommunityPostFilters,
  cursor?: string | null,
  authToken?: string | null,
): Promise<CommunityPostsPage> {
  const res = await fetchPublicCommunityRead(postsQueryUrl(filters, cursor), authToken);
  return readJson<CommunityPostsPage>(res, `Community feed failed with HTTP ${res.status}`);
}

export async function fetchCommunityPostDetail(
  postId: string,
  authToken?: string | null,
): Promise<CommunityPostDetail> {
  const res = await fetchPublicCommunityRead(appApiUrl(`/api/community/posts/${encodeURIComponent(postId)}`), authToken);
  return readJson<CommunityPostDetail>(res, `Community post failed with HTTP ${res.status}`);
}

export function useCommunityPosts(filters: CommunityPostFilters, authToken: string | null) {
  const normalizedFilters = normalizeFilters(filters);
  return useInfiniteQuery({
    // authToken in the key so signing in/out refetches with the right viewer
    // state and never serves another account's cached reactions/votes.
    queryKey: [...COMMUNITY_POSTS_ROOT_KEY, normalizedFilters, authToken ?? null],
    queryFn: ({ pageParam }) => fetchCommunityPostsPage(normalizedFilters, pageParam, authToken),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });
}

export function useCommunityPostDetail(postId: string, enabled: boolean, authToken: string | null) {
  return useQuery({
    queryKey: [...COMMUNITY_POST_DETAIL_ROOT_KEY, postId, authToken ?? null],
    queryFn: () => fetchCommunityPostDetail(postId, authToken),
    enabled,
    staleTime: 15 * 1000,
    refetchOnWindowFocus: false,
  });
}

export async function fetchPopularCommunityTags(authToken?: string | null): Promise<string[]> {
  const res = await fetchPublicCommunityRead(appApiUrl('/api/community/tags/popular'), authToken);
  const data = await readJson<{ tags?: unknown }>(res, `Popular tags failed with HTTP ${res.status}`);
  if (!Array.isArray(data.tags)) return [];
  // Normalize + dedupe so the filter chips always match the canonical tag form.
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of data.tags) {
    if (typeof raw !== 'string') continue;
    const tag = sanitizeCommunityTag(raw);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

export function usePopularCommunityTags(authToken: string | null) {
  return useQuery({
    queryKey: [...COMMUNITY_POPULAR_TAGS_ROOT_KEY, authToken ?? null],
    queryFn: () => fetchPopularCommunityTags(authToken),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

// ---------------------------------------------------------------------------
// Optimistic cache helpers
//
// Likes/votes/comments are one-bit changes; refetching every infinite-scroll
// page just to repaint one card is exactly the render-budget stutter the iPad
// path is sensitive to. Instead we patch the affected post/comment in place
// across every cached feed variant and the detail cache, then reconcile against
// the server's authoritative response. No blanket invalidation.
// ---------------------------------------------------------------------------

type InfiniteFeedData = { pages: CommunityPostsPage[]; pageParams: unknown[] };

/** Patch a single post wherever it lives: every cached feed page + the detail cache. */
function patchPostEverywhere(
  queryClient: QueryClient,
  postId: string,
  updater: (post: CommunityPost) => CommunityPost,
) {
  queryClient.setQueriesData<InfiniteFeedData>({ queryKey: COMMUNITY_POSTS_ROOT_KEY }, (data) => {
    if (!data) return data;
    let changed = false;
    const pages = data.pages.map((page) => {
      let pageChanged = false;
      const posts = page.posts.map((post) => {
        if (post.id !== postId) return post;
        pageChanged = true;
        changed = true;
        return updater(post);
      });
      return pageChanged ? { ...page, posts } : page;
    });
    return changed ? { ...data, pages } : data;
  });

  queryClient.setQueriesData<CommunityPostDetail>({ queryKey: COMMUNITY_POST_DETAIL_ROOT_KEY }, (data) => {
    if (!data || data.post.id !== postId) return data;
    return { ...data, post: updater(data.post) };
  });
}

/** Patch a single comment in the detail cache (comments only live there). */
function patchCommentEverywhere(
  queryClient: QueryClient,
  commentId: string,
  updater: (comment: CommunityComment) => CommunityComment,
) {
  queryClient.setQueriesData<CommunityPostDetail>({ queryKey: COMMUNITY_POST_DETAIL_ROOT_KEY }, (data) => {
    if (!data) return data;
    let changed = false;
    const comments = data.comments.map((comment) => {
      if (comment.id !== commentId) return comment;
      changed = true;
      return updater(comment);
    });
    return changed ? { ...data, comments } : data;
  });
}

type ReactableTarget = { viewerReactions: string[]; counts: { reactions: Record<string, number> } };

/** Optimistic toggle: flip membership and nudge the count by ±1. */
function toggleReactionOn<T extends ReactableTarget>(target: T, reaction: string): T {
  const has = target.viewerReactions.includes(reaction);
  const reactions = { ...target.counts.reactions };
  const next = (reactions[reaction] ?? 0) + (has ? -1 : 1);
  if (next > 0) reactions[reaction] = next;
  else delete reactions[reaction];
  return {
    ...target,
    viewerReactions: has
      ? target.viewerReactions.filter((r) => r !== reaction)
      : [...target.viewerReactions, reaction],
    counts: { ...target.counts, reactions },
  };
}

/** Reconcile a reaction to the server's authoritative result. */
function reconcileReactionOn<T extends ReactableTarget>(
  target: T,
  reaction: string,
  active: boolean,
  reactions: Record<string, number>,
): T {
  const without = target.viewerReactions.filter((r) => r !== reaction);
  return {
    ...target,
    viewerReactions: active ? [...without, reaction] : without,
    counts: { ...target.counts, reactions },
  };
}

/** Optimistic battle vote: move the tally from the previous pick (if any) to `choice`. */
function applyVoteToPost(
  post: CommunityPost,
  choice: string,
  reason?: string | null,
): CommunityPost {
  // `reason` is only patched when the caller passed the field (reason !== undefined),
  // so a plain pick switch never wipes an existing reason locally.
  const nextReason = reason !== undefined ? reason : post.viewerVoteReason;
  if (post.viewerVote === choice) {
    return nextReason === post.viewerVoteReason ? post : { ...post, viewerVoteReason: nextReason };
  }
  const votes = { ...post.votes };
  if (post.viewerVote) {
    const prev = (votes[post.viewerVote] ?? 0) - 1;
    if (prev > 0) votes[post.viewerVote] = prev;
    else delete votes[post.viewerVote];
  }
  votes[choice] = (votes[choice] ?? 0) + 1;
  return { ...post, viewerVote: choice, viewerVoteReason: nextReason, votes };
}

export function useCreateCommunityPost(authToken: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateCommunityPostInput) => {
      const token = requireAuthToken(authToken);
      const res = await fetch(appApiUrl('/api/community/posts'), {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(input),
      });
      return readJson<{ post: CommunityPost }>(res, `Community post create failed with HTTP ${res.status}`);
    },
    // Creating a post is rare and changes ordering/filtering, so a refetch is the
    // safe, correct choice here (unlike the per-card mutations below).
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: COMMUNITY_POSTS_ROOT_KEY });
    },
  });
}

export function useCreateCommunityComment(authToken: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateCommunityCommentInput) => {
      const token = requireAuthToken(authToken);
      const res = await fetch(appApiUrl(`/api/community/posts/${encodeURIComponent(input.postId)}/comments`), {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ body: input.body }),
      });
      return readJson<{ comment: CommunityComment }>(res, `Community comment failed with HTTP ${res.status}`);
    },
    // Optimistically bump the feed card's comment count; let the detail cache
    // refetch to surface the new comment itself (cheap, one post).
    onMutate: async ({ postId }) => {
      await queryClient.cancelQueries({ queryKey: COMMUNITY_POSTS_ROOT_KEY });
      const previousFeeds = queryClient.getQueriesData<InfiniteFeedData>({ queryKey: COMMUNITY_POSTS_ROOT_KEY });
      patchPostEverywhere(queryClient, postId, (post) => ({
        ...post,
        counts: { ...post.counts, comments: post.counts.comments + 1 },
      }));
      return { previousFeeds };
    },
    onError: (_err, _variables, context) => {
      context?.previousFeeds?.forEach(([key, data]) => queryClient.setQueryData(key, data));
    },
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: [...COMMUNITY_POST_DETAIL_ROOT_KEY, variables.postId],
      });
    },
  });
}

export function useToggleCommunityReaction(authToken: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ToggleCommunityReactionInput) => {
      const token = requireAuthToken(authToken);
      const res = await fetch(appApiUrl('/api/community/reactions'), {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(input),
      });
      return readJson<ToggleCommunityReactionResult>(res, `Community reaction failed with HTTP ${res.status}`);
    },
    onMutate: async ({ targetType, targetId, reaction }) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: COMMUNITY_POSTS_ROOT_KEY }),
        queryClient.cancelQueries({ queryKey: COMMUNITY_POST_DETAIL_ROOT_KEY }),
      ]);
      const previousFeeds = queryClient.getQueriesData<InfiniteFeedData>({ queryKey: COMMUNITY_POSTS_ROOT_KEY });
      const previousDetails = queryClient.getQueriesData<CommunityPostDetail>({ queryKey: COMMUNITY_POST_DETAIL_ROOT_KEY });
      if (targetType === 'post') {
        patchPostEverywhere(queryClient, targetId, (post) => toggleReactionOn(post, reaction));
      } else {
        patchCommentEverywhere(queryClient, targetId, (comment) => toggleReactionOn(comment, reaction));
      }
      return { previousFeeds, previousDetails };
    },
    onError: (_err, _variables, context) => {
      context?.previousFeeds?.forEach(([key, data]) => queryClient.setQueryData(key, data));
      context?.previousDetails?.forEach(([key, data]) => queryClient.setQueryData(key, data));
    },
    // Reconcile to the server's authoritative counts + active flag (no refetch).
    onSuccess: (data, variables) => {
      if (data.targetType === 'post') {
        patchPostEverywhere(queryClient, data.targetId, (post) =>
          reconcileReactionOn(post, variables.reaction, data.active, data.reactions));
      } else {
        patchCommentEverywhere(queryClient, data.targetId, (comment) =>
          reconcileReactionOn(comment, variables.reaction, data.active, data.reactions));
      }
    },
  });
}

export function useCommunityBattleVote(authToken: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateCommunityVoteInput) => {
      const token = requireAuthToken(authToken);
      const res = await fetch(appApiUrl(`/api/community/posts/${encodeURIComponent(input.postId)}/votes`), {
        method: 'POST',
        headers: authHeaders(token),
        // Only forward `reason` when the caller set the field, so the server
        // leaves an existing reason untouched on a plain pick switch.
        body: JSON.stringify(
          'reason' in input ? { choice: input.choice, reason: input.reason ?? null } : { choice: input.choice },
        ),
      });
      return readJson<CreateCommunityVoteResult>(res, `Community vote failed with HTTP ${res.status}`);
    },
    onMutate: async ({ postId, choice, reason }) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: COMMUNITY_POSTS_ROOT_KEY }),
        queryClient.cancelQueries({ queryKey: COMMUNITY_POST_DETAIL_ROOT_KEY }),
      ]);
      const previousFeeds = queryClient.getQueriesData<InfiniteFeedData>({ queryKey: COMMUNITY_POSTS_ROOT_KEY });
      const previousDetails = queryClient.getQueriesData<CommunityPostDetail>({ queryKey: COMMUNITY_POST_DETAIL_ROOT_KEY });
      patchPostEverywhere(queryClient, postId, (post) => applyVoteToPost(post, choice, reason));
      return { previousFeeds, previousDetails };
    },
    onError: (_err, _variables, context) => {
      context?.previousFeeds?.forEach(([key, data]) => queryClient.setQueryData(key, data));
      context?.previousDetails?.forEach(([key, data]) => queryClient.setQueryData(key, data));
    },
    // Reconcile to the server's authoritative tally + the recorded choice/reason.
    onSuccess: (data, variables) => {
      patchPostEverywhere(queryClient, data.postId, (post) => ({
        ...post,
        votes: data.votes,
        viewerVote: data.choice,
        // The server only echoes a reason when the request carried one; otherwise
        // keep whatever reason the post already had.
        viewerVoteReason: 'reason' in variables ? data.reason : post.viewerVoteReason,
      }));
    },
  });
}
