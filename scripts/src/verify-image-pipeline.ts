import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.env.INIT_CWD ?? path.resolve(process.cwd(), "..", "..");

function read(rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

function assertIncludes(file: string, needle: string, message: string): void {
  const text = read(file);
  if (!text.includes(needle)) throw new Error(`${message} (${file})`);
}

function assertOrder(file: string, before: string, after: string, message: string): void {
  const text = read(file);
  const a = text.indexOf(before);
  const b = text.indexOf(after);
  if (a === -1 || b === -1 || a >= b) throw new Error(`${message} (${file})`);
}

function assertNotIncludes(file: string, needle: string, message: string): void {
  const text = read(file);
  if (text.includes(needle)) throw new Error(`${message} (${file})`);
}

assertIncludes(
  "artifacts/api-server/src/services/catalogService.ts",
  "assertNoPersistedBase64Image(profile, \"global_fragrances.profile_data\")",
  "catalog writes must reject base64 image data",
);

assertIncludes(
  "artifacts/api-server/src/routes/wardrobe.ts",
  "assertNoPersistedBase64Image",
  "wardrobe writes must reject base64 image data",
);

assertOrder(
  "artifacts/api-server/src/services/imagePipeline.ts",
  "getLatestReadyCachedImageByLookupKey",
  "searchSerperImageCandidates",
  "lookup cache must be checked before Serper search",
);

assertOrder(
  "artifacts/api-server/src/services/imagePipeline.ts",
  "getReadyCachedImageBySourceHash",
  "processSourceToWebp",
  "source cache must be checked before processing",
);

assertIncludes(
  "artifacts/api-server/src/services/imagePipeline.ts",
  "recordImageFailure",
  "failed image candidates must be recorded",
);

assertIncludes(
  "artifacts/api-server/src/routes/imageProxy.ts",
  "fetchExternalImage",
  "image proxy must use SSRF-safe downloader",
);

assertNotIncludes(
  "artifacts/api-server/src/routes/scent.ts",
  "import { removeBg",
  "refresh route must not return base64-producing removeBg output",
);

assertNotIncludes(
  "artifacts/api-server/src/routes/share.ts",
  "searchImageUrl",
  "share route must not repeat Serper calls on page load",
);

console.log("Image pipeline verification passed.");
