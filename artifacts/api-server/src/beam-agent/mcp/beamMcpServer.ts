/**
 * Beam Agent — MCP tool server (HTTP, stateless) for Hermes.
 *
 * Exposes the EXISTING typed Beam tools (`createBeamTools`) over the Model Context
 * Protocol so Hermes Agent — with Claude selected as its reasoning model — can call
 * them. This is the "Beam MCP/tool service" box in the plan's target architecture
 * (§5.1, §6): a small TypeScript service on the private network that reuses the
 * app's real services and enforces all authority.
 *
 * Security model (plan §14):
 *   - Hermes presents a signed agent delegation token as `Authorization: Bearer …`.
 *   - This server VERIFIES it and derives tenant/user scope FROM the token.
 *   - The model never supplies tenant/user ids, and can only see/call tools its
 *     token's scopes unlock. No write tools exist in this phase.
 *
 * Transport: stateless Streamable HTTP — each POST builds a fresh MCP Server bound
 * to that request's verified context, so requests can never read each other's
 * scope. (MCP SDK v1.x; see https://ts.sdk.modelcontextprotocol.io/.)
 *
 * NOTE: this file imports `@modelcontextprotocol/sdk` (v1.x). Run
 * `pnpm --filter @workspace/api-server install` after it's added to package.json,
 * then `pnpm --filter @workspace/api-server run typecheck`.
 */
import express, { type Express, type Request, type Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { BeamRunContext, BeamToolDefinition } from "../types.ts";
import { createBeamTools } from "../beamTools.ts";
import { createBeamServiceDeps } from "./beamServiceDeps.ts";
import { verifyDelegationToken } from "./delegationToken.ts";
import { allowedToolNames, deriveRunContext, parseBearer } from "./mcpContext.ts";

const SERVER_NAME = "beam-tools";
const SERVER_VERSION = "0.1.0";
const MAX_BODY = "1mb";

export type BeamMcpAppOptions = {
  /** HMAC secret used to verify delegation tokens. Defaults to env. */
  tokenSecret?: string;
};

/** Build a JSON-RPC 2.0 error body so MCP clients parse a clean protocol error. */
function jsonRpcError(message: string, code = -32_000): Record<string, unknown> {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

/** Construct a per-request MCP server bound to one verified run context. */
function buildServerForContext(
  tools: BeamToolDefinition[],
  ctx: BeamRunContext,
  allowed: Set<string>,
): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  const byName = new Map<string, BeamToolDefinition>(tools.map((tool) => [tool.name, tool]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools
      .filter((tool) => allowed.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    if (!allowed.has(name)) {
      return { content: [{ type: "text", text: `Tool not permitted: ${name}` }], isError: true };
    }
    const def = byName.get(name);
    if (!def) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    try {
      const result = await def.handler(args, ctx);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : "tool error";
      return { content: [{ type: "text", text: `Tool failed: ${message}` }], isError: true };
    }
  });

  return server;
}

/**
 * Create the Express app for the Beam MCP HTTP server. The tools (and their
 * service deps) are built once and reused; only the verified context + allowed
 * tool set vary per request.
 */
export function createBeamMcpApp(options: BeamMcpAppOptions = {}): Express {
  const tokenSecret = options.tokenSecret ?? process.env.BEAM_AGENT_TOKEN_SECRET ?? "";
  const tools = createBeamTools(createBeamServiceDeps());

  const app = express();
  app.use(express.json({ limit: MAX_BODY }));

  // Unauthenticated readiness probe (no token, no tools).
  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, server: SERVER_NAME, version: SERVER_VERSION });
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    if (!tokenSecret) {
      res.status(503).json(jsonRpcError("Beam MCP server missing BEAM_AGENT_TOKEN_SECRET"));
      return;
    }

    const token = parseBearer(req.headers.authorization);
    if (!token) {
      res.status(401).json(jsonRpcError("Missing bearer token"));
      return;
    }
    const verified = verifyDelegationToken(token, tokenSecret);
    if (!verified.ok) {
      res.status(401).json(jsonRpcError(`Invalid token: ${verified.error}`));
      return;
    }

    const allowed = allowedToolNames(verified.claims.scope);
    if (allowed.size === 0) {
      res.status(403).json(jsonRpcError("Token grants no Beam tool scopes"));
      return;
    }

    const ctx = deriveRunContext(verified.claims);
    const server = buildServerForContext(tools, ctx, allowed);
    // Stateless: no session id, no server-initiated streams persisted between calls.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError("Internal MCP error"));
      }
      void err;
    }
  });

  // Stateless server: GET (SSE) and DELETE (session teardown) are not supported.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json(jsonRpcError("Method not allowed (stateless server)"));
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}
