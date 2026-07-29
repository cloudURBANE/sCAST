export type ImageCandidateProvider = "engine" | "serper";

export type ImageCandidateSearch<T> = () => Promise<T[]>;

export type ImageCandidateDispatchResult<T> = {
  candidates: T[];
  fallbackUsed: boolean;
};

export type SerperKeyFailureAction = "cooldown" | "retire" | "skip";

/**
 * Serper currently reports depleted accounts as HTTP 400 with a human-readable
 * message, while older responses used authorization/payment status codes.
 * Normalize both shapes so the key pool does not retry a dead key forever.
 */
export function classifySerperKeyFailure(
  status: number,
  message: unknown,
): SerperKeyFailureAction {
  if (status === 429) return "cooldown";
  if (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    (status === 400 && typeof message === "string" && /not enough credits/i.test(message))
  ) {
    return "retire";
  }
  return "skip";
}

/**
 * Prefer the configured image provider, but keep new-fragrance images available
 * when the engine provider soft-fails to an empty candidate list. The engine
 * adapter deliberately normalizes transport errors, non-200 responses, and
 * scorer-rejected responses to `[]`; with Serper selected directly there is no
 * engine call at all.
 */
export async function dispatchImageCandidateSearch<T>(input: {
  provider: ImageCandidateProvider;
  searchEngine: ImageCandidateSearch<T>;
  searchSerper: ImageCandidateSearch<T>;
}): Promise<ImageCandidateDispatchResult<T>> {
  if (input.provider === "serper") {
    return {
      candidates: await input.searchSerper(),
      fallbackUsed: false,
    };
  }

  const engineCandidates = await input.searchEngine();
  if (engineCandidates.length > 0) {
    return { candidates: engineCandidates, fallbackUsed: false };
  }

  return {
    candidates: await input.searchSerper(),
    fallbackUsed: true,
  };
}
