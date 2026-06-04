import { db } from "@workspace/db";
import { apiUsageLedgerTable } from "@workspace/db/schema";
import { count, eq, sql, sum } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getCurrentTenantId } from "../lib/tenantContext";
import { getDefaultTenantId } from "./tenants";

// OpenAI image pricing snapshot. Last reviewed: 2026-05-15.
//
// Values are USD per generated image at the listed (model, size, quality)
// combination. They are intentionally hard-coded here rather than fetched from
// a remote source so the ledger total is deterministic and auditable. Update
// these together with the pricing_last_checked comment whenever OpenAI revises
// image pricing.
type PriceKey = `${string}|${string}|${string}`;

function priceKey(model: string, size: string, quality: string): PriceKey {
  return `${model}|${size}|${quality}` as PriceKey;
}

const IMAGE_PRICE_TABLE: Record<PriceKey, number> = {
  [priceKey("gpt-image-1", "1024x1024", "low")]: 0.011,
  [priceKey("gpt-image-1", "1024x1024", "medium")]: 0.042,
  [priceKey("gpt-image-1", "1024x1024", "high")]: 0.167,
  [priceKey("gpt-image-1", "1024x1536", "high")]: 0.25,
  [priceKey("gpt-image-1", "1536x1024", "high")]: 0.25,

  [priceKey("gpt-image-1-mini", "1024x1024", "low")]: 0.0025,
  [priceKey("gpt-image-1-mini", "1024x1024", "medium")]: 0.01,
  [priceKey("gpt-image-1-mini", "1024x1024", "high")]: 0.03,

  // gpt-image-2 pricing not yet published as of 2026-05-15. Best estimate.
  [priceKey("gpt-image-2", "1024x1024", "low")]: 0.02,
  [priceKey("gpt-image-2", "1024x1024", "medium")]: 0.08,
  [priceKey("gpt-image-2", "1024x1024", "high")]: 0.2,
};

const PRICING_LAST_CHECKED = "2026-05-15";

export function estimateImageGenerationCostUsd(
  model: string,
  size: string,
  quality: string,
  imageCount = 1,
): number {
  const direct = IMAGE_PRICE_TABLE[priceKey(model, size, quality)];
  if (typeof direct === "number") return direct * imageCount;
  // Conservative fallback: charge as gpt-image-1 high if we don't know.
  const fallback = IMAGE_PRICE_TABLE[priceKey("gpt-image-1", "1024x1024", "high")];
  return (fallback ?? 0) * imageCount;
}

export type RecordApiUsageInput = {
  tenantId?: string | null;
  userId?: string | null;
  provider: "openai";
  operation: "image.edits";
  model: string;
  size?: string | null;
  quality?: string | null;
  imageCount?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  status: "success" | "failure";
  failureReason?: string | null;
};

let ledgerMissingWarned = false;
function warnLedgerMissingOnce(): void {
  if (ledgerMissingWarned) return;
  ledgerMissingWarned = true;
  logger.warn(
    "api_usage_ledger table is missing; usage tracking is disabled. Run pnpm --filter @workspace/db push.",
  );
}

function isLedgerUnavailableError(err: unknown): boolean {
  const value = err as { code?: unknown; message?: unknown } | null;
  const isMissing =
    value?.code === "42P01" ||
    (typeof value?.message === "string" &&
      /relation ["']?api_usage_ledger["']? does not exist/i.test(value.message));
  if (isMissing) warnLedgerMissingOnce();
  return isMissing;
}

export async function recordApiUsage(input: RecordApiUsageInput): Promise<void> {
  const size = input.size ?? "1024x1024";
  const quality = input.quality ?? "high";
  const imageCount = Math.max(1, Math.floor(input.imageCount ?? 1));
  const cost =
    input.status === "success"
      ? estimateImageGenerationCostUsd(input.model, size, quality, imageCount)
      : 0;

  // Stamp the row's tenant from the explicit input, the ambient request context,
  // or the default tenant for background callers — never NULL.
  const tenantId = input.tenantId ?? getCurrentTenantId() ?? (await getDefaultTenantId());

  try {
    await db.insert(apiUsageLedgerTable).values({
      tenantId,
      userId: input.userId ?? null,
      provider: input.provider,
      operation: input.operation,
      model: input.model,
      size,
      quality,
      imageCount,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      estimatedCostUsd: cost.toFixed(6),
      status: input.status,
      failureReason: input.failureReason?.slice(0, 500) ?? null,
    });
  } catch (err) {
    if (isLedgerUnavailableError(err)) return;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[apiUsageLedger] failed to record usage row",
    );
  }
}

export type UsageTotalsByModel = {
  model: string;
  count: number;
  totalUsd: number;
};

export type UsageTotalsResponse = {
  totalUsd: number;
  count: number;
  successCount: number;
  failureCount: number;
  pricingLastChecked: string;
  byModel: UsageTotalsByModel[];
};

export async function getUsageTotals(userId?: string | null): Promise<UsageTotalsResponse> {
  const empty: UsageTotalsResponse = {
    totalUsd: 0,
    count: 0,
    successCount: 0,
    failureCount: 0,
    pricingLastChecked: PRICING_LAST_CHECKED,
    byModel: [],
  };

  try {
    const usageScope = userId ? eq(apiUsageLedgerTable.userId, userId) : sql`true`;
    const [overall] = await db
      .select({
        total: sum(apiUsageLedgerTable.estimatedCostUsd),
        count: count(apiUsageLedgerTable.id),
        successCount: sql<number>`count(*) filter (where ${apiUsageLedgerTable.status} = 'success')`,
        failureCount: sql<number>`count(*) filter (where ${apiUsageLedgerTable.status} = 'failure')`,
      })
      .from(apiUsageLedgerTable)
      .where(usageScope);

    const byModel = await db
      .select({
        model: apiUsageLedgerTable.model,
        count: count(apiUsageLedgerTable.id),
        total: sum(apiUsageLedgerTable.estimatedCostUsd),
      })
      .from(apiUsageLedgerTable)
      .where(usageScope)
      .groupBy(apiUsageLedgerTable.model);

    return {
      totalUsd: Number(overall?.total ?? 0),
      count: Number(overall?.count ?? 0),
      successCount: Number(overall?.successCount ?? 0),
      failureCount: Number(overall?.failureCount ?? 0),
      pricingLastChecked: PRICING_LAST_CHECKED,
      byModel: byModel.map((row) => ({
        model: row.model,
        count: Number(row.count ?? 0),
        totalUsd: Number(row.total ?? 0),
      })),
    };
  } catch (err) {
    if (isLedgerUnavailableError(err)) return empty;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[apiUsageLedger] failed to read usage totals",
    );
    return empty;
  }
}
