import assert from "node:assert/strict";
import test from "node:test";
import {
  looksLikeMarkupOrText,
  isPrivateIpAddress,
  parseAndValidateExternalImageUrl,
} from "./safeImageFetch.ts";

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

test("isPrivateIpAddress blocks IPv4 private, loopback, metadata, CGNAT, and reserved ranges", () => {
  for (const ip of [
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254", // cloud metadata
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "224.0.0.1", // multicast
    "255.255.255.255", // broadcast / reserved
  ]) {
    assert.equal(isPrivateIpAddress(ip), true, `${ip} should be private`);
  }
});

test("isPrivateIpAddress allows ordinary public IPv4", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
    assert.equal(isPrivateIpAddress(ip), false, `${ip} should be public`);
  }
});

test("isPrivateIpAddress blocks IPv4-mapped IPv6 that reaches private hosts (A2 SSRF)", () => {
  // The exploitable cases from the audit: mapped metadata/loopback/private ranges
  // must be judged by their embedded IPv4, in both dotted and hex-mapped forms.
  for (const ip of [
    "::ffff:169.254.169.254", // dotted, cloud metadata
    "::ffff:a9fe:a9fe", // hex form of 169.254.169.254
    "::ffff:127.0.0.1", // mapped loopback
    "::ffff:10.0.0.1", // mapped private
    "::ffff:192.168.1.1",
    "::ffff:100.64.0.1", // mapped CGNAT
  ]) {
    assert.equal(isPrivateIpAddress(ip), true, `${ip} should be private`);
  }
});

test("isPrivateIpAddress blocks native IPv6 loopback, ULA, link-local, and multicast", () => {
  for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) {
    assert.equal(isPrivateIpAddress(ip), true, `${ip} should be private`);
  }
});

test("isPrivateIpAddress allows a mapped public IPv4 and global IPv6", () => {
  assert.equal(isPrivateIpAddress("::ffff:8.8.8.8"), false);
  assert.equal(isPrivateIpAddress("2606:4700:4700::1111"), false); // Cloudflare public v6
});

test("parseAndValidateExternalImageUrl rejects bracketed IPv6 literals for private hosts (A1/A2)", () => {
  // URL.hostname keeps IPv6 literals bracketed; the guard must still recognize them.
  for (const url of [
    "http://[::1]/x.png",
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://[::ffff:127.0.0.1]/x.png",
    "http://[fd00::1]/x.png",
  ]) {
    assert.throws(() => parseAndValidateExternalImageUrl(url), /Private network|Local image/);
  }
});

test("parseAndValidateExternalImageUrl still accepts ordinary public hosts", () => {
  assert.equal(parseAndValidateExternalImageUrl("https://example.com/a.png").hostname, "example.com");
  assert.equal(
    parseAndValidateExternalImageUrl("http://[2606:4700:4700::1111]/a.png").hostname,
    "[2606:4700:4700::1111]",
  );
});
