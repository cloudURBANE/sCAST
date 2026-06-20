import { Router, type Response } from "express";
import { db } from "@workspace/db";
import {
  arenaBeamGrantsTable,
  arenaCrowdPredictionsTable,
  arenaCrowdStatsTable,
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
import { sendCategoryPushToUser } from "../services/pushService";
import {
  CROWD_READ_DAILY_TARGET,
  crowdReadAccuracy,
  crowdReadOutcome,
  isCrowdReadEligible,
  isStreakContinuable,
  nextStreak,
  resolveCrowdLeader,
} from "../services/crowdReadCore";
import { cleanArenaBeamRunId, resolveArenaBeamFragranceId, scoreArenaBeamRun } from "../services/arenaBeamPowerCore";
import { logger } from "../lib/logger";

const router = Router();

const POST_TYPES = ["question", "sotd", "battle", "worth_it"] as const;
const REACTION_TARGET_TYPES = ["post", "comment"] as const;
const DEFAULT_FEED_LIMIT = 12;
const MAX_FEED_LIMIT = 24;
const MAX_TAGS = 8;
const MAX_FRAGRANCES = 3;
const MAX_BATTLE_OPTION_LENGTH = 120;
const MAX_REASON_LENGTH = 40;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isMissingCrowdTableError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if ((current as { code?: unknown }).code === "42P01") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

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
  fragranceId?: string;
  beamSupporters?: number;
  totalBeamPower?: number;
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
    const fragranceId = cleanOptionalText(value.fragranceId, 240);

    if (!name || !brand) {
      return { error: "each fragrance requires name and brand" };
    }
    if (imageUrl && !isAllowedCatalogImageUrl(imageUrl)) {
      return { error: "fragrance imageUrl must be an existing http(s) or image-object URL" };
    }

    fragrances.push({
      ...(fragranceId && /^[a-zA-Z0-9._~:@/+-]+$/.test(fragranceId) ? { fragranceId } : {}),
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
    const cleanOptions = options.map((option) => cleanRequiredText(option, MAX_BATTLE_OPTION_LENGTH));
    if (cleanOptions.some((option) => !option)) {
      return { error: `battle options must be non-empty strings under ${MAX_BATTLE_OPTION_LENGTH} characters` };
    }
    const normalizedOptions = cleanOptions.map((option) => option!.toLowerCase());
    if (new Set(normalizedOptions).size !== cleanOptions.length) {
      return { error: "battle options must be distinct" };
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
): Promise<{
  reactionsByTarget: Map<string, string[]>;
  voteByPost: Map<string, string>;
  voteReasonByPost: Map<string, string>;
}> {
  const voteByPost = new Map<string, string>();
  const voteReasonByPost = new Map<string, string>();
  if (!viewerId || postIds.length === 0) {
    return { reactionsByTarget: new Map(), voteByPost, voteReasonByPost };
  }

  const [{ reactionsByTarget }, voteRows] = await Promise.all([
    viewerReactionState(tenantId, "post", postIds, viewerId),
    db
      .select({
        postId: communityVotesTable.postId,
        choice: communityVotesTable.choice,
        reason: communityVotesTable.reason,
      })
      .from(communityVotesTable)
      .where(and(
        eq(communityVotesTable.tenantId, tenantId),
        eq(communityVotesTable.userId, viewerId),
        inArray(communityVotesTable.postId, postIds),
      )),
  ]);

  for (const row of voteRows) {
    voteByPost.set(row.postId, row.choice);
    if (typeof row.reason === "string" && row.reason) voteReasonByPost.set(row.postId, row.reason);
  }
  return { reactionsByTarget, voteByPost, voteReasonByPost };
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

  const fragranceIds = [...new Set(fragranceRows.flatMap((row) => {
    const snapshot = row.fragrance as FragranceSnapshot;
    const fragranceId = resolveArenaBeamFragranceId(snapshot);
    return fragranceId ? [fragranceId] : [];
  }))];
  let beamRows: Array<{ fragranceId: string; supporters: number; totalBeamPower: number }> = [];
  try {
    beamRows = fragranceIds.length > 0
      ? await db
        .select({
          fragranceId: arenaBeamGrantsTable.fragranceId,
          supporters: sql<number>`count(distinct ${arenaBeamGrantsTable.userId})::int`,
          totalBeamPower: sql<number>`coalesce(sum(${arenaBeamGrantsTable.beamPower}), 0)::int`,
        })
        .from(arenaBeamGrantsTable)
        .where(and(
          eq(arenaBeamGrantsTable.tenantId, tenantId),
          inArray(arenaBeamGrantsTable.fragranceId, fragranceIds),
        ))
        .groupBy(arenaBeamGrantsTable.fragranceId)
      : [];
  } catch (error) {
    if (!isMissingCrowdTableError(error)) throw error;
    logger.warn("arena_beam_grants is unavailable; community Beam totals default to zero");
  }
  const beamByFragrance = new Map(beamRows.map((row) => [row.fragranceId, {
    beamSupporters: Number(row.supporters) || 0,
    totalBeamPower: Number(row.totalBeamPower) || 0,
  }]));

  const fragrancesByPost = new Map<string, FragranceSnapshot[]>();
  for (const row of fragranceRows) {
    const fragrances = fragrancesByPost.get(row.postId) ?? [];
    const snapshot = row.fragrance as FragranceSnapshot;
    const fragranceId = resolveArenaBeamFragranceId(snapshot) ?? undefined;
    const beam = fragranceId ? beamByFragrance.get(fragranceId) : undefined;
    fragrances.push({
      ...snapshot,
      ...(fragranceId ? { fragranceId } : {}),
      beamSupporters: beam?.beamSupporters ?? 0,
      totalBeamPower: beam?.totalBeamPower ?? 0,
    });
    fragrancesByPost.set(row.postId, fragrances);
  }

  const commentCounts = new Map(commentCountRows.map((row) => [row.postId, Number(row.count) || 0]));
  const reactionCounts = reactionCountsFromRows(reactionCountRows);
  const voteTallies = voteTalliesFromRows(voteTallyRows);
  const tenantUsers = tenantUsersResult.users;
  const usersById = tenantUsersResult.byId;
  const [
    { reactionsByTarget: viewerReactionsByPost, voteByPost: viewerVoteByPost, voteReasonByPost: viewerVoteReasonByPost },
    usernames,
  ] = await Promise.all([
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
      viewerVoteReason: viewerVoteReasonByPost.get(post.id) ?? null,
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

async function beamTotalsForFragrance(tenantId: string, fragranceId: string) {
  const [row] = await db
    .select({
      supporters: sql<number>`count(distinct ${arenaBeamGrantsTable.userId})::int`,
      totalBeamPower: sql<number>`coalesce(sum(${arenaBeamGrantsTable.beamPower}), 0)::int`,
    })
    .from(arenaBeamGrantsTable)
    .where(and(
      eq(arenaBeamGrantsTable.tenantId, tenantId),
      eq(arenaBeamGrantsTable.fragranceId, fragranceId),
    ));

  return {
    supporters: Number(row?.supporters) || 0,
    totalBeamPower: Number(row?.totalBeamPower) || 0,
  };
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

    // Arena "Crowd vs You" blind playable mode. Only engages for battle posts
    // with playable=1; everything else falls through to the normal feed below
    // byte-identically. Returns a capped daily set with the tally stripped so the
    // viewer can't see the crowd's lean before predicting.
    if (firstQueryString(req.query.playable) === "1" && postType === "battle") {
      // Blind mode needs a signed-in viewer to exclude already-seen battles and
      // to record the real own-pick later; anonymous → empty set.
      if (!req.user) {
        res.json({ posts: [], nextCursor: null });
        return;
      }
      const viewerId = req.user.id;

      // 1) Generous recency window of candidate battles (cursor ignored).
      const candidateRows = await db
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
        .where(and(
          eq(communityPostsTable.tenantId, tenantId),
          eq(communityPostsTable.postType, "battle"),
        ))
        .orderBy(desc(communityPostsTable.createdAt), desc(communityPostsTable.id))
        .limit(100);

      if (candidateRows.length === 0) {
        res.json({ posts: [], nextCursor: null });
        return;
      }

      const candidateIds = candidateRows.map((row) => row.id);

      // 2) Batch the vote tally per candidate, plus 3) the viewer-excluded set
      // (already voted OR already predicted) — all over the candidate window.
      const [tallyRows, viewerVoteRows, viewerPredictionRows] = await Promise.all([
        db
          .select({
            postId: communityVotesTable.postId,
            choice: communityVotesTable.choice,
            count: sql<number>`count(*)::int`,
          })
          .from(communityVotesTable)
          .where(and(
            eq(communityVotesTable.tenantId, tenantId),
            inArray(communityVotesTable.postId, candidateIds),
          ))
          .groupBy(communityVotesTable.postId, communityVotesTable.choice),
        db
          .select({ postId: communityVotesTable.postId })
          .from(communityVotesTable)
          .where(and(
            eq(communityVotesTable.tenantId, tenantId),
            eq(communityVotesTable.userId, viewerId),
            inArray(communityVotesTable.postId, candidateIds),
          )),
        db
          .select({ postId: arenaCrowdPredictionsTable.postId })
          .from(arenaCrowdPredictionsTable)
          .where(and(
            eq(arenaCrowdPredictionsTable.tenantId, tenantId),
            eq(arenaCrowdPredictionsTable.userId, viewerId),
            inArray(arenaCrowdPredictionsTable.postId, candidateIds),
          )),
      ]);

      const talliesByPost = voteTalliesFromRows(tallyRows);
      const seen = new Set<string>();
      for (const row of viewerVoteRows) seen.add(row.postId);
      for (const row of viewerPredictionRows) seen.add(row.postId);

      // 4) Keep eligible, unseen battles in recency order.
      const kept: PostRow[] = [];
      for (const row of candidateRows) {
        if (kept.length >= CROWD_READ_DAILY_TARGET) break;
        if (seen.has(row.id)) continue;
        const metadata = isPlainObject(row.metadata) ? row.metadata : {};
        const rawOptions = Array.isArray(metadata.options) ? metadata.options : [];
        const options = rawOptions.map((option: unknown) =>
          typeof option === "string" ? option.trim() : "",
        );
        if (options.length !== 2 || options.some((option) => !option)) continue;
        if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) continue;
        const [leftKey, rightKey] = options;
        const tally = talliesByPost.get(row.id) ?? {};
        const leftCount = tally[leftKey] ?? 0;
        const rightCount = tally[rightKey] ?? 0;
        if (!isCrowdReadEligible(leftCount, rightCount)) continue;
        kept.push(row);
      }

      // 6) Build DTOs then strip the tally for blind integrity — keep fragrances,
      // metadata, title, body so the bottle images and prompt still render.
      const builtDtos = await buildPostDtos(tenantId, kept, viewerId);
      const stripped = builtDtos.map((dto) => ({
        ...dto,
        votes: {},
        viewerVote: null,
        viewerVoteReason: null,
      }));

      res.json({ posts: stripped, nextCursor: null });
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

// Popular tags, aggregated from every post's tags within the tenant and ranked
// by frequency. Public read (optionally authenticated). Degrades to an empty
// list on any DB error so the client can fall back to its static defaults
// rather than surface an error in the filter bar.
router.get("/community/tags/popular", optionalAuth, async (req: AuthRequest, res, next) => {
  try {
    const tenantId = getTenantId(req);
    try {
      const rows = await db
        .select({
          tag: communityTagsTable.tag,
          count: sql<number>`count(*)::int`,
        })
        .from(communityTagsTable)
        .where(eq(communityTagsTable.tenantId, tenantId))
        .groupBy(communityTagsTable.tag)
        .orderBy(desc(sql`count(*)`), asc(communityTagsTable.tag))
        .limit(24);
      res.json({ tags: rows.map((r) => r.tag) });
    } catch (err) {
      // Missing table/column during migration lag, etc. — don't 500 the filter bar.
      if (!isUndefinedColumnError(err) && (err as { code?: string })?.code !== "42P01") throw err;
      res.json({ tags: [] });
    }
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

    // Optional thread parent. When present it must be a real comment on THIS post
    // in THIS tenant — guards against cross-post/cross-tenant reply grafting.
    let parentCommentId: string | null = null;
    if (body.parentCommentId !== undefined && body.parentCommentId !== null) {
      if (typeof body.parentCommentId !== "string" || !UUID_RE.test(body.parentCommentId)) {
        sendBadRequest(res, "parentCommentId must be a UUID");
        return;
      }
      parentCommentId = body.parentCommentId;
    }

    const postRow = await fetchPostRowById(tenantId, postId);
    if (!postRow) {
      res.status(404).json({ error: "Post not found" });
      return;
    }

    // Who should be notified of this comment: the parent comment's author for a
    // threaded reply, otherwise the post author. Resolved here so the validation
    // query does double duty.
    let replyTargetUserId: string | null = postRow.userId;
    if (parentCommentId) {
      const [parent] = await db
        .select({ id: communityCommentsTable.id, userId: communityCommentsTable.userId })
        .from(communityCommentsTable)
        .where(and(
          eq(communityCommentsTable.id, parentCommentId),
          eq(communityCommentsTable.tenantId, tenantId),
          eq(communityCommentsTable.postId, postId),
        ))
        .limit(1);
      if (!parent) {
        sendBadRequest(res, "parentCommentId must reference a comment on this post");
        return;
      }
      replyTargetUserId = parent.userId;
    }

    const [inserted] = await db
      .insert(communityCommentsTable)
      .values({
        tenantId,
        postId,
        userId: user.id,
        body: commentBody,
        parentCommentId,
      })
      .returning();
    if (!inserted) throw new Error("Failed to create community comment");

    const [comment] = await buildCommentDtos(tenantId, [{ ...inserted, authorEmail: user.email, authorPictureUrl: user.pictureUrl }]);
    res.status(201).json({ comment });

    // Fire a "community" push to the reply target — best-effort, after the
    // response so it never delays or fails the comment write. Skip self-replies.
    if (replyTargetUserId && replyTargetUserId !== user.id) {
      const isThreadReply = Boolean(parentCommentId);
      const excerpt = commentBody.length > 110 ? `${commentBody.slice(0, 109)}…` : commentBody;
      void sendCategoryPushToUser(replyTargetUserId, "community", {
        title: isThreadReply ? "New reply" : "New comment on your post",
        body: excerpt,
        url: "/community",
        tag: `community-comment-${postId}`,
      }).catch((err) => logger.warn({ err, postId }, "[community] reply push failed"));
    }
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
    const choice = cleanRequiredText(body.choice, MAX_BATTLE_OPTION_LENGTH);
    if (!choice) {
      sendBadRequest(res, "choice is required");
      return;
    }

    // Optional "why it won" reason key. Only touched when the client explicitly
    // sends the field, so a plain pick switch never wipes an existing reason.
    const reasonProvided = Object.prototype.hasOwnProperty.call(body, "reason");
    const reason = reasonProvided ? cleanOptionalText(body.reason, MAX_REASON_LENGTH) : null;

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
    if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) {
      sendBadRequest(res, "battle metadata requires two distinct options");
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
        ...(reasonProvided ? { reason } : {}),
      })
      .onConflictDoUpdate({
        target: [communityVotesTable.userId, communityVotesTable.postId],
        set: {
          tenantId,
          choice,
          updatedAt: new Date(),
          // Preserve an existing reason on a plain pick switch; only overwrite it
          // when the client actually sends a reason field.
          ...(reasonProvided ? { reason } : {}),
        },
      });

    const votes = await voteTallyForPost(tenantId, postId);
    res.json({ postId, choice, reason: reasonProvided ? reason : null, votes });
  } catch (err) {
    next(err);
  }
});

router.post("/community/posts/:id/beam", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const tenantId = getTenantId(req);
    const user = req.user!;
    const postId = routeParam(req.params.id);
    if (!postId || !UUID_RE.test(postId)) {
      sendBadRequest(res, "post id must be a UUID");
      return;
    }

    const body = isPlainObject(req.body) ? req.body : {};
    const choice = cleanRequiredText(body.choice, MAX_BATTLE_OPTION_LENGTH);
    if (!choice) {
      sendBadRequest(res, "choice is required");
      return;
    }

    const scored = scoreArenaBeamRun(body.score);
    if (!scored.ok) {
      sendBadRequest(res, scored.error);
      return;
    }

    const runId = cleanArenaBeamRunId(body.runId);
    if (!runId) {
      sendBadRequest(res, "runId is required");
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
      sendBadRequest(res, "Beam Power is only available for battle posts");
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

    const position = options.indexOf(choice);
    const fragranceRows = await db
      .select({ fragrance: communityPostFragrancesTable.fragrance })
      .from(communityPostFragrancesTable)
      .where(and(
        eq(communityPostFragrancesTable.tenantId, tenantId),
        eq(communityPostFragrancesTable.postId, postId),
        eq(communityPostFragrancesTable.position, position),
      ))
      .limit(1);
    const snapshot = (fragranceRows[0]?.fragrance ?? null) as Partial<FragranceSnapshot> | null;
    const fragranceId = resolveArenaBeamFragranceId(snapshot);
    if (!fragranceId) {
      sendBadRequest(res, "battle contender is missing a fragrance id");
      return;
    }

    await db
      .insert(arenaBeamGrantsTable)
      .values({
        tenantId,
        postId,
        userId: user.id,
        fragranceId,
        runId,
        beamPower: scored.beamPower,
        gameScore: scored.score,
      })
      .onConflictDoNothing({
        target: [
          arenaBeamGrantsTable.userId,
          arenaBeamGrantsTable.postId,
          arenaBeamGrantsTable.runId,
        ],
      });

    const totals = await beamTotalsForFragrance(tenantId, fragranceId);
    res.status(201).json({
      postId,
      choice,
      fragranceId,
      score: scored.score,
      beamPower: scored.beamPower,
      ...totals,
    });
  } catch (err) {
    next(err);
  }
});

// Arena "Crowd vs You" submit. Two taps in one call: predicted_choice (which
// option the user bets the crowd is backing) and own_pick (their real vote,
// also written to community_votes). Server is the sole tally authority — the
// leader is resolved from the LIVE tally that INCLUDES the user's own real vote
// (their own-pick is a genuine community vote), and the ≥2/15% margin gate
// tolerates that single-vote self-influence. Idempotent per (user, post): a
// re-submit never re-scores, it replays the stored prediction against the live
// tally/stats.
router.post("/community/posts/:id/crowd-read", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const tenantId = getTenantId(req);
    const user = req.user!;
    const postId = routeParam(req.params.id);
    if (!postId || !UUID_RE.test(postId)) {
      sendBadRequest(res, "post id must be a UUID");
      return;
    }

    const body = isPlainObject(req.body) ? req.body : {};
    const predictedChoice = cleanRequiredText(body.predicted_choice, MAX_BATTLE_OPTION_LENGTH);
    const ownPick = cleanRequiredText(body.own_pick, MAX_BATTLE_OPTION_LENGTH);
    if (!predictedChoice) {
      sendBadRequest(res, "predicted_choice is required");
      return;
    }
    if (!ownPick) {
      sendBadRequest(res, "own_pick is required");
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
      sendBadRequest(res, "crowd-read is only available for battle posts");
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
    if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) {
      sendBadRequest(res, "battle metadata requires two distinct options");
      return;
    }
    if (!options.includes(predictedChoice)) {
      sendBadRequest(res, "predicted_choice must match one of the battle options");
      return;
    }
    if (!options.includes(ownPick)) {
      sendBadRequest(res, "own_pick must match one of the battle options");
      return;
    }

    // IDEMPOTENCY: a prior read exists → never re-score. Replay the stored
    // prediction against the current live tally and stats.
    const existingPrediction = await db
      .select({
        leaderAtReveal: arenaCrowdPredictionsTable.leaderAtReveal,
        ownPick: arenaCrowdPredictionsTable.ownPick,
        wasCorrect: arenaCrowdPredictionsTable.wasCorrect,
      })
      .from(arenaCrowdPredictionsTable)
      .where(and(
        eq(arenaCrowdPredictionsTable.tenantId, tenantId),
        eq(arenaCrowdPredictionsTable.userId, user.id),
        eq(arenaCrowdPredictionsTable.postId, postId),
      ))
      .limit(1);

    if (existingPrediction[0]) {
      const stored = existingPrediction[0];
      const [tally, statsRows] = await Promise.all([
        voteTallyForPost(tenantId, postId),
        db
          .select({
            currentStreak: arenaCrowdStatsTable.currentStreak,
            bestStreak: arenaCrowdStatsTable.bestStreak,
            totalReads: arenaCrowdStatsTable.totalReads,
            correctReads: arenaCrowdStatsTable.correctReads,
          })
          .from(arenaCrowdStatsTable)
          .where(and(
            eq(arenaCrowdStatsTable.tenantId, tenantId),
            eq(arenaCrowdStatsTable.userId, user.id),
          ))
          .limit(1),
      ]);
      const stats = statsRows[0];
      res.json({
        was_correct: stored.wasCorrect,
        leader_at_reveal: stored.leaderAtReveal,
        tally,
        went_with_crowd: stored.ownPick === stored.leaderAtReveal,
        current_streak: stats?.currentStreak ?? 0,
        best_streak: stats?.bestStreak ?? 0,
        accuracy: crowdReadAccuracy(stats?.correctReads ?? 0, stats?.totalReads ?? 0),
      });
      return;
    }

    const today = new Date().toISOString().slice(0, 10);

    const result = await db.transaction(async (tx) => {
      // 1) The own-pick is the real, required vote — upsert it like /votes.
      await tx
        .insert(communityVotesTable)
        .values({
          tenantId,
          postId,
          userId: user.id,
          choice: ownPick,
        })
        .onConflictDoUpdate({
          target: [communityVotesTable.userId, communityVotesTable.postId],
          set: {
            tenantId,
            choice: ownPick,
            updatedAt: new Date(),
          },
        });

      // 2) Re-read the live tally (now including this own-pick).
      const tallyRows = await tx
        .select({
          choice: communityVotesTable.choice,
          count: sql<number>`count(*)::int`,
        })
        .from(communityVotesTable)
        .where(and(eq(communityVotesTable.tenantId, tenantId), eq(communityVotesTable.postId, postId)))
        .groupBy(communityVotesTable.choice);
      const tally: Record<string, number> = {};
      for (const row of tallyRows) tally[row.choice] = Number(row.count) || 0;

      // 3) Resolve the leader and score the prediction.
      const leftCount = tally[options[0]] ?? 0;
      const rightCount = tally[options[1]] ?? 0;
      const total = leftCount + rightCount;
      const leader = resolveCrowdLeader(options[0], leftCount, options[1], rightCount);
      const outcome = crowdReadOutcome(predictedChoice, leader);
      const wasCorrect = outcome === "correct";

      // 4) Daily streak transition off the stored stats row.
      const statsRows = await tx
        .select({
          currentStreak: arenaCrowdStatsTable.currentStreak,
          bestStreak: arenaCrowdStatsTable.bestStreak,
          totalReads: arenaCrowdStatsTable.totalReads,
          correctReads: arenaCrowdStatsTable.correctReads,
          lastPlayedOn: arenaCrowdStatsTable.lastPlayedOn,
        })
        .from(arenaCrowdStatsTable)
        .where(and(
          eq(arenaCrowdStatsTable.tenantId, tenantId),
          eq(arenaCrowdStatsTable.userId, user.id),
        ))
        .limit(1);
      const stats = statsRows[0];
      const effectivePrev = isStreakContinuable(stats?.lastPlayedOn ?? null, today)
        ? (stats?.currentStreak ?? 0)
        : 0;
      const current = nextStreak(effectivePrev, outcome);
      const best = Math.max(stats?.bestStreak ?? 0, current);
      const totalReads = (stats?.totalReads ?? 0) + 1;
      const correctReads = (stats?.correctReads ?? 0) + (wasCorrect ? 1 : 0);

      // 5) Insert the prediction row FIRST so its UNIQUE(user,post) constraint is
      // the single gate on scoring. A concurrent submit that slipped past the
      // existence check does nothing here — and crucially skips the stats write
      // below, so total_reads / correct_reads can never be double-counted.
      const insertedPrediction = await tx
        .insert(arenaCrowdPredictionsTable)
        .values({
          tenantId,
          userId: user.id,
          postId,
          predictedChoice,
          ownPick,
          leaderAtReveal: leader,
          tallyTotalAtReveal: total,
          wasCorrect,
          streakAfter: current,
        })
        .onConflictDoNothing({
          target: [arenaCrowdPredictionsTable.userId, arenaCrowdPredictionsTable.postId],
        })
        .returning({ id: arenaCrowdPredictionsTable.id });

      if (insertedPrediction.length === 0) {
        // Lost the race: another submit already scored + tallied this read. Replay
        // the winning stored row + its stats WITHOUT touching stats here, so the
        // response stays consistent and nothing is double-counted.
        const racedRows = await tx
          .select({
            leaderAtReveal: arenaCrowdPredictionsTable.leaderAtReveal,
            ownPick: arenaCrowdPredictionsTable.ownPick,
            wasCorrect: arenaCrowdPredictionsTable.wasCorrect,
          })
          .from(arenaCrowdPredictionsTable)
          .where(and(
            eq(arenaCrowdPredictionsTable.tenantId, tenantId),
            eq(arenaCrowdPredictionsTable.userId, user.id),
            eq(arenaCrowdPredictionsTable.postId, postId),
          ))
          .limit(1);
        const racedStatsRows = await tx
          .select({
            currentStreak: arenaCrowdStatsTable.currentStreak,
            bestStreak: arenaCrowdStatsTable.bestStreak,
            totalReads: arenaCrowdStatsTable.totalReads,
            correctReads: arenaCrowdStatsTable.correctReads,
          })
          .from(arenaCrowdStatsTable)
          .where(and(
            eq(arenaCrowdStatsTable.tenantId, tenantId),
            eq(arenaCrowdStatsTable.userId, user.id),
          ))
          .limit(1);
        const raced = racedRows[0];
        const racedStats = racedStatsRows[0];
        return {
          was_correct: raced?.wasCorrect ?? wasCorrect,
          leader_at_reveal: raced?.leaderAtReveal ?? leader,
          tally,
          went_with_crowd: (raced?.ownPick ?? ownPick) === (raced?.leaderAtReveal ?? leader),
          current_streak: racedStats?.currentStreak ?? current,
          best_streak: racedStats?.bestStreak ?? best,
          accuracy: crowdReadAccuracy(
            racedStats?.correctReads ?? correctReads,
            racedStats?.totalReads ?? totalReads,
          ),
        };
      }

      // 6) Won the insert → record the stats for this read exactly once.
      await tx
        .insert(arenaCrowdStatsTable)
        .values({
          tenantId,
          userId: user.id,
          currentStreak: current,
          bestStreak: best,
          totalReads,
          correctReads,
          lastPlayedOn: today,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [arenaCrowdStatsTable.tenantId, arenaCrowdStatsTable.userId],
          set: {
            currentStreak: current,
            bestStreak: best,
            totalReads,
            correctReads,
            lastPlayedOn: today,
            updatedAt: new Date(),
          },
        });

      return {
        was_correct: wasCorrect,
        leader_at_reveal: leader,
        tally,
        went_with_crowd: ownPick === leader,
        current_streak: current,
        best_streak: best,
        accuracy: crowdReadAccuracy(correctReads, totalReads),
      };
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Arena "Crowd vs You" Beam Streak stats for the signed-in viewer. Powers the
// entry card + prompt headers before the first read of a session. Applies the
// skip-a-day break on read: a streak whose last play was older than yesterday
// displays as 0 (it's already broken) even though the row hasn't been reset yet.
router.get("/community/arena/crowd-stats", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const tenantId = getTenantId(req);
    const user = req.user!;
    const statsRows = await db
      .select({
        currentStreak: arenaCrowdStatsTable.currentStreak,
        bestStreak: arenaCrowdStatsTable.bestStreak,
        totalReads: arenaCrowdStatsTable.totalReads,
        correctReads: arenaCrowdStatsTable.correctReads,
        lastPlayedOn: arenaCrowdStatsTable.lastPlayedOn,
      })
      .from(arenaCrowdStatsTable)
      .where(and(
        eq(arenaCrowdStatsTable.tenantId, tenantId),
        eq(arenaCrowdStatsTable.userId, user.id),
      ))
      .limit(1);
    const stats = statsRows[0];
    const today = new Date().toISOString().slice(0, 10);
    const alive = isStreakContinuable(stats?.lastPlayedOn ?? null, today);
    res.json({
      current_streak: stats && alive ? stats.currentStreak : 0,
      best_streak: stats?.bestStreak ?? 0,
      accuracy: crowdReadAccuracy(stats?.correctReads ?? 0, stats?.totalReads ?? 0),
      total_reads: stats?.totalReads ?? 0,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
