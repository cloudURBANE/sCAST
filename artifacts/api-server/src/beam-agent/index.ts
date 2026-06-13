/**
 * Beam Agent — public module surface.
 *
 * Nothing in this module is wired into the running app until you call
 * `mountBeamAgent(app)` from app.ts (one line). Until then it is inert.
 */
export { beamAgentRouter, mountBeamAgent } from "./beamAgentRoutes.ts";
export { createBeamTools, type BeamToolDeps, type BeamCatalogHit } from "./beamTools.ts";
export { runBeamAgent, type RunBeamAgentInput } from "./beamAgentLoop.ts";
export { callClaude, isClaudeConfigured, DEFAULT_BEAM_MODEL } from "./claudeProvider.ts";
export {
  BEAM_LIMITS,
  redactEventForClient,
  packetFromFlatProfile,
  packetFromOwnedItem,
} from "./beamToolCore.ts";
export type * from "./types.ts";
