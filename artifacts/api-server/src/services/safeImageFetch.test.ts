import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeMarkupOrText } from "./safeImageFetch.ts";

test("markup detection flags HTML / WAF pages disguised as images", () => {
  assert.equal(looksLikeMarkupOrText(Buffer.from("<!DOCTYPE html><html>...")), true);
  assert.equal(looksLikeMarkupOrText(Buffer.from("<html><body>blocked</body></html>")), true);
  assert.equal(looksLikeMarkupOrText(Buffer.from("<?xml version=\"1.0\"?><error/>")), true);
});

test("markup detection skips a leading BOM and ASCII whitespace before the '<'", () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  assert.equal(looksLikeMarkupOrText(Buffer.concat([bom, Buffer.from("<html>")])), true);
  assert.equal(looksLikeMarkupOrText(Buffer.from("  \r\n\t<html>")), true);
});

test("markup detection leaves genuine image byte signatures alone", () => {
  // JPEG (FF D8 FF), PNG (89 50 4E 47), GIF ("GIF8"), WEBP ("RIFF"…"WEBP").
  assert.equal(looksLikeMarkupOrText(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), false);
  assert.equal(looksLikeMarkupOrText(Buffer.from([0x89, 0x50, 0x4e, 0x47])), false);
  assert.equal(looksLikeMarkupOrText(Buffer.from("GIF89a")), false);
  assert.equal(
    looksLikeMarkupOrText(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    false,
  );
});

test("markup detection treats an empty buffer as not-markup (size check handles emptiness)", () => {
  assert.equal(looksLikeMarkupOrText(Buffer.alloc(0)), false);
});
