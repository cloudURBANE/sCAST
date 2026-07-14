// Offline verification of the Poof HTTP outcomes that flow through
// `removeBgBuffer`. Runs entirely against a stubbed `axios.post` so it never
// touches Poof's quota.
//
// Run: pnpm --filter @workspace/scripts run verify:poof-paths

import axios from "axios";
import sharp from "sharp";
import { removeBgBuffer, type RemoveBgBufferResult } from "./bgService";

process.env.REMOVE_BG_API_KEY = "stub-key-for-verification";
process.env.LOG_LEVEL = "fatal";

type Expectation = Pick<
  RemoveBgBufferResult,
  "backgroundRemoved" | "removeBgStatus" | "removeBgReason"
>;

const failures: string[] = [];

function expect(label: string, actual: Expectation, expected: Expectation): void {
  const ok =
    actual.backgroundRemoved === expected.backgroundRemoved &&
    actual.removeBgStatus === expected.removeBgStatus &&
    actual.removeBgReason === expected.removeBgReason;
  if (ok) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures.push(label);
  console.log(`  FAIL  ${label}`);
  console.log(`    expected ${JSON.stringify(expected)}`);
  console.log(`    actual   ${JSON.stringify(actual)}`);
}

function makeOpaqueWhitePng(): Promise<Buffer> {
  return sharp({
    create: { width: 256, height: 256, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toBuffer();
}

function makeFullyTransparentPng(): Promise<Buffer> {
  return sharp({
    create: { width: 256, height: 256, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
}

// A "real" packshot: a colored subject on a transparent canvas — what a
// well-behaved Poof success looks like after background removal.
async function makeRealPackshotPng(): Promise<Buffer> {
  const bottle = await sharp({
    create: { width: 64, height: 160, channels: 4, background: { r: 30, g: 90, b: 120, alpha: 1 } },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: 256, height: 256, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: bottle, left: 96, top: 48 }])
    .png()
    .toBuffer();
}

async function withStubbedPoof(
  response: { status: number; data: Buffer },
  fn: () => Promise<void>,
): Promise<void> {
  const original = axios.post;
  (axios.post as unknown) = async (..._args: unknown[]) => response;
  try {
    await fn();
  } finally {
    axios.post = original;
  }
}

async function pluck(buffer: Buffer): Promise<Expectation> {
  const r = await removeBgBuffer(buffer);
  return {
    backgroundRemoved: r.backgroundRemoved,
    removeBgStatus: r.removeBgStatus,
    removeBgReason: r.removeBgReason,
  };
}

async function run(): Promise<void> {
  // A valid input image handed to removeBgBuffer for every case. Bytes only
  // need to be sharp-decodable so the upload-buffer pipeline succeeds — what
  // the stub returns as the Poof response is what each case actually exercises.
  const input = await makeRealPackshotPng();

  console.log("\nCase 1 — Poof 200 with a transparent-background packshot:");
  await withStubbedPoof({ status: 200, data: await makeRealPackshotPng() }, async () => {
    expect(
      "real packshot 200 → removed",
      await pluck(input),
      { backgroundRemoved: true, removeBgStatus: "removed", removeBgReason: "removed" },
    );
  });

  console.log("\nCase 2 — Poof 200 with a fully transparent (empty) PNG:");
  await withStubbedPoof({ status: 200, data: await makeFullyTransparentPng() }, async () => {
    expect(
      "fully-transparent 200 → fallback (poof_empty_output)",
      await pluck(input),
      { backgroundRemoved: false, removeBgStatus: "fallback", removeBgReason: "poof_empty_output" },
    );
  });

  console.log("\nCase 3 — Poof 200 with an opaque white background:");
  console.log("  WS-12 re-added the hasOpaqueLightBackground guard on every 200:");
  console.log("  a preserved white plate is rejected and the trim fallback is used.");
  await withStubbedPoof({ status: 200, data: await makeOpaqueWhitePng() }, async () => {
    // The input packshot has a transparent border, so the local chroma-key
    // rescue declines and the result is the border-trim fallback carrying the
    // Poof rejection reason.
    expect(
      "opaque-white 200 → fallback (poof_white_background)",
      await pluck(input),
      { backgroundRemoved: false, removeBgStatus: "fallback", removeBgReason: "poof_white_background" },
    );
  });

  console.log("\nCase 4 — Poof 429 rate limited:");
  await withStubbedPoof({ status: 429, data: Buffer.alloc(0) }, async () => {
    expect(
      "429 → fallback (poof_rate_limited)",
      await pluck(input),
      { backgroundRemoved: false, removeBgStatus: "fallback", removeBgReason: "poof_rate_limited" },
    );
  });

  console.log("");
  if (failures.length > 0) {
    console.error(`${failures.length} failure(s): ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("All Poof-path expectations met (0 live calls made).");
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
