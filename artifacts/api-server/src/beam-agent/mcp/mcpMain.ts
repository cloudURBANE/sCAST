/**
 * Beam Agent — MCP server entrypoint.
 *
 * Boots the Beam MCP HTTP server that Hermes connects to. Reuses the api-server's
 * environment (DATABASE_URL etc.) because the tools call the same real services,
 * so run it with the SAME .env as the API. Binds to localhost by default — the
 * plan keeps this on a private network, never public.
 *
 * Built via build-beam-mcp.mjs → dist-beam/beam-mcp.mjs and run with
 * `pnpm --filter @workspace/api-server run beam:mcp`.
 */
import "dotenv/config";
import { createBeamMcpApp } from "./beamMcpServer.ts";

function main(): void {
  const secret = process.env.BEAM_AGENT_TOKEN_SECRET;
  if (!secret) {
    console.error(
      "[beam-mcp] FATAL: BEAM_AGENT_TOKEN_SECRET is not set. Generate a strong random " +
        "secret, put it in this server's env AND use the same value when minting tokens " +
        "(pnpm run beam:mint-token). Refusing to start without it.",
    );
    process.exit(1);
  }

  const port = Number(process.env.BEAM_MCP_PORT ?? 8848);
  const host = process.env.BEAM_MCP_HOST ?? "127.0.0.1";
  const app = createBeamMcpApp({ tokenSecret: secret });

  const server = app.listen(port, host, () => {
    console.log(`[beam-mcp] Beam MCP server listening on http://${host}:${port}/mcp`);
    console.log(`[beam-mcp] Health: http://${host}:${port}/healthz`);
  });

  const shutdown = (signal: string) => {
    console.log(`[beam-mcp] ${signal} received, shutting down.`);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
