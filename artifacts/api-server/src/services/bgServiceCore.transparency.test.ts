import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { hasOpaqueLightBackground, isEffectivelyTransparent } from "./bgServiceCore.ts";

// Regression coverage for the image-pipeline transparency / white-bg guard fix.
//   - isEffectivelyTransparent gained a CENTER/SUBJECT-region check so a Poof
//     "ghost" whose only opaque pixels are an off-center speck (whole-image mean
//     just above the 5.0 floor) is still detected as empty.
//   - hasOpaqueLightBackground is now run on EVERY Poof 200 (not just
//     type=product), so its contract is exercised here directly.

async function transparentCanvas(size = 256): Promise<Buffer> {
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
}

test("isEffectivelyTransparent: fully transparent buffer is empty", async () => {
  assert.equal(await isEffectivelyTransparent(await transparentCanvas()), true);
});

test("isEffectivelyTransparent: opaque RGB (no alpha) is not empty", async () => {
  const opaque = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 90, g: 40, b: 120 } },
  })
    .png()
    .toBuffer();
  assert.equal(await isEffectivelyTransparent(opaque), false);
});

test("isEffectivelyTransparent: centered subject is not empty", async () => {
  // A centered opaque block — a real packshot shape — must survive.
  const subject = await sharp({
    create: { width: 120, height: 120, channels: 4, background: { r: 30, g: 90, b: 120, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const composed = await sharp({
    create: { width: 256, height: 256, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: subject, left: 68, top: 68 }])
    .png()
    .toBuffer();
  assert.equal(await isEffectivelyTransparent(composed), false);
});

test("isEffectivelyTransparent: off-center speck ghost is detected as empty", async () => {
  // A small fully-opaque speck tucked in the corner. The whole-image alpha mean
  // can clear the 5.0 floor while the CENTER region is empty — the old
  // whole-image-only guard missed this; the center-region guard catches it.
  const speck = await sharp({
    create: { width: 22, height: 22, channels: 4, background: { r: 200, g: 10, b: 10, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const ghost = await sharp({
    create: { width: 256, height: 256, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: speck, left: 4, top: 4 }])
    .png()
    .toBuffer();
  assert.equal(await isEffectivelyTransparent(ghost), true);
});

test("hasOpaqueLightBackground: opaque white rectangle is flagged", async () => {
  // The Poof failure mode the all-paths guard now catches: a 200 that left the
  // original white product-shot rectangle intact.
  const white = await sharp({
    create: { width: 200, height: 200, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .png()
    .toBuffer();
  assert.equal(await hasOpaqueLightBackground(white), true);
});

test("hasOpaqueLightBackground: transparent border is not flagged", async () => {
  // A correctly cut-out packshot has a transparent outer ring around a centered
  // subject — it must NOT be flagged as a preserved white background.
  const subject = await sharp({
    create: { width: 100, height: 100, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const cutout = await sharp({
    create: { width: 256, height: 256, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: subject, left: 78, top: 78 }])
    .png()
    .toBuffer();
  assert.equal(await hasOpaqueLightBackground(cutout), false);
});
