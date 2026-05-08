import { logger } from "../lib/logger";
import {
  PACKSHOT_TRIM_VERSION,
  trimPackshotBuffer,
  trimPackshotForBgService as trimPackshotForBgServiceCore,
  trimPackshotForImageProxy as trimPackshotForImageProxyCore,
  type PackshotTrimLog,
  type TrimPackshotOptions,
  type TrimPackshotResult,
} from "./packshotTrimCore";

export { PACKSHOT_TRIM_VERSION, trimPackshotBuffer, type TrimPackshotOptions, type TrimPackshotResult };

const serverLog: PackshotTrimLog = {
  debug: (obj, msg) => logger.debug(obj, msg),
  info: (obj, msg) => logger.info(obj, msg),
};

/** `/api/image-proxy?trim=1` — JPEG output for browsers. */
export async function trimPackshotForImageProxy(input: Buffer): Promise<
  { ok: true; buffer: Buffer; contentType: "image/jpeg" } | { ok: false }
> {
  return trimPackshotForImageProxyCore(input, serverLog);
}

/** BG removal fallback: PNG with alpha for the normalized bottle-artwork path in bgService. */
export async function trimPackshotForBgService(input: Buffer): Promise<Buffer | null> {
  return trimPackshotForBgServiceCore(input, serverLog);
}
