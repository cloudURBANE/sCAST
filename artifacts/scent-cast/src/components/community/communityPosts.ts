import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { normalizeApiBaseUrl } from '@/lib/imageProxy';

export const COMMUNITY_POST_TYPES = ['question', 'sotd', 'battle', 'worth_it'] as const;

export type CommunityPostType = (typeof COMMUNITY_POST_TYPES)[number];
export type CommunityReactionTargetType = 'post' | 'comment';

export interface CommunityAuthor {
  id: string;
  email: string;
  shareId: string;
}

export interface CommunityFragranceSnapshot {
  name: string;
  brand: string;
  imageUrl: string;
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
}

export interface CreateCommunityVoteResult {
  postId: string;
  choice: string;
  votes: Record<string, number>;
}

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env?.VITE_API_BASE_URL as string | undefined);
const COMMUNITY_POSTS_ROOT_KEY = ['community', 'posts'] as const;
const COMMUNITY_POST_DETAIL_ROOT_KEY = ['community', 'post-detail'] as const;

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

export async function fetchCommunityPostsPage(
  filters: CommunityPostFilters,
  cursor?: string | null,
): Promise<CommunityPostsPage> {
  const res = await fetch(postsQueryUrl(filters, cursor), {
    headers: { Accept: 'application/json' },
  });
  return readJson<CommunityPostsPage>(res, `Community feed failed with HTTP ${res.status}`);
}

export async function fetchCommunityPostDetail(postId: string): Promise<CommunityPostDetail> {
  const res = await fetch(appApiUrl(`/api/community/posts/${encodeURIComponent(postId)}`), {
    headers: { Accept: 'application/json' },
  });
  return readJson<CommunityPostDetail>(res, `Community post failed with HTTP ${res.status}`);
}

export function useCommunityPosts(filters: CommunityPostFilters) {
  const normalizedFilters = normalizeFilters(filters);
  return useInfiniteQuery({
    queryKey: [...COMMUNITY_POSTS_ROOT_KEY, normalizedFilters],
    queryFn: ({ pageParam }) => fetchCommunityPostsPage(normalizedFilters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });
}

export function useCommunityPostDetail(postId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...COMMUNITY_POST_DETAIL_ROOT_KEY, postId],
    queryFn: () => fetchCommunityPostDetail(postId),
    enabled,
    staleTime: 15 * 1000,
    refetchOnWindowFocus: false,
  });
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
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: COMMUNITY_POSTS_ROOT_KEY }),
        queryClient.invalidateQueries({ queryKey: [...COMMUNITY_POST_DETAIL_ROOT_KEY, variables.postId] }),
      ]);
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
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: COMMUNITY_POSTS_ROOT_KEY }),
        queryClient.invalidateQueries({ queryKey: COMMUNITY_POST_DETAIL_ROOT_KEY }),
      ]);
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
        body: JSON.stringify({ choice: input.choice }),
      });
      return readJson<CreateCommunityVoteResult>(res, `Community vote failed with HTTP ${res.status}`);
    },
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: COMMUNITY_POSTS_ROOT_KEY }),
        queryClient.invalidateQueries({ queryKey: [...COMMUNITY_POST_DETAIL_ROOT_KEY, variables.postId] }),
      ]);
    },
  });
}
