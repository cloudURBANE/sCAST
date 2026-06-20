import { normalizeApiBaseUrl } from "@/lib/imageProxy";

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env?.VITE_API_BASE_URL as string | undefined);

function appApiUrl(path: string): string {
  return API_BASE_URL ? `${API_BASE_URL}${path}` : path;
}

async function apiErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.clone().json()) as { error?: unknown; detail?: unknown; message?: unknown };
    for (const value of [data.error, data.detail, data.message]) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch {
    try {
      const text = await res.text();
      if (text.trim()) return text.trim();
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export interface SubmitBeamPowerInput {
  postId: string;
  choice: string;
  score: number;
  runId: string;
}

export interface SubmitBeamPowerResult {
  postId: string;
  choice: string;
  fragranceId: string;
  score: number;
  beamPower: number;
  supporters: number;
  totalBeamPower: number;
}

export async function submitBeamPower(
  input: SubmitBeamPowerInput,
  authToken: string,
): Promise<SubmitBeamPowerResult> {
  const res = await fetch(appApiUrl(`/api/community/posts/${encodeURIComponent(input.postId)}/beam`), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      choice: input.choice,
      score: input.score,
      runId: input.runId,
    }),
  });

  if (!res.ok) {
    throw new Error(await apiErrorMessage(res, `Beam Power failed with HTTP ${res.status}`));
  }
  return (await res.json()) as SubmitBeamPowerResult;
}
