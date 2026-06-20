import { randomInt } from "node:crypto";
import { Router } from "express";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { scentRushProgressTable, scentRushRunsTable, userFragrancesTable } from "@workspace/db/schema";
import { AuthRequest, optionalAuth, requireAuth } from "../middlewares/auth";
import { getTenantId } from "../middlewares/tenant";
import {
  FRESH_START_DURATION_MS,
  MAX_RUSH_WALL_TIME_MS,
  RUSH_LEVEL_CAPS,
  assertRunRedeemable,
  buildRushProgressSummary,
  cappedTotalBeamPower,
  createScentRushManifest,
  generateFreshStartPlan,
  normalizeFragranceId,
  validateCompletion,
  type RushCompletionInput,
  type RushPlanEvent,
  type ScentRushManifest,
} from "../services/scentRushCore";

const router = Router();
const RUN_TTL_MS = MAX_RUSH_WALL_TIME_MS;

function routeParam(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return normalizeFragranceId(raw);
}

function apiError(res: import("express").Response, err: unknown): void {
  const code = err instanceof Error ? err.message : "invalid_completion";
  const status = code === "wrong_user" ? 403 : code === "expired_run" ? 410 : 400;
  res.status(status).json({ error: code });
}

async function ownedFragrance(tenantId: string, userId: string, fragranceId: string) {
  const idMatch = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fragranceId)
    ? eq(userFragrancesTable.id, fragranceId as never)
    : undefined;
  const [row] = await db
    .select({ id: userFragrancesTable.id, fragranceData: userFragrancesTable.fragranceData })
    .from(userFragrancesTable)
    .where(and(
      eq(userFragrancesTable.tenantId, tenantId),
      eq(userFragrancesTable.userId, userId),
      idMatch
        ? or(idMatch, sql`${userFragrancesTable.fragranceData}->>'id' = ${fragranceId}`)
        : sql`${userFragrancesTable.fragranceData}->>'id' = ${fragranceId}`,
    ))
    .limit(1);
  return row ?? null;
}

function manifestFromOwnedFragrance(fragranceId: string, raw: unknown) {
  const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const product = data.product && typeof data.product === "object" ? data.product as Record<string, unknown> : {};
  const pyramid = data.pyramid && typeof data.pyramid === "object" ? data.pyramid as Record<string, unknown> : {};
  const notes = Array.isArray(data.notes)
    ? data.notes
    : [pyramid.top, pyramid.heart, pyramid.base].flatMap((value) => Array.isArray(value) ? value : []);
  return createScentRushManifest({
    fragranceId,
    displayName: data.name ?? product.name,
    family: data.family,
    notes,
  });
}

async function progressSummary(tenantId: string, fragranceId: string, userId?: string) {
  const [aggregateRows, userRows] = await Promise.all([
    db
      .select({
        supporters: sql<number>`count(distinct ${scentRushProgressTable.userId}) filter (where ${scentRushProgressTable.beamPower} > 0)`,
        totalBeamPower: sql<number>`coalesce(sum(${scentRushProgressTable.beamPower}), 0)`,
      })
      .from(scentRushProgressTable)
      .where(and(eq(scentRushProgressTable.tenantId, tenantId), eq(scentRushProgressTable.fragranceId, fragranceId))),
    userId
      ? db
          .select()
          .from(scentRushProgressTable)
          .where(and(
            eq(scentRushProgressTable.tenantId, tenantId),
            eq(scentRushProgressTable.userId, userId),
            eq(scentRushProgressTable.fragranceId, fragranceId),
          ))
      : Promise.resolve([] as Array<typeof scentRushProgressTable.$inferSelect>),
  ]);
  return buildRushProgressSummary(aggregateRows[0], userRows);
}

router.get("/fragrances/:fragranceId/rush/progress", optionalAuth, async (req: AuthRequest, res, next) => {
  try {
    const fragranceId = routeParam(req.params.fragranceId);
    if (!fragranceId) return void res.status(400).json({ error: "invalid_fragrance_id" });
    res.json(await progressSummary(getTenantId(req), fragranceId, req.user?.id));
  } catch (err) {
    next(err);
  }
});

router.post("/fragrances/:fragranceId/rush/runs", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const fragranceId = routeParam(req.params.fragranceId);
    if (!fragranceId) return void res.status(400).json({ error: "invalid_fragrance_id" });
    const user = req.user!;
    const tenantId = getTenantId(req);
    const owned = await ownedFragrance(tenantId, user.id, fragranceId);
    if (!owned) return void res.status(404).json({ error: "fragrance_not_owned" });
    const manifest = manifestFromOwnedFragrance(fragranceId, owned.fragranceData);
    const seed = randomInt(1, 2_147_483_647);
    const eventPlan = generateFreshStartPlan(seed, manifest);
    const expiresAt = new Date(Date.now() + RUN_TTL_MS);
    const [run] = await db
      .insert(scentRushRunsTable)
      .values({
        tenantId,
        userId: user.id,
        fragranceId,
        level: 1,
        seed,
        manifestVersion: manifest.version,
        manifest,
        eventPlan,
        expiresAt,
      })
      .returning({ id: scentRushRunsTable.id });
    if (!run) throw new Error("run_create_failed");
    res.status(201).json({
      runId: run.id,
      seed,
      level: 1,
      manifestVersion: manifest.version,
      expiresAt: expiresAt.toISOString(),
      durationMs: FRESH_START_DURATION_MS,
      manifest,
      eventPlan,
      progress: await progressSummary(tenantId, fragranceId, user.id),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/fragrances/:fragranceId/rush/runs/:runId/complete", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const fragranceId = routeParam(req.params.fragranceId);
    const runId = typeof req.params.runId === "string" ? req.params.runId : "";
    if (!fragranceId || !runId) return void res.status(400).json({ error: "invalid_run" });
    const tenantId = getTenantId(req);
    const user = req.user!;
    const [run] = await db
      .select()
      .from(scentRushRunsTable)
      .where(and(eq(scentRushRunsTable.tenantId, tenantId), eq(scentRushRunsTable.id, runId as never)))
      .limit(1);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    const state = assertRunRedeemable(run, { userId: user.id, fragranceId });
    if (state === "completed") return void res.json(run.result);

    const calculated = validateCompletion(run.eventPlan as RushPlanEvent[], req.body as RushCompletionInput, {
      serverElapsedMs: Date.now() - run.createdAt.getTime(),
    });
    const result = await db.transaction(async (tx) => {
      const [previous] = await tx
        .select()
        .from(scentRushProgressTable)
        .where(and(
          eq(scentRushProgressTable.tenantId, tenantId),
          eq(scentRushProgressTable.userId, user.id),
          eq(scentRushProgressTable.fragranceId, fragranceId),
          eq(scentRushProgressTable.level, 1),
        ))
        .limit(1);
      const previousBest = previous?.bestScore ?? 0;
      const now = new Date();
      const [claimed] = await tx
        .update(scentRushRunsTable)
        .set({ completedAt: now, eventDigest: req.body.eventDigest })
        .where(and(
          eq(scentRushRunsTable.tenantId, tenantId),
          eq(scentRushRunsTable.id, run.id),
          isNull(scentRushRunsTable.completedAt),
        ))
        .returning({ id: scentRushRunsTable.id });
      if (!claimed) {
        const [completed] = await tx.select({ result: scentRushRunsTable.result }).from(scentRushRunsTable).where(eq(scentRushRunsTable.id, run.id)).limit(1);
        return completed?.result;
      }

      const [stored] = await tx
        .insert(scentRushProgressTable)
        .values({
          tenantId, userId: user.id, fragranceId, level: 1,
          bestScore: calculated.score, bestPerformance: calculated.performance,
          beamPower: Math.min(RUSH_LEVEL_CAPS[1], calculated.beamPowerEarned),
        })
        .onConflictDoUpdate({
          target: [
            scentRushProgressTable.tenantId, scentRushProgressTable.userId,
            scentRushProgressTable.fragranceId, scentRushProgressTable.level,
          ],
          set: {
            bestScore: sql`greatest(${scentRushProgressTable.bestScore}, excluded.best_score)`,
            bestPerformance: sql`greatest(${scentRushProgressTable.bestPerformance}, excluded.best_performance)`,
            beamPower: sql`least(${RUSH_LEVEL_CAPS[1]}, greatest(${scentRushProgressTable.beamPower}, excluded.beam_power))`,
            updatedAt: now,
          },
        })
        .returning();
      if (!stored) throw new Error("progress_store_failed");

      const [aggregate] = await tx
        .select({
          supporters: sql<number>`count(distinct ${scentRushProgressTable.userId}) filter (where ${scentRushProgressTable.beamPower} > 0)`,
          totalBeamPower: sql<number>`coalesce(sum(${scentRushProgressTable.beamPower}), 0)`,
        })
        .from(scentRushProgressTable)
        .where(and(eq(scentRushProgressTable.tenantId, tenantId), eq(scentRushProgressTable.fragranceId, fragranceId)));
      const userLevels = await tx.select().from(scentRushProgressTable).where(and(
        eq(scentRushProgressTable.tenantId, tenantId), eq(scentRushProgressTable.userId, user.id),
        eq(scentRushProgressTable.fragranceId, fragranceId),
      ));
      const finalResult = {
        ...calculated,
        previousBest,
        newBest: stored.bestScore,
        previousBeamPower: previous?.beamPower ?? 0,
        storedBeamPower: stored.beamPower,
        bestUpgraded: stored.bestScore > previousBest,
        progress: {
          beamSupporters: Number(aggregate?.supporters ?? 0),
          totalBeamPower: Number(aggregate?.totalBeamPower ?? 0),
          user: {
            freshStartBeamPower: stored.beamPower,
            freshStartBestScore: stored.bestScore,
            freshStartBestPerformance: stored.bestPerformance,
            totalBeamPower: cappedTotalBeamPower([1, 2, 3].map((level) => userLevels.find((row) => row.level === level)?.beamPower ?? 0)),
            maximumBeamPower: 10,
          },
        },
      };
      await tx.update(scentRushRunsTable).set({ result: finalResult }).where(eq(scentRushRunsTable.id, run.id));
      return finalResult;
    });
    res.json(result);
  } catch (err) {
    const expected = new Set([
      "wrong_user", "wrong_fragrance", "expired_run", "unsupported_client_version", "implausible_duration",
      "implausible_server_duration", "invalid_actions", "invalid_action_timing", "invalid_event_outcomes",
      "invalid_event_count", "unknown_or_duplicate_event", "invalid_event_outcome", "implausible_event_timing",
      "invalid_event_digest", "impossible_score", "invalid_hazard_summary", "invalid_orb_summary", "level_cap_exceeded",
    ]);
    if (err instanceof Error && expected.has(err.message)) return void apiError(res, err);
    next(err);
  }
});

export default router;
