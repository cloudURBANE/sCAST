import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { userFragranceWithMeTable, userSettingsTable } from "@workspace/db/schema";
import type { WithMeState } from "./withMeCore.ts";

function isWithMeMigrationLag(error: unknown): boolean {
  let current: unknown = error;
  while (current && typeof current === "object") {
    const code = (current as { code?: unknown }).code;
    if (code === "42P01" || code === "42703") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Read the server-authoritative availability scope for one tenant/user. */
export async function loadWithMeState(tenantId: string, userId: string): Promise<WithMeState> {
  let settingsRows: Array<{ enabled: boolean; updatedAt: Date | null }>;
  let membershipRows: Array<{ fragranceId: string }>;
  try {
    [settingsRows, membershipRows] = await Promise.all([
      db
        .select({ enabled: userSettingsTable.withMeEnabled, updatedAt: userSettingsTable.withMeUpdatedAt })
        .from(userSettingsTable)
        // users.id is globally unique and user_settings.user_id is unique. Some
        // legacy settings rows predate tenant backfill and retain a null tenant,
        // so user scope is the compatible authoritative lookup here.
        .where(eq(userSettingsTable.userId, userId))
        .limit(1),
      db
        .select({ fragranceId: userFragranceWithMeTable.userFragranceId })
        .from(userFragranceWithMeTable)
        .where(and(
          eq(userFragranceWithMeTable.tenantId, tenantId),
          eq(userFragranceWithMeTable.userId, userId),
        )),
    ]);
  } catch (error) {
    // During a rolling deploy the application may briefly precede the additive
    // migration. Preserve the legacy full-vault behavior instead of taking Beam
    // and recommendation routes down while the table/columns catch up.
    if (isWithMeMigrationLag(error)) {
      return { enabled: false, fragranceIds: [], updatedAt: null };
    }
    throw error;
  }
  const settings = settingsRows[0];
  return {
    enabled: settings?.enabled === true,
    fragranceIds: membershipRows.map((row) => row.fragranceId),
    updatedAt: settings?.updatedAt?.toISOString() ?? null,
  };
}
