import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  PACKSHOT_TRIM_VERSION,
  trimPackshotBuffer,
  trimPackshotForBgService,
  trimPackshotForImageProxy,
} from "./packshotTrimCore.ts";

test("PACKSHOT_TRIM_VERSION is a positive int", () => {
  assert.equal(typeof PACKSHOT_TRIM_VERSION, "number");
  assert.ok(PACKSHOT_TRIM_VERSION >= 1);
});

test("proxied pipeline: trims uniform white padding (JPEG)", async () => {
  const inner = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 90, g: 40, b: 120 } },
  })
    .png()
    .toBuffer();

  const padded = await sharp(inner)
    .extend({ top: 15, bottom: 15, left: 15, right: 15, background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();

  const metaBefore = await sharp(padded).metadata();
  const r = await trimPackshotForImageProxy(padded);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const metaAfter = await sharp(r.buffer).metadata();
  assert.ok(metaAfter.width! < metaBefore.width!);
  assert.ok(metaAfter.height! < metaBefore.height!);
  assert.equal(r.contentType, "image/jpeg");
});

test("oversized input is rejected", async () => {
  const big = Buffer.alloc(12 * 1024 * 1024 + 1, 0);
  const r = await trimPackshotBuffer(big, {
    background: "corners",
    output: { format: "jpeg", quality: 85 },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "oversized_input");
});

test("svg buffer passes through (not trimmed)", async () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="white"/></svg>',
  );
  const r = await trimPackshotBuffer(svg, {
    background: "corners",
    output: { format: "jpeg", quality: 85 },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "svg_pass_through");
});

test("aggressive trim is rejected (small centered object)", async () => {
  const tiny = await sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .png()
    .toBuffer();

  const hugePad = await sharp(tiny)
    .extend({ top: 200, bottom: 200, left: 200, right: 200, background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();

  const r = await trimPackshotBuffer(hugePad, {
    background: "corners",
    output: { format: "jpeg", quality: 85 },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "trim_too_aggressive");
});

test("bg-service path returns null when trim too aggressive", async () => {
  const tiny = await sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .png()
    .toBuffer();

  const hugePad = await sharp(tiny)
    .extend({ top: 200, bottom: 200, left: 200, right: 200, background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();

  const out = await trimPackshotForBgService(hugePad);
  assert.equal(out, null);
});

test("resize cap: very large raster still processes", async () => {
  const bar = await sharp({
    create: { width: 4100, height: 120, channels: 3, background: { r: 80, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();

  const huge = await sharp({
    create: { width: 4200, height: 180, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([{ input: bar, left: 50, top: 30 }])
    .png()
    .toBuffer();

  const r = await trimPackshotBuffer(huge, {
    background: "corners",
    output: { format: "jpeg", quality: 85 },
  });
  assert.equal(r.ok, true);
});

/*
 * Manual visual checklist (real catalog URLs): Wardrobe / Share with BottleImage after deploy —
 * white BG, gray BG, dark bottle, ultra-wide pack shot; confirm better fill when JPEG had large margins.
 */
