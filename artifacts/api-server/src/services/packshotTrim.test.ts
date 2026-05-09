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

test("white-border trim: removes border without over-cropping content", async () => {
  const contentW = 100;
  const contentH = 140;
  const border = 40;

  const content = await sharp({
    create: {
      width: contentW,
      height: contentH,
      channels: 3,
      background: { r: 60, g: 80, b: 180 },
    },
  })
    .png()
    .toBuffer();

  const padded = await sharp(content)
    .extend({
      top: border,
      bottom: border,
      left: border,
      right: border,
      background: { r: 255, g: 255, b: 255 },
    })
    .png()
    .toBuffer();

  const r = await trimPackshotBuffer(padded, {
    background: "corners",
    output: { format: "jpeg", quality: 85 },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;

  // Border removed: output must be smaller than padded canvas.
  assert.ok(
    r.outW < contentW + 2 * border,
    `border not trimmed: width ${r.outW}`,
  );
  assert.ok(
    r.outH < contentH + 2 * border,
    `border not trimmed: height ${r.outH}`,
  );
  // No over-crop: output must still contain the full content object.
  assert.ok(
    r.outW >= contentW,
    `content over-cropped: width ${r.outW} < ${contentW}`,
  );
  assert.ok(
    r.outH >= contentH,
    `content over-cropped: height ${r.outH} < ${contentH}`,
  );
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
  // Sharp's color trim leaves a uniformly-near-background image untouched and
  // we surface that as "no_trim_benefit" — the user-visible behavior is the
  // same: caller passes through the original bytes.
  assert.ok(
    r.reason === "no_trim_benefit" || r.reason === "trim_too_aggressive",
    `unexpected reason for noise speck: ${r.reason}`,
  );
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

test("final WebP encode preserves alpha for transparent post-removal buffers", async () => {
  // Mirrors the imagePipeline.processSourceToWebp finalization chain when
  // backgroundRemoved=true: rotate → resize(inside) → ensureAlpha → webp.
  // Guards against regressions where alpha is silently dropped at encode.
  const subject = await sharp({
    create: { width: 200, height: 400, channels: 4, background: { r: 30, g: 40, b: 60, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const transparentCanvas = await sharp({
    create: { width: 600, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: subject, left: 200, top: 100 }])
    .png()
    .toBuffer();

  const webp = await sharp(transparentCanvas, { failOn: "truncated" })
    .rotate()
    .resize(768, 768, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .webp({ quality: 82, effort: 4 })
    .toBuffer();

  const outMeta = await sharp(webp).metadata();
  assert.equal(outMeta.format, "webp");
  assert.ok(outMeta.hasAlpha, "WebP output must preserve alpha");

  // Sample corners — they must be near-transparent.
  const { data, info } = await sharp(webp)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const C = info.channels;
  const corners = [
    [0, 0],
    [info.width - 1, 0],
    [0, info.height - 1],
    [info.width - 1, info.height - 1],
  ];
  for (const [x, y] of corners) {
    const i = (y * info.width + x) * C;
    const a = data[i + 3] ?? 255;
    assert.ok(a <= 32, `corner alpha at (${x},${y}) should be ~0, got ${a}`);
  }
});

test("non-BG path encode: opaque white packshot stays opaque WebP, no introduced alpha rim", async () => {
  // Mirrors the imagePipeline.processSourceToWebp finalization chain when
  // removeBackground=false: rotate → resize(inside) → webp (no ensureAlpha).
  const inner = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 90, g: 40, b: 120 } },
  })
    .png()
    .toBuffer();
  const padded = await sharp(inner)
    .extend({ top: 30, bottom: 30, left: 30, right: 30, background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();

  const webp = await sharp(padded, { failOn: "truncated" })
    .rotate()
    .resize(768, 768, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();

  const outMeta = await sharp(webp).metadata();
  assert.equal(outMeta.format, "webp");
  // An opaque packshot must not gain a phantom alpha channel from the encoder.
  assert.equal(outMeta.hasAlpha, false, "opaque input must stay opaque");
});

/*
 * Manual visual checklist (real catalog URLs): Wardrobe / Share with BottleImage after deploy —
 * white BG, gray BG, dark bottle, ultra-wide pack shot; confirm better fill when JPEG had large margins.
 */
