/**
 * Beam Agent — owner delegation-token minter (dev / owner-only mode).
 *
 * Mints a long-lived, read-only delegation token for ONE owner user, to paste into
 * Hermes' `~/.hermes/.env` as `BEAM_AGENT_TOKEN`. In production multi-user mode the
 * ScentBeam API mints a short-lived token per run instead (plan §12/§14) — this
 * script is the single-user shortcut to get Hermes talking to the tools quickly.
 *
 * Pure (token + scope logic only), so it runs directly:
 *   pnpm --filter @workspace/api-server run beam:mint-token
 *   # or: node --experimental-strip-types src/beam-agent/mcp/mintOwnerToken.ts --user <id> --tenant <id>
 *
 * The token is printed to STDOUT (just the token, for easy copy/pipe); guidance
 * goes to STDERR.
 */
import "dotenv/config";
import { signDelegationToken } from "./delegationToken.ts";
import { ALL_READ_SCOPES } from "./mcpContext.ts";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function main(): void {
  const secret = process.env.BEAM_AGENT_TOKEN_SECRET;
  const userId = arg("--user") ?? process.env.BEAM_OWNER_USER_ID;
  const tenantId = arg("--tenant") ?? process.env.BEAM_OWNER_TENANT_ID;
  const ttlDays = Number(arg("--ttl-days") ?? process.env.BEAM_OWNER_TOKEN_TTL_DAYS ?? 30);

  const problems: string[] = [];
  if (!secret) problems.push("BEAM_AGENT_TOKEN_SECRET (env)");
  if (!userId) problems.push("--user or BEAM_OWNER_USER_ID");
  if (!tenantId) problems.push("--tenant or BEAM_OWNER_TENANT_ID");
  if (problems.length > 0) {
    console.error(`[beam-mint] Missing required input(s): ${problems.join(", ")}`);
    console.error(
      "[beam-mint] Find your user/tenant ids in the users/tenants tables (or your app session).",
    );
    process.exit(1);
  }

  const token = signDelegationToken(
    {
      userId: userId!,
      tenantId: tenantId!,
      scope: ALL_READ_SCOPES,
      ttlSeconds: Math.max(1, Math.floor(ttlDays * 24 * 60 * 60)),
    },
    secret!,
  );

  console.error(
    `[beam-mint] Minted read-only owner token (user=${userId}, tenant=${tenantId}, ttl=${ttlDays}d).`,
  );
  console.error("[beam-mint] Add to ~/.hermes/.env:  BEAM_AGENT_TOKEN=<the token below>");
  console.log(token);
}

main();
