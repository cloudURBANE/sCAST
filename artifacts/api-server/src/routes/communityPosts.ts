import { Router, type Response } from "express";
import { db } from "@workspace/db";
import {
  communityCommentsTable,
  communityPostFragrancesTable,
  communityPostsTable,
  communityReactionsTable,
  communityTagsTable,
  communityVotesTable,
  userSettingsTable,
  usersTable,
  type CommunityPostType,
  type CommunityReactionTargetType,
} from "@workspace/db/schema";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { AuthRequest, isUndefinedColumnError, optionalAuth, requireAuth } from "../middlewares/auth";
import { getTenantId } from "../middlewares/tenant";
import { shareIdForUser } from "../services/shareIdentity";

const router = Router();

const POST_TYPES = ["question", "sotd", "battle", "worth_it"] as const;
const REACTION_TARGET_TYPES = ["post", "comment"] as const;
const DEFAULT_FEED_LIMIT = 12;
const MAX_FEED_LIMIT = 24;
const MAX_TAGS = 8;
const MAX_FRAGRANCES = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TenantUser = {
  id: string;
  email: string;
  pictureUrl: string | null;
};

type PostRow = {
  id: string;
  tenantId: string;
  userId: string;
  postType: CommunityPostType;
  title: string | null;
  body: string;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  authorEmail: string;
  authorPictureUrl: string | null;
};

type CommentRow = {
  id: string;
  tenantId: string;
  postId: string;
  parentCommentId: string | null;
  userId: string;
  body: string;
  createdAt: Date;
  authorEmail: string;
  authorPictureUrl: string | null;
};

type FragranceSnapshot = {
  name: string;
  brand: string;
  imageUrl?: string;
  family?: string;
};

type CursorToken = {
  createdAt: Date;
  id: string;
};

function sendBadRequest(res: Response, error: string) {
  res.status(400).json({ error });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstQueryString(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.trim() : undefined;
}

function routeParam(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw : undefined;
}

function parseLimit(value: unknown): number {
  const raw = firstQueryString(value);
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_FEED_LIMIT;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FEED_LIMIT;
  return Math.min(MAX_FEED_LIMIT, parsed);
}

function cleanOptionalText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function cleanRequiredText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function isPostType(value: unknown): value is CommunityPostType {
  return typeof value === "string" && POST_TYPES.includes(value as CommunityPostType);
}

function isReactionTargetType(value: unknown): value is CommunityReactionTargetType {
  return (
    typeof value === "string" &&
    REACTION_TARGET_TYPES.includes(value as CommunityReactionTargetType)
  );
}

function parseCursor(raw: unknown): CursorToken | null | "invalid" {
  const token = firstQueryString(raw);
  if (!token) return null;

  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") return "invalid";
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime()) || !UUID_RE.test(parsed.id)) return "invalid";
    return { createdAt, id: parsed.id };
  } catch {
    return "invalid";
  }
}

function encodeCursor(post: PostRow): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: post.createdAt.toISOString(),
      id: post.id,
    }),
    "utf8",
  ).toString("base64url");
}

function normalizeTags(raw: unknown): { tags: string[] } | { error: string } {
  if (raw === undefined || raw === null) return { tags: [] };
  if (!Array.isArray(raw)) return { error: "tags must be an array" };

  const tags: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") return { error: "tags must contain only strings" };
    const tag = value
      .trim()
      .toLowerCase()
      .replace(/^#+/, "")
      .replace(/\s+/g, "-");
    if (!tag) continue;
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(tag)) {
      return { error: "tags may contain lowercase letters, numbers, and hyphens only" };
    }
    if (!tags.includes(tag)) tags.push(tag);
    if (tags.length > MAX_TAGS) return { error: `tags may include at most ${MAX_TAGS} entries` };
  }

  return { tags };
}

function isAllowedCatalogImageUrl(value: string): boolean {
  if (value.startsWith("/api/image-objects/")) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeFragrances(raw: unknown): { fragrances: FragranceSnapshot[] } | { error: string } {
  if (raw === undefined || raw === null) return { fragrances: [] };
  if (!Array.isArray(raw)) return { error: "fragrances must be an array" };
  if (raw.length > MAX_FRAGRANCES) {
    return { error: `fragrances may include at most ${MAX_FRAGRANCES} catalog snapshots` };
  }

  const fragrances: FragranceSnapshot[] = [];
  for (const value of raw) {
    if (!isPlainObject(value)) return { error: "fragrances must contain catalog snapshot objects" };
    const name = cleanRequiredText(value.name, 120);
    const brand = cleanRequiredText(value.brand, 120);
    const imageUrl = cleanOptionalText(value.imageUrl, 500);
    const family = cleanOptionalText(value.family, 80);

    if (!name || !brand) {
      return { error: "each fragrance requires name and brand" };
    }
    if (imageUrl && !isAllowedCatalogImageUrl(imageUrl)) {
      return { error: "fragrance imageUrl must be an existing http(s) or image-object URL" };
    }

    fragrances.push({
      name,
      brand,
      ...(imageUrl ? { imageUrl } : {}),
      ...(family ? { family } : {}),
    });
  }

  return { fragrances };
}

function cleanStringFromObject(source: Record<string, unknown>, key: string, maxLength: number) {
  return cleanOptionalText(source[key], maxLength);
}

function normalizeMetadata(
  postType: CommunityPostType,
  raw: unknown,
): { metadata: Record<string, unknown> } | { error: string } {
  const source = isPlainObject(raw) ? raw : {};

  if (postType === "question") return { metadata: {} };

  if (postType === "sotd") {
    const metadata: Record<string, unknown> = {};
    for (const key of ["weather", "occasion", "mood"]) {
      const value = cleanStringFromObject(source, key, 80);
      if (value) metadata[key] = value;
    }
    return { metadata };
  }

  if (postType === "battle") {
    const options = source.options;
    if (!Array.isArray(options) || options.length !== 2) {
      return { error: "battle metadata requires exactly two options" };
    }
    const cleanOptions = options.map((option) => cleanRequiredText(option, 80));
    if (cleanOptions.some((option) => !option)) {
      return { error: "battle options must be non-empty strings under 80 characters" };
    }
    return { metadata: { options: cleanOptions } };
  }

  const priceContext =
    cleanStringFromObject(source, "price_context", 120) ??
    cleanStringFromObject(source, "priceContext", 120);
  return { metadata: priceContext ? { price_context: priceContext } : {} };
}

function reactionCountsFromRows(rows: Array<{ targetId: string; reaction: string; count: number }>) {
  const map = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const counts = map.get(row.targetId) ?? {};
    counts[row.reaction] = Number(row.count) || 0;
    map.set(row.targetId, counts);
  }
  return map;
}

function voteTalliesFromRows(rows: Array<{ postId: string; choice: string; count: number }>) {
  const map = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const tally = map.get(row.postId) ?? {};
    tally[row.choice] = Number(row.count) || 0;
    map.set(row.postId, tally);
  }
  return map;
}

async function tenantUsersById(tenantId: string) {
  const users = await db
    .select({ id: usersTable.id, email: usersTable.email, pictureUrl: usersTable.pictureUrl })
    .from(usersTable)
    .where(eq(usersTable.tenantId, tenantId));
  return {
    users,
    byId: new Map(users.map((user) => [user.id, user])),
  };
}

function authorDto(user: TenantUser, tenantUsers: TenantUser[], username?: string | null) {
  return {
    id: user.id,
    email: user.email,
    shareId: shareIdForUser(user, tenantUsers),
    ...(user.pictureUrl ? { pictureUrl: user.pictureUrl } : {}),
    ...(username ? { username } : {}),
  };
}

/**
 * Map of userId → chosen public username for the given members. Read from
 * `user_settings` in one indexed lookup. Tolerant of the `username` column not
 * yet existing in the live DB (migration lag): on a 42703 it degrades to an
 * empty map so the feed renders fallback aliases instead of 500ing — mirroring
 * the auth-layer fallback. Authors who never set a username are simply absent.
 */
async function usernamesByUserId(tenantId: string, userIds: string[]): Promise<Map<string, string>> {
  const byUserId = new Map<string, string>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return byUserId;
  try {
    const rows = await db
      .select({ userId: userSettingsTable.userId, username: userSettingsTable.username })
      .from(userSettingsTable)
      .where(and(eq(userSettingsTable.tenantId, tenantId), inArray(userSettingsTable.userId, ids)));
    for (const row of rows) {
      const trimmed = row.username?.trim();
      if (trimmed) byUserId.set(row.userId, trimmed);
    }
  } catch (err) {
    if (!isUndefinedColumnError(err)) throw err;
    // username column not yet migrated — fall back to non-identifying aliases.
  }
  return byUserId;
}

/**
 * Which of `targetIds` the viewer has reacted to (and with which reaction tokens).
 * One indexed `inArray` lookup against the unique (userId,targetType,targetId,reaction)
 * shape — no N+1. Returns an empty map for anonymous callers.
 */
async function viewerReactionState(
  tenantId: string,
  targetType: CommunityReactionTargetType,
  targetIds: string[],
  viewerId?: string,
): Promise<{ reactionsByTarget: Map<string, string[]> }> {
  const reactionsByTarget = new Map<string, string[]>();
  if (!viewerId || targetIds.length === 0) return { reactionsByTarget };

  const rows = await db
    .select({
      targetId: communityReactionsTable.targetId,
      reaction: communityReactionsTable.reaction,
    })
    .from(communityReactionsTable)
    .where(and(
      eq(communityReactionsTable.tenantId, tenantId),
      eq(communityReactionsTable.userId, viewerId),
      eq(communityReactionsTable.targetType, targetType),
      inArray(communityReactionsTable.targetId, targetIds),
    ));

  for (const row of rows) {
    const reactions = reactionsByTarget.get(row.targetId) ?? [];
    reactions.push(row.reaction);
    reactionsByTarget.set(row.targetId, reactions);
  }
  return { reactionsByTarget };
}

/** Viewer's own reactions + battle vote across a set of posts (anonymous → empty). */
async function viewerPostState(
  tenantId: string,
  postIds: string[],
  viewerId?: string,
): Promise<{ reactionsByTarget: Map<string, string[]>; voteByPost: Map<string, string> }> {
  const voteByPost = new Map<string, string>();
  if (!viewerId || postIds.length === 0) {
    return { reactionsByTarget: new Map(), voteByPost };
  }

  const [{ reactionsByTarget }, voteRows] = await Promise.all([
    viewerReactionState(tenantId, "post", postIds, viewerId),
    db
      .select({
        postId: communityVotesTable.postId,
        choice: communityVotesTable.choice,
      })
      .from(communityVotesTable)
      .where(and(
        eq(communityVotesTable.tenantId, tenantId),
        eq(communityVotesTable.userId, viewerId),
        inArray(communityVotesTable.postId, postIds),
      )),
  ]);

  for (const row of voteRows) voteByPost.set(row.postId, row.choice);
  return { reactionsByTarget, voteByPost };
}

async function buildPostDtos(tenantId: string, posts: PostRow[], viewerId?: string) {
  if (posts.length === 0) return [];

  const postIds = posts.map((post) => post.id);
  const [
    tenantUsersResult,
    tagRows,
    fragranceRows,
    commentCountRows,
    reactionCountRows,
    voteTallyRows,
  ] = await Promise.all([
    tenantUsersById(tenantId),
    db
      .select({
        postId: communityTagsTable.postId,
        tag: communityTagsTable.tag,
      })
      .from(communityTagsTable)
      .where(and(eq(communityTagsTable.tenantId, tenantId), inArray(communityTagsTable.postId, postIds)))
      .orderBy(asc(communityTagsTable.tag)),
    db
      .select({
        postId: communityPostFragrancesTable.postId,
        fragrance: communityPostFragrancesTable.fragrance,
        position: communityPostFragrancesTable.position,
      })
      .from(communityPostFragrancesTable)
      .where(and(
        eq(communityPostFragrancesTable.tenantId, tenantId),
        inArray(communityPostFragrancesTable.postId, postIds),
      ))
      .orderBy(asc(communityPostFragrancesTable.position)),
    db
      .select({
        postId: communityCommentsTable.postId,
        count: sql<number>`count(*)::int`,
      })
      .from(communityCommentsTable)
      .where(and(eq(communityCommentsTable.tenantId, tenantId), inArray(communityCommentsTable.postId, postIds)))
      .groupBy(communityCommentsTable.postId),
    db
      .select({
        targetId: communityReactionsTable.targetId,
        reaction: communityReactionsTable.reaction,
        count: sql<number>`count(*)::int`,
      })
      .from(communityReactionsTable)
      .where(and(
        eq(communityReactionsTable.tenantId, tenantId),
        eq(communityReactionsTable.targetType, "post"),
        inArray(communityReactionsTable.targetId, postIds),
      ))
      .groupBy(communityReactionsTable.targetId, communityReactionsTable.reaction),
    db
      .select({
        postId: communityVotesTable.postId,
        choice: communityVotesTable.choice,
        count: sql<number>`count(*)::int`,
      })
      .from(communityVotesTable)
      .where(and(eq(communityVotesTable.tenantId, tenantId), inArray(communityVotesTable.postId, postIds)))
      .groupBy(communityVotesTable.postId, communityVotesTable.choice),
  ]);

  const tagsByPost = new Map<string, string[]>();
  for (const row of tagRows) {
    const tags = tagsByPost.get(row.postId) ?? [];
    tags.push(row.tag);
    tagsByPost.set(row.postId, tags);
  }

  const fragrancesByPost = new Map<string, FragranceSnapshot[]>();
  for (const row of fragranceRows) {
    const fragrances = fragrancesByPost.get(row.postId) ?? [];
    fragrances.push(row.fragrance as FragranceSnapshot);
    fragrancesByPost.set(row.postId, fragrances);
  }

  const commentCounts = new Map(commentCountRows.map((row) => [row.postId, Number(row.count) || 0]));
  const reactionCounts = reactionCountsFromRows(reactionCountRows);
  const voteTallies = voteTalliesFromRows(voteTallyRows);
  const tenantUsers = tenantUsersResult.users;
  const usersById = tenantUsersResult.byId;
  const [{ reactionsByTarget: viewerReactionsByPost, voteByPost: viewerVoteByPost }, usernames] =
    await Promise.all([
      viewerPostState(tenantId, postIds, viewerId),
      usernamesByUserId(tenantId, posts.map((post) => post.userId)),
    ]);

  return posts.map((post) => {
    const fallbackAuthor = { id: post.userId, email: post.authorEmail, pictureUrl: post.authorPictureUrl };
    const author = usersById.get(post.userId) ?? fallbackAuthor;
    const shareUsers = usersById.has(post.userId) ? tenantUsers : [...tenantUsers, fallbackAuthor];

    return {
      id: post.id,
      postType: post.postType,
      title: post.title,
      body: post.body,
      metadata: post.metadata ?? {},
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      author: authorDto(author, shareUsers, usernames.get(post.userId)),
      tags: tagsByPost.get(post.id) ?? [],
      fragrances: fragrancesByPost.get(post.id) ?? [],
      counts: {
        comments: commentCounts.get(post.id) ?? 0,
        reactions: reactionCounts.get(post.id) ?? {},
      },
      votes: voteTallies.get(post.id) ?? {},
      viewerReactions: viewerReactionsByPost.get(post.id) ?? [],
      viewerVote: viewerVoteByPost.get(post.id) ?? null,
    };
  });
}

async function buildCommentDtos(tenantId: string, comments: CommentRow[], viewerId?: string) {
  if (comments.length === 0) return [];

  const commentIds = comments.map((comment) => comment.id);
  const [tenantUsersResult, reactionCountRows] = await Promise.all([
    tenantUsersById(tenantId),
    db
      .select({
        targetId: communityReactionsTable.targetId,
        reaction: communityReactionsTable.reaction,
        count: sql<number>`count(*)::int`,
      })
      .from(communityReactionsTable)
      .where(and(
        eq(communityReactionsTable.tenantId, tenantId),
        eq(communityReactionsTable.targetType, "comment"),
        inArray(communityReactionsTable.targetId, commentIds),
      ))
      .groupBy(communityReactionsTable.targetId, communityReactionsTable.reaction),
  ]);

  const reactionCounts = reactionCountsFromRows(reactionCountRows);
  const tenantUsers = tenantUsersResult.users;
  const usersById = tenantUsersResult.byId;
  const [{ reactionsByTarget: viewerReactionsByComment }, usernames] = await Promise.all([
    viewerReactionState(tenantId, "comment", commentIds, viewerId),
    usernamesByUserId(tenantId, comments.map((comment) => comment.userId)),
  ]);

  return comments.map((comment) => {
    const fallbackAuthor = { id: comment.userId, email: comment.authorEmail, pictureUrl: comment.authorPictureUrl };
    const author = usersById.get(comment.userId) ?? fallbackAuthor;
    const shareUsers = usersById.has(comment.userId) ? tenantUsers : [...tenantUsers, fallbackAuthor];

    return {
      id: comment.id,
      postId: comment.postId,
      parentCommentId: comment.parentCommentId,
      body: comment.body,
      createdAt: comment.createdAt,
      author: authorDto(author, shareUsers, usernames.get(comment.userId)),
      counts: {
        reactions: reactionCounts.get(comment.id) ?? {},
      },
      viewerReactions: viewerReactionsByComment.get(comment.id) ?? [],
    };
  });
}

async function fetchPostRowById(tenantId: string, postId: string): Promise<PostRow | null> {
  const rows = await db
    .select({
      id: communityPostsTable.id,
      tenantId: communityPostsTable.tenantId,
      userId: communityPostsTable.userId,
      postType: communityPostsTable.postType,
      title: communityPostsTable.title,
      body: communityPostsTable.body,
      metadata: communityPostsTable.metadata,
      createdAt: communityPostsTable.createdAt,
      updatedAt: communityPostsTable.updatedAt,
      authorEmail: usersTable.email,
      authorPictureUrl: usersTable.pictureUrl,
    })
    .from(communityPostsTable)
    .innerJoin(
      usersTable,
      and(eq(communityPostsTable.userId, usersTable.id), eq(usersTable.tenantId, tenantId)),
    )
    .where(and(eq(communityPostsTable.tenantId, tenantId), eq(communityPostsTable.id, postId)))
    .limit(1);
  return rows[0] ?? null;
}

async function voteTallyForPost(tenantId: string, postId: string) {
  const rows = await db
    .select({
      postId: communityVotesTable.postId,
      choice: communityVotesTable.choice,
      count: sql<number>`count(*)::int`,
    })
    .from(communityVotesTable)
    .where(and(eq(communityVotesTable.tenantId, tenantId), eq(communityVotesTable.postId, postId)))
    .groupBy(communityVotesTable.postId, communityVotesTable.choice);

  return voteTalliesFromRows(rows).get(postId) ?? {};
}

async function reactionCountsForTarget(
  tenantId: string,
  targetType: CommunityReactionTargetType,
  targetId: string,
) {
  const rows = await db
    .select({
      targetId: communityReactionsTable.targetId,
      reaction: communityReactionsTable.reaction,
      count: sql<number>`count(*)::int`,
    })
    .from(communityReactionsTable)
    .where(and(
      eq(communityReactionsTable.tenantId, tenantId),
      eq(communityReactionsTable.targetType, targetType),
      eq(communityReactionsTable.targetId, targetId),
    ))
    .groupBy(communityReactionsTable.targetId, communityReactionsTable.reaction);

  return reactionCountsFromRows(rows).get(targetId) ?? {};
}

router.get("/community/posts", optionalAuth, async (req: AuthRequest, res, next) => {
  try {
    const tenantId = getTenantId(req);
    const limit = parseLimit(req.query.limit);
    const cursor = parseCursor(req.query.cursor);
    if (cursor === "invalid") {
      sendBadRequest(res, "cursor is invalid");
      return;
    }

    const type = firstQueryString(req.query.type);
    if (type && !isPostType(type)) {
      sendBadRequest(res, "type must be one of question, sotd, battle, worth_it");
      return;
    }
    const postType: CommunityPostType | undefined = type ? (type as CommunityPostType) : undefined;

    const tag = firstQueryString(req.query.tag)
      ?.toLowerCase()
      .replace(/^#+/, "")
      .replace(/\s+/g, "-");
    if (tag && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(tag)) {
      sendBadRequest(res, "tag is invalid");
      return;
    }

    const q = firstQueryString(req.query.q);
    if (q && q.length > 120) {
      sendBadRequest(res, "q must be 120 characters or less");
      return;
    }

    const conditions = [eq(communityPostsTable.tenantId, tenantId)];
    if (postType) conditions.push(eq(communityPostsTable.postType, postType));
    if (cursor) {
      conditions.push(
        or(
          lt(communityPostsTable.createdAt, cursor.createdAt),
          and(eq(communityPostsTable.createdAt, cursor.createdAt), lt(communityPostsTable.id, cursor.id)),
        )!,
      );
    }
    if (q) {
      const pattern = `%${q}%`;
      // Match what the search box promises ("rooms, fragrances, tags, or notes"):
      // title/body plus tenant-scoped EXISTS over the post's tags and the
      // catalog-fragrance snapshot's name/brand (jsonb). Parameterized throughout.
      conditions.push(
        or(
          sql`${communityPostsTable.title} ILIKE ${pattern}`,
          sql`${communityPostsTable.body} ILIKE ${pattern}`,
          sql`exists (
            select 1 from ${communityTagsTable}
            where ${communityTagsTable.tenantId} = ${tenantId}
              and ${communityTagsTable.postId} = ${communityPostsTable.id}
              and ${communityTagsTable.tag} ILIKE ${pattern}
          )`,
          sql`exists (
            select 1 from ${communityPostFragrancesTable}
            where ${communityPostFragrancesTable.tenantId} = ${tenantId}
              and ${communityPostFragrancesTable.postId} = ${communityPostsTable.id}
              and (
                ${communityPostFragrancesTable.fragrance}->>'name' ILIKE ${pattern}
                or ${communityPostFragrancesTable.fragrance}->>'brand' ILIKE ${pattern}
              )
          )`,
        )!,
      );
    }
    if (tag) {
      conditions.push(sql`exists (
        select 1 from ${communityTagsTable}
        where ${communityTagsTable.tenantId} = ${tenantId}
          and ${communityTagsTable.postId} = ${communityPostsTable.id}
          and ${communityTagsTable.tag} = ${tag}
      )`);
    }

    const rows = await db
      .select({
        id: communityPostsTable.id,
        tenantId: communityPostsTable.tenantId,
        userId: communityPostsTable.userId,
        postType: communityPostsTable.postType,
        title: communityPostsTable.title,
        body: communityPostsTable.body,
        metadata: communityPostsTable.metadata,
        createdAt: communityPostsTable.createdAt,
        updatedAt: communityPostsTable.updatedAt,
        authorEmail: usersTable.email,
        authorPictureUrl: usersTable.pictureUrl,
      })
      .from(communityPostsTable)
      .innerJoin(
        usersTable,
        and(eq(communityPostsTable.userId, usersTable.id), eq(usersTable.tenantId, tenantId)),
      )
      .where(and(...conditions))
      .orderBy(desc(communityPostsTable.createdAt), desc(communityPostsTable.id))
      .limit(limit + 1);

    const pageRows = rows.slice(0, limit);
    const posts = await buildPostDtos(tenantId, pageRows, req.user?.id);
    const last = pageRows[pageRows.length - 1] ?? null;

    res.json({
      posts,
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/community/posts/:id", optionalAuth, async (req: AuthRequest, res, next) => {
  try {
    const tenantId = getTenantId(req);
    const postId = routeParam(req.params.id);
    if (!postId || !UUID_RE.test(postId)) {
      sendBadRequest(res, "post id must be a UUID");
      return;
    }

    const postRow = await fetchPostRowById(tenantId, postId);
    if (!postRow) {
      res.status(404).json({ error: "Post not found" });
      return;
    }

    const commentRows = await db
      .select({
        id: communityCommentsTable.id,
        tenantId: communityCommentsTable.tenantId,
        postId: communityCommentsTable.postId,
        parentCommentId: communityCommentsTable.parentCommentId,
        userId: communityCommentsTable.userId,
        body: communityCommentsTable.body,
        createdAt: communityCommentsTable.createdAt,
        authorEmail: usersTable.email,
        authorPictureUrl: usersTable.pictureUrl,
      })
      .from(communityCommentsTable)
      .innerJoin(
        usersTable,
        and(eq(communityCommentsTable.userId, usersTable.id), eq(usersTable.tenantId, tenantId)),
      )
      .where(and(eq(communityCommentsTable.tenantId, tenantId), eq(communityCommentsTable.postId, postId)))
      .orderBy(asc(communityCommentsTable.createdAt));

    const viewerId = req.user?.id;
    const [post] = await buildPostDtos(tenantId, [postRow], viewerId);
    const comments = await buildCommentDtos(tenantId, commentRows, viewerId);

    res.json({ post, comments });
  } catch (err) {
    next(err);
  }
});

router.post("/community/posts", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const tenantId = getTenantId(req);
    const user = req.user!;
    const body = isPlainObject(req.body) ? req.body : {};

    const postType = body.type ?? body.postType;
    if (!isPostType(postType)) {
      sendBadRequest(res, "type must be one of question, sotd, battle, worth_it");
      return;
    }

    const postBody = cleanRequiredText(body.body, 4000);
    if (!postBody) {
      sendBadRequest(res, "body is required and must be 4000 characters or less");
      return;
    }

    const title = cleanOptionalText(body.title, 140);
    const metadataResult = normalizeMetadata(postType, body.metadata);
    if ("error" in metadataResult) {
      sendBadRequest(res, metadataResult.error);
      return;
    }

    const tagsResult = normalizeTags(body.tags);
    if ("error" in tagsResult) {
      sendBadRequest(res, tagsResult.error);
      return;
    }

    const fragranceResult = normalizeFragrances(body.fragrances);
    if ("error" in fragranceResult) {
      sendBadRequest(res, fragranceResult.error);
      return;
    }

    const inserted = await db.transaction(async (tx) => {
      const [post] = await tx
        .insert(communityPostsTable)
        .values({
          tenantId,
          userId: user.id,
          postType,
          title,
          body: postBody,
          metadata: metadataResult.metadata,
        })
        .returning();
      if (!post) throw new Error("Failed to create community post");

      if (tagsResult.tags.length > 0) {
        await tx.insert(communityTagsTable).values(
          tagsResult.tags.map((tag) => ({
            tenantId,
            postId: post.id,
            tag,
          })),
        );
      }

      if (fragranceResult.fragrances.length > 0) {
        await tx.insert(communityPostFragrancesTable).values(
          fragranceResult.fragrances.map((fragrance, position) => ({
            tenantId,
            postId: post.id,
            fragrance,
            position,
          })),
        );
      }

      return post;
    });

    const [post] = await buildPostDtos(tenantId, [{ ...inserted, authorEmail: user.email, authorPictureUrl: user.pictureUrl }]);
    res.status(201).json({ post });
  } catch (err) {
    next(err);
  }
});

router.post("/community/posts/:id/comments", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const tenantId = getTenantId(req);
    const user = req.user!;
    const postId = routeParam(req.params.id);
    if (!postId || !UUID_RE.test(postId)) {
      sendBadRequest(res, "post id must be a UUID");
      return;
    }

    const body = isPlainObject(req.body) ? req.body : {};
    const commentBody = cleanRequiredText(body.body, 2000);
    if (!commentBody) {
      sendBadRequest(res, "body is required and must be 2000 characters or less");
      return;
    }

    const postRow = await fetchPostRowById(tenantId, postId);
    if (!postRow) {
      res.status(404).json({ error: "Post not found" });
      return;
    }

    const [inserted] = await db
      .insert(communityCommentsTable)
      .values({
        tenantId,
        postId,
        userId: user.id,
        body: commentBody,
      })
      .returning();
    if (!inserted) throw new Error("Failed to create community comment");

    const [comment] = await buildCommentDtos(tenantId, [{ ...inserted, authorEmail: user.email, authorPictureUrl: user.pictureUrl }]);
    res.status(201).json({ comment });
  } catch (err) {
    next(err);
  }
});

router.post("/community/reactions", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const tenantId = getTenantId(req);
    const user = req.user!;
    const body = isPlainObject(req.body) ? req.body : {};
    const { targetType, targetId } = body;
    const reaction = cleanRequiredText(body.reaction, 24);

    if (!isReactionTargetType(targetType)) {
      sendBadRequest(res, "targetType must be post or comment");
      return;
    }
    if (typeof targetId !== "string" || !UUID_RE.test(targetId)) {
      sendBadRequest(res, "targetId must be a UUID");
      return;
    }
    if (!reaction || !/^[a-z0-9_-]{1,24}$/i.test(reaction)) {
      sendBadRequest(res, "reaction must be a short alphanumeric token");
      return;
    }

    const targetRows =
      targetType === "post"
        ? await db
            .select({ id: communityPostsTable.id })
            .from(communityPostsTable)
            .where(and(eq(communityPostsTable.tenantId, tenantId), eq(communityPostsTable.id, targetId)))
            .limit(1)
        : await db
            .select({ id: communityCommentsTable.id })
            .from(communityCommentsTable)
            .where(and(eq(communityCommentsTable.tenantId, tenantId), eq(communityCommentsTable.id, targetId)))
            .limit(1);
    if (!targetRows[0]) {
      res.status(404).json({ error: "Reaction target not found" });
      return;
    }

    const existing = await db
      .select({ id: communityReactionsTable.id })
      .from(communityReactionsTable)
      .where(and(
        eq(communityReactionsTable.tenantId, tenantId),
        eq(communityReactionsTable.userId, user.id),
        eq(communityReactionsTable.targetType, targetType),
        eq(communityReactionsTable.targetId, targetId),
        eq(communityReactionsTable.reaction, reaction),
      ))
      .limit(1);

    let active = true;
    if (existing[0]) {
      await db
        .delete(communityReactionsTable)
        .where(and(
          eq(communityReactionsTable.tenantId, tenantId),
          eq(communityReactionsTable.id, existing[0].id),
          eq(communityReactionsTable.userId, user.id),
        ));
      active = false;
    } else {
      await db.insert(communityReactionsTable).values({
        tenantId,
        targetType,
        targetId,
        userId: user.id,
        reaction,
      });
    }

    const reactions = await reactionCountsForTarget(tenantId, targetType, targetId);
    res.json({ active, targetType, targetId, reactions });
  } catch (err) {
    next(err);
  }
});

router.post("/community/posts/:id/votes", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const tenantId = getTenantId(req);
    const user = req.user!;
    const postId = routeParam(req.params.id);
    if (!postId || !UUID_RE.test(postId)) {
      sendBadRequest(res, "post id must be a UUID");
      return;
    }

    const body = isPlainObject(req.body) ? req.body : {};
    const choice = cleanRequiredText(body.choice, 80);
    if (!choice) {
      sendBadRequest(res, "choice is required");
      return;
    }

    const rows = await db
      .select({
        id: communityPostsTable.id,
        postType: communityPostsTable.postType,
        metadata: communityPostsTable.metadata,
      })
      .from(communityPostsTable)
      .where(and(eq(communityPostsTable.tenantId, tenantId), eq(communityPostsTable.id, postId)))
      .limit(1);
    const post = rows[0];
    if (!post) {
      res.status(404).json({ error: "Post not found" });
      return;
    }
    if (post.postType !== "battle") {
      sendBadRequest(res, "votes are only available for battle posts");
      return;
    }

    const metadata = isPlainObject(post.metadata) ? post.metadata : {};
    const rawOptions = Array.isArray(metadata.options) ? metadata.options : [];
    const options = rawOptions.map((option: unknown) =>
      typeof option === "string" ? option.trim() : "",
    );
    if (options.length !== 2 || options.some((option) => !option)) {
      sendBadRequest(res, "battle metadata requires exactly two valid options");
      return;
    }
    if (!options.includes(choice)) {
      sendBadRequest(res, "choice must match one of the battle options");
      return;
    }

    await db
      .insert(communityVotesTable)
      .values({
        tenantId,
        postId,
        userId: user.id,
        choice,
      })
      .onConflictDoUpdate({
        target: [communityVotesTable.userId, communityVotesTable.postId],
        set: {
          tenantId,
          choice,
          updatedAt: new Date(),
        },
      });

    const votes = await voteTallyForPost(tenantId, postId);
    res.json({ postId, choice, votes });
  } catch (err) {
    next(err);
  }
});

export default router;
