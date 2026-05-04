import { logger } from "../lib/logger";
import { searchSerperImageUrl } from "./serperService";

export async function searchImageUrl(query: string): Promise<string> {
  const bestUrl = await searchSerperImageUrl(query);
  if (!bestUrl) {
    logger.info({ query }, "[imageService] no image found from Serper");
    return "";
  }
  return bestUrl;
}
