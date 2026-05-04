import { logger } from "../lib/logger";
import { searchSerperImageUrl } from "./serperService";

export async function searchImageUrl(query: string): Promise<string> {
  const bestUrl = await searchSerperImageUrl(query);
  if (!bestUrl) {
    // #region agent log
    fetch('http://127.0.0.1:7745/ingest/484c0150-587d-4568-9bd7-b30ce5dec585',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4aee09'},body:JSON.stringify({sessionId:'4aee09',runId:'pre-fix',hypothesisId:'H2',location:'imageService.ts:searchImageUrl:noResult',message:'No Serper image selected',data:{queryLength:query.length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    logger.info({ query }, "[imageService] no image found from Serper");
    return "";
  }
  return bestUrl;
}
