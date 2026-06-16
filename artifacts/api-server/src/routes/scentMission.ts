import { Router } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { userFragrancesTable } from "@workspace/db/schema";
import {
  sanitizeScentMissionWardrobe,
  type ScentMissionWardrobeItem,
} from "@workspace/scent-weather-engine";
import { AuthRequest, optionalAuth } from "../middlewares/auth";
import { getTenantId } from "../middlewares/tenant";
import { rateLimitMiddleware } from "../lib/rateLimit";
import { logger } from "../lib/logger";
import { getScentFacts } from "../lib/scent-facts/engine";
import {
  executeScentMission,
  missionItemFromWardrobeRow,
  parseScentMissionRequest,
  type ScentMissionChatContext,
  type ScentMissionChatFn,
  type ScentMissionServiceDeps,
} from "../services/scentMissionService";

const router = Router();

// Mission turns can fan out to an LLM (chat) and the scent-facts research
// pipeline (resolution), so the route is throttled well below the general API
// surface. Per-IP fixed window, matching the reimagine route's approach.
const missionRateLimit = rateLimitMiddleware({ name: "scent-mission", limit: 30, windowMs: 5 * 60_000 });

const LLM_TIMEOUT_MS = 20_000;
const MAX_CHAT_WARDROBE_LINES = 20;

function chatPrompt(context: ScentMissionChatContext): string {
  const wardrobeLines = context.wardrobe
    .slice(0, MAX_CHAT_WARDROBE_LINES)
    .map((item) => {
      const traits = [...(item.families ?? []), ...(item.accords ?? [])].slice(0, 8);
      return `- ${item.name}${item.brand ? ` by ${item.brand}` : ""}${
        traits.length > 0 ? ` (${traits.join(", ")})` : ""
      }`;
    })
    .join("\n");

  const weather = context.weather;
  const weatherLine = [
    typeof weather.temperature_f === "number" ? `${Math.round(weather.temperature_f)}F` : null,
    typeof weather.humidity_percent === "number" ? `${Math.round(weather.humidity_percent)}% humidity` : null,
    weather.condition ?? null,
    typeof weather.uv_index === "number" ? `UV ${weather.uv_index}` : "UV unavailable",
  ]
    .filter(Boolean)
    .join(", ");
  const calibrationLine = [
    context.mission.calibration.destination ? `destination ${context.mission.calibration.destination}` : null,
    context.mission.calibration.energy ? `energy ${context.mission.calibration.energy}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return `
You are the Scent Mission agent for ScentBeam, a fragrance wardrobe app.
Answer the user's message in 1-3 short sentences. Be precise and concrete.
Only discuss fragrances, the user's vault, weather suitability, and the mission flow.
Never invent fragrances the user does not own. Do not use markdown.
If the user asks you to create or save a new collection, explain that this agent can calibrate taste and rank the current vault, but adding or saving new bottles still happens through the app's search and vault controls.

Today's conditions: ${weatherLine || "unknown"}.
Current calibration: ${calibrationLine || "not set"}.
User's vault:
${wardrobeLines || "(empty)"}

User message:
${context.userMessage}
`.trim();
}

async function chatWithOpenAi(context: ScentMissionChatContext): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: chatPrompt(context),
      temperature: 0.4,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI mission chat failed: ${res.status}`);
  const data: any = await res.json();
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text;
  const firstOutput = Array.isArray(data?.output) ? data.output[0] : null;
  const content = Array.isArray(firstOutput?.content) ? firstOutput.content[0] : null;
  if (typeof content?.text === "string" && content.text.trim()) return content.text;
  throw new Error("OpenAI mission chat returned empty output.");
}

async function chatWithGemini(context: ScentMissionChatContext): Promise<string> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    body: JSON.stringify({
      contents: [{ parts: [{ text: chatPrompt(context) }] }],
      generationConfig: { temperature: 0.4 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini mission chat failed: ${res.status}`);
  const data: any = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text === "string" && text.trim()) return text;
  throw new Error("Gemini mission chat returned empty output.");
}

/**
 * Pick an LLM chat backend from available keys; undefined means the service's
 * deterministic fallback handles every chat turn (local dev without keys).
 */
function resolveLlmChat(): ScentMissionChatFn | undefined {
  if (process.env.OPENAI_API_KEY) return chatWithOpenAi;
  if (process.env.GEMINI_API_KEY) return chatWithGemini;
  return undefined;
}

function resolveResearch(): ScentMissionServiceDeps["research"] {
  // getScentFacts needs an LLM key internally; without one it throws and the
  // service treats research as unavailable (the match still resolves).
  if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) return undefined;
  return (fragranceName: string) => getScentFacts({ fragranceName, save: false });
}

async function loadServerWardrobe(
  tenantId: string,
  userId: string,
): Promise<ScentMissionWardrobeItem[]> {
  const rows = await db
    .select({ id: userFragrancesTable.id, fragranceData: userFragrancesTable.fragranceData })
    .from(userFragrancesTable)
    .where(and(
      eq(userFragrancesTable.tenantId, tenantId),
      eq(userFragrancesTable.userId, userId),
    ))
    .orderBy(asc(userFragrancesTable.createdAt), asc(userFragrancesTable.id));

  return sanitizeScentMissionWardrobe(
    rows
      .map((row) => missionItemFromWardrobeRow(row.id, row.fragranceData))
      .filter((item) => item !== null),
  );
}

router.post("/scent-mission", missionRateLimit, optionalAuth, async (req: AuthRequest, res) => {
  const parsed = parseScentMissionRequest(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    // Signed-in users get their wardrobe loaded server-side; guests rely on
    // the sanitized summary they sent in `context.wardrobe`.
    let serverWardrobe: ScentMissionWardrobeItem[] | undefined;
    if (req.user) {
      serverWardrobe = await loadServerWardrobe(getTenantId(req), req.user.id);
    }

    const response = await executeScentMission(parsed.request, {
      serverWardrobe,
      deps: {
        llmChat: resolveLlmChat(),
        research: resolveResearch(),
      },
    });

    res.json(response);
  } catch (err) {
    logger.error({ err }, "scent-mission turn failed");
    res.status(500).json({ error: "Scent mission is temporarily unavailable. Try again." });
  }
});

export default router;
