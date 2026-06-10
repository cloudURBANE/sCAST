import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { localWhiteChromaKey } from "./localChromaKey.ts";

const WIDTH = 40;
const HEIGHT = 40;

// Build a PNG from a per-pixel paint function returning [r,g,b].
async function makePng(paint: (x: number, y: number) => [number, number, number]): Promise<Buffer> {
  const data = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const [r, g, b] = paint(x, y);
      const p = (y * WIDTH + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = 255;
    }
  }
  return sharp(data, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toBuffer();
}

async function alphaAt(buffer: Buffer, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const p = (y * info.width + x) * info.channels;
  return data[p + info.channels - 1];
}

const inBlock = (x: number, y: number, lo: number, hi: number): boolean =>
  x >= lo && x < hi && y >= lo && y < hi;

test("clears the border-connected white plate but keeps the centred subject", async () => {
  // White everywhere except a dark 20x20 block in the centre.
  const png = await makePng((x, y) => (inBlock(x, y, 10, 30) ? [20, 20, 20] : [255, 255, 255]));
  const result = await localWhiteChromaKey(png);
  assert.ok(result, "expected a chroma-key result");
  assert.equal(await alphaAt(result!.buffer, 0, 0), 0); // corner background removed
  assert.equal(await alphaAt(result!.buffer, 20, 20), 255); // centre subject kept
  assert.ok(result!.removedFraction > 0.5 && result!.removedFraction < 0.9);
});

test("preserves a white island enclosed by the subject (no hole punched in a white label)", async () => {
  const png = await makePng((x, y) => {
    if (inBlock(x, y, 14, 26)) return [255, 255, 255]; // inner white island (e.g. label panel)
    if (inBlock(x, y, 8, 32)) return [30, 30, 30]; // dark body around it
    return [255, 255, 255]; // outer plate
  });
  const result = await localWhiteChromaKey(png);
  assert.ok(result, "expected a chroma-key result");
  assert.equal(await alphaAt(result!.buffer, 0, 0), 0); // outer plate removed
  assert.equal(await alphaAt(result!.buffer, 20, 20), 255); // islanded white survives
  assert.equal(await alphaAt(result!.buffer, 10, 10), 255); // dark body survives
});

test("declines when there is no white background to remove", async () => {
  const png = await makePng(() => [40, 40, 40]); // fully dark, no near-white border
  assert.equal(await localWhiteChromaKey(png), null);
});

test("declines a near-white-everywhere image rather than erasing it", async () => {
  const png = await makePng(() => [250, 250, 250]); // would remove ~100% -> bail
  assert.equal(await localWhiteChromaKey(png), null);
});
