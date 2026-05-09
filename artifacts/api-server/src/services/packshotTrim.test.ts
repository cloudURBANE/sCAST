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
    create: {
      width: 100,
      height: 100,
      channels: 3,
      background: { r: 90, g: 40, b: 120 },
    },
  })
    .png()
    .toBuffer();

  const padded = await sharp(inner)
    .extend({
      top: 15,
      bottom: 15,
      left: 15,
      right: 15,
      background: { r: 255, g: 255, b: 255 },
    })
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

test("heavily padded centered object trims to the visible packshot", async () => {
  const tiny = await sharp({
    create: {
      width: 40,
      height: 40,
      channels: 3,
      background: { r: 200, g: 50, b: 50 },
    },
  })
    .png()
    .toBuffer();

  const hugePad = await sharp(tiny)
    .extend({
      top: 200,
      bottom: 200,
      left: 200,
      right: 200,
      background: { r: 255, g: 255, b: 255 },
    })
    .png()
    .toBuffer();

  const r = await trimPackshotBuffer(hugePad, {
    background: "corners",
    output: { format: "jpeg", quality: 85 },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.outW <= 62, `expected tight crop width, got ${r.outW}`);
  assert.ok(r.outH <= 62, `expected tight crop height, got ${r.outH}`);
});

test("bg-service path trims heavily padded centered object", async () => {
  const tiny = await sharp({
    create: {
      width: 40,
      height: 40,
      channels: 3,
      background: { r: 200, g: 50, b: 50 },
    },
  })
    .png()
    .toBuffer();

  const hugePad = await sharp(tiny)
    .extend({
      top: 200,
      bottom: 200,
      left: 200,
      right: 200,
      background: { r: 255, g: 255, b: 255 },
    })
    .png()
    .toBuffer();

  const out = await trimPackshotForBgService(hugePad);
  assert.ok(out);
  const meta = await sharp(out).metadata();
  assert.ok(meta.width! <= 62, `expected tight crop width, got ${meta.width}`);
  assert.ok(
    meta.height! <= 62,
    `expected tight crop height, got ${meta.height}`,
  );
});

test("transparent padding trims by alpha and preserves PNG alpha", async () => {
  const bottle = await sharp({
    create: {
      width: 44,
      height: 132,
      channels: 4,
      background: { r: 30, g: 90, b: 120, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  const padded = await sharp({
    create: {
      width: 220,
      height: 220,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: bottle, left: 88, top: 44 }])
    .png()
    .toBuffer();

  const out = await trimPackshotForBgService(padded);
  assert.ok(out);
  const meta = await sharp(out).metadata();
  assert.ok(meta.hasAlpha);
  assert.ok(
    meta.width! <= 58,
    `expected tight alpha crop width, got ${meta.width}`,
  );
  assert.ok(
    meta.height! <= 146,
    `expected tight alpha crop height, got ${meta.height}`,
  );
});

test("off-white and gray vendor backgrounds trim from sampled corners", async () => {
  const bottle = await sharp({
    create: {
      width: 90,
      height: 160,
      channels: 3,
      background: { r: 44, g: 36, b: 31 },
    },
  })
    .png()
    .toBuffer();

  const padded = await sharp({
    create: {
      width: 420,
      height: 420,
      channels: 3,
      background: { r: 216, g: 216, b: 212 },
    },
  })
    .composite([{ input: bottle, left: 165, top: 130 }])
    .png()
    .toBuffer();

  const out = await trimPackshotForBgService(padded);
  assert.ok(out);
  const meta = await sharp(out).metadata();
  assert.ok(
    meta.width! <= 100,
    `expected sampled-background crop width, got ${meta.width}`,
  );
  assert.ok(
    meta.height! <= 170,
    `expected sampled-background crop height, got ${meta.height}`,
  );
});

test("ultra-skinny bottle in a large vendor canvas still trims", async () => {
  const bottle = await sharp({
    create: {
      width: 32,
      height: 240,
      channels: 3,
      background: { r: 55, g: 55, b: 62 },
    },
  })
    .png()
    .toBuffer();

  const padded = await sharp({
    create: {
      width: 1000,
      height: 1000,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([{ input: bottle, left: 484, top: 380 }])
    .png()
    .toBuffer();

  const r = await trimPackshotBuffer(padded, {
    background: "corners",
    output: { format: "jpeg", quality: 85 },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.outW <= 40, `expected tight skinny crop width, got ${r.outW}`);
  assert.ok(r.outH <= 256, `expected tight skinny crop height, got ${r.outH}`);
});

test("isolated noise speck is not promoted to a packshot crop", async () => {
  const speck = await sharp({
    create: {
      width: 200,
      height: 200,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: 1,
            height: 1,
            channels: 3,
            background: { r: 0, g: 0, b: 0 },
          },
        })
          .png()
          .toBuffer(),
        left: 100,
        top: 100,
      },
    ])
    .png()
    .toBuffer();

  const r = await trimPackshotBuffer(speck, {
    background: "corners",
    output: { format: "jpeg", quality: 85 },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "no_reliable_crop");
});

test("resize cap: very large raster still processes", async () => {
  const bar = await sharp({
    create: {
      width: 4100,
      height: 120,
      channels: 3,
      background: { r: 80, g: 120, b: 200 },
    },
  })
    .png()
    .toBuffer();

  const huge = await sharp({
    create: {
      width: 4200,
      height: 180,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
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

test("resize of transparent PNG with white-transparent fill: no white halo (libvips auto-premults)", async () => {
  // libvips 8.15.x (sharp 0.33.x) handles premultiplied alpha internally during resize.
  // This guards against regressions where an upgrade or swap of the underlying image library
  // could reintroduce white halo at dark-subject / transparent-background boundaries.
  // Input: 900×300 PNG with white-transparent fill (r=255,g=255,b=255,a=0) + dark subject.
  // Resize to ≤708 triggers interpolation at the boundary where white-transparent meets opaque.
  const subject = await sharp({
    create: { width: 860, height: 260, channels: 4, background: { r: 30, g: 30, b: 30, alpha: 1 } },
  }).png().toBuffer();

  const canvas = await sharp({
    create: { width: 900, height: 300, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } },
  })
    .composite([{ input: subject, left: 20, top: 20 }])
    .png()
    .toBuffer();

  const resized = await sharp(canvas)
    .resize(708, 708, { fit: "inside", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .png()
    .toBuffer();

  const { data, info } = await sharp(resized).raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const C = info.channels;

  let halosFound = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * C;
      const a = data[i + 3] ?? 0;
      if (a > 10 && a < 220) {
        const r = data[i] ?? 0;
        const g = data[i + 1] ?? 0;
        const b = data[i + 2] ?? 0;
        if (r > 120 && g > 120 && b > 120) halosFound++;
      }
    }
  }
  assert.equal(halosFound, 0, `White halo pixels at transparent boundary: ${halosFound}`);
});

/*
 * Manual visual checklist (real catalog URLs): Wardrobe / Share with BottleImage after deploy —
 * white BG, gray BG, dark bottle, ultra-wide pack shot; confirm better fill when JPEG had large margins.
 */
