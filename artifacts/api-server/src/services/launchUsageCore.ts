export interface SqlConnection {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, any>[] }>;
}
// Caller owns transaction. Serialize the global counter before reading either
// quota so concurrent requests and replicas cannot oversubscribe reservations.
export async function reserveUsage(
  c: SqlConnection,
  input: {
    scope: string;
    feature: string;
    limit: number;
    cost: number;
    globalLimit: number;
  },
): Promise<"ok" | "monthly_allowance" | "service_budget"> {
  await c.query("SELECT pg_advisory_xact_lock(72401931)");
  const {
    rows: [{ month }],
  } = await c.query(
    "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM') AS month",
  );
  const { rows } = await c.query(
    "SELECT scope, calls, reserved_microusd FROM launch_usage WHERE month=$1 AND ((scope='global' AND feature='all') OR (scope=$2 AND feature=$3))",
    [month, input.scope, input.feature],
  );
  const global = rows.find((r) => r.scope === "global");
  const user = rows.find((r) => r.scope === input.scope);
  if ((user?.calls ?? 0) >= input.limit) return "monthly_allowance";
  if ((global?.reserved_microusd ?? 0) + input.cost > input.globalLimit)
    return "service_budget";
  for (const [scope, feature] of [
    ["global", "all"],
    [input.scope, input.feature],
  ]) {
    await c.query(
      `INSERT INTO launch_usage (month,scope,feature,calls,reserved_microusd) VALUES ($1,$2,$3,1,$4)
      ON CONFLICT (month,scope,feature) DO UPDATE SET calls=launch_usage.calls+1, reserved_microusd=launch_usage.reserved_microusd+$4`,
      [month, scope, feature, input.cost],
    );
  }
  return "ok";
}
