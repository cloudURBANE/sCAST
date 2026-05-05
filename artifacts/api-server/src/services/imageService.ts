import { logger } from "../lib/logger";
import type { SerperRefineMode } from "./imageSolvers";
import { searchSerperImageUrl } from "./serperService";

export async function searchImageUrl(query: string, options?: { refine?: SerperRefineMode }): Promise<string> {
  const bestUrl = await searchSerperImageUrl(query, options);
  if (!bestUrl) {
    logger.info({ query }, "[imageService] no image found from Serper");
    return "";
  }
  return bestUrl;
}
