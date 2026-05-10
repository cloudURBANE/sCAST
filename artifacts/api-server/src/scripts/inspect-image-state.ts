/**
 * Read-only DB diagnostic for the May 2026 white-box Poof regression.
 *
 * Reports:
 *   - image_cache row counts split by processing_status / background_removed
 *   - daily fallback rate over the last 7 days (regression vs healthy baseline)
 *   - rows created since the patch landed (cc0568c, 2026-05-10 15:02 UTC)
 *   - remove_bg_status / remove_bg_reason histogram for new rows (added in
 *     8407ca7's follow-up so we no longer need to fetch WebPs to know why
 *     a row landed in fallback)
 *   - global_fragrances + user_fragrances imageUrl coverage
 *   - alpha-channel stats on the most recent bg=FALSE WebPs (still useful
 *     for back-compat rows where remove_bg_reason is NULL)
 *
 * Run from the repo root:
 *   node node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs \
 *     --env-file=.env \
 *     artifacts/api-server/src/scripts/inspect-image-state.ts
 *
 * Performs zero writes; safe to re-run any time DATABASE_URL is set.
 */
import sharp from "sharp";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";

const PATCH_LANDED_AT = "2026-05-10 15:02:00+00";

async function rows<T>(query: any): Promise<T[]> {
  const result: any = await db.execute(query);
  return (Array.isArray(result) ? result : result.rows ?? []) as T[];
}

function section(label: string): void {
  console.log(`\n=== ${label} ===`);
}

function dump(label: string, data: unknown): void {
  section(label);
  console.log(JSON.stringify(data, null, 2));
}

async function inspectAlpha(url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`  fetch failed: ${res.status}`);
    return;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const meta = await sharp(buf).metadata();
  const stats = await sharp(buf).stats();
  const alpha = stats.channels[stats.channels.length - 1];
  const alphaMean = alpha?.mean ?? null;
  console.log(
    `  ${buf.length}b  ${meta.width}x${meta.height}  hasAlpha=${meta.hasAlpha}  alpha.min=${alpha?.min} max=${alpha?.max} mean=${alphaMean?.toFixed?.(2)}`,
  );
  if (meta.hasAlpha && alphaMean != null) {
    if (alphaMean < 5) console.log(`    >>> EFFECTIVELY TRANSPARENT (post-encode revert would have triggered)`);
    else if (alphaMean < 130) console.log(`    >>> looks like a real Poof-removed packshot`);
    else if (alphaMean < 200) console.log(`    >>> partial alpha (could be source-with-alpha fallback OR loose Poof removal)`);
    else console.log(`    >>> mostly opaque (looks like ensureAlpha'd source + transparent padding fallback)`);
  } else if (!meta.hasAlpha) {
    console.log(`    >>> NO alpha channel — ensureAlpha was bypassed somewhere`);
  }
}

async function main(): Promise<void> {
  dump(
    "image_cache: ready-row split by background_removed",
    await rows(
      sql`select background_removed as bg, count(*)::int as n from image_cache where processing_status='ready' group by background_removed order by bg`,
    ),
  );

  dump(
    "image_cache: failed rows (any failure_reason in last 7d)",
    await rows(
      sql`select substring(failure_reason, 1, 160) as reason, count(*)::int as n
          from image_cache
          where processing_status='failed' and created_at > now() - interval '7 days'
          group by failure_reason order by n desc limit 10`,
    ),
  );

  dump(
    "image_cache: remove_bg_status x remove_bg_reason histogram (ready rows, last 7d)",
    await rows(
      sql`select coalesce(remove_bg_status, '(null)') as status,
            coalesce(remove_bg_reason, '(null)') as reason,
            count(*)::int as n
          from image_cache
          where processing_status='ready' and created_at > now() - interval '7 days'
          group by remove_bg_status, remove_bg_reason
          order by n desc`,
    ),
  );

  dump(
    "image_cache: daily ready-row split (bg_true / bg_false / total) — last 7 days",
    await rows(
      sql`select date_trunc('day', created_at) as day,
            sum(case when background_removed then 1 else 0 end)::int as bg_true,
            sum(case when not background_removed then 1 else 0 end)::int as bg_false,
            count(*)::int as total
          from image_cache
          where processing_status='ready' and created_at > now() - interval '7 days'
          group by day order by day desc`,
    ),
  );

  dump(
    `image_cache: rows created AFTER patch (${PATCH_LANDED_AT}) by bg flag`,
    await rows(
      sql`select background_removed as bg, count(*)::int as n
          from image_cache
          where processing_status='ready' and created_at > ${PATCH_LANDED_AT}
          group by background_removed order by bg`,
    ),
  );

  dump(
    "image_cache: post-patch bg=FALSE rows (lookup_key + url)",
    await rows(
      sql`select substring(coalesce(lookup_key,''),1,42) as lookup_key, source_provider,
            substring(coalesce(content_hash,''),1,12) as content_hash, public_url, created_at
          from image_cache
          where processing_status='ready' and background_removed=FALSE
            and created_at > ${PATCH_LANDED_AT}
          order by created_at desc`,
    ),
  );

  dump(
    "global_fragrances: imageUrl coverage",
    await rows(
      sql`select
            count(*)::int as total_rows,
            sum(case when coalesce(profile_data->>'imageUrl','') <> '' then 1 else 0 end)::int as image_url_present,
            sum(case when (profile_data->>'imageUrl') like '%/images/processed/%' then 1 else 0 end)::int as points_at_processed
          from global_fragrances`,
    ),
  );

  dump(
    "user_fragrances: imageUrl coverage",
    await rows(
      sql`select
            count(*)::int as total_rows,
            sum(case when coalesce(fragrance_data->>'imageUrl','') <> '' then 1 else 0 end)::int as image_url_present,
            sum(case when (fragrance_data->>'imageUrl') like '%/images/processed/%' then 1 else 0 end)::int as points_at_processed,
            sum(case when coalesce(fragrance_data->>'imageUrl','') = '' then 1 else 0 end)::int as image_url_empty
          from user_fragrances`,
    ),
  );

  section("alpha-channel inspection: post-patch bg=FALSE WebPs");
  const fallbacks = await rows<{ public_url: string; lookup_key: string; created_at: string }>(
    sql`select public_url, lookup_key, created_at from image_cache
        where processing_status='ready' and background_removed=FALSE
          and created_at > ${PATCH_LANDED_AT}
        order by created_at desc limit 6`,
  );
  for (const c of fallbacks) {
    console.log(`\n[${c.created_at}] ${c.lookup_key}`);
    try {
      await inspectAlpha(c.public_url);
    } catch (err: any) {
      console.log(`  ERROR: ${err?.message}`);
    }
  }

  section("alpha-channel inspection: most-recent bg=TRUE WebPs (control group)");
  const ok = await rows<{ public_url: string; lookup_key: string; created_at: string }>(
    sql`select public_url, lookup_key, created_at from image_cache
        where processing_status='ready' and background_removed=TRUE
          and created_at > ${PATCH_LANDED_AT}
        order by created_at desc limit 3`,
  );
  for (const c of ok) {
    console.log(`\n[${c.created_at}] ${c.lookup_key}`);
    try {
      await inspectAlpha(c.public_url);
    } catch (err: any) {
      console.log(`  ERROR: ${err?.message}`);
    }
  }
}

main()
  .catch((err) => {
    console.error("inspection failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
