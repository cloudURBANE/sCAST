import test from "node:test";
import assert from "node:assert/strict";
import { resolveSslConfig } from "./sslConfig.ts";

const PLAIN_URL = "postgresql://u:p@localhost:5432/db";
const SSL_URL = "postgresql://u:p@db.example.com:5432/db?sslmode=require";
const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

test("sslConfig: no sslmode and no env → no TLS", () => {
  const { ssl, warning } = resolveSslConfig(PLAIN_URL, {});
  assert.equal(ssl, undefined);
  assert.equal(warning, undefined);
});

test("sslConfig: sslmode=disable → no TLS", () => {
  const { ssl } = resolveSslConfig(`${PLAIN_URL}?sslmode=disable`, {});
  assert.equal(ssl, undefined);
});

test("sslConfig: inline PEM CA → verified TLS with that CA", () => {
  const { ssl, warning } = resolveSslConfig(SSL_URL, { DATABASE_SSL_CA: PEM });
  assert.deepEqual(ssl, { rejectUnauthorized: true, ca: PEM });
  assert.equal(warning, undefined);
});

test("sslConfig: inline PEM with literal \\n escapes is unescaped", () => {
  const escaped = PEM.replaceAll("\n", "\\n");
  const { ssl } = resolveSslConfig(SSL_URL, { DATABASE_SSL_CA: escaped });
  assert.deepEqual(ssl, { rejectUnauthorized: true, ca: PEM });
});

test("sslConfig: CA as file path is read from disk", () => {
  const reads: string[] = [];
  const { ssl } = resolveSslConfig(
    SSL_URL,
    { DATABASE_SSL_CA: "/etc/certs/supabase-ca.pem" },
    (p) => {
      reads.push(p);
      return PEM;
    },
  );
  assert.deepEqual(reads, ["/etc/certs/supabase-ca.pem"]);
  assert.deepEqual(ssl, { rejectUnauthorized: true, ca: PEM });
});

test("sslConfig: CA wins over a stale rejectUnauthorized=false override", () => {
  const { ssl } = resolveSslConfig(SSL_URL, {
    DATABASE_SSL_CA: PEM,
    DATABASE_SSL_REJECT_UNAUTHORIZED: "false",
  });
  assert.deepEqual(ssl, { rejectUnauthorized: true, ca: PEM });
});

test("sslConfig: explicit override=true verifies against system store", () => {
  const { ssl, warning } = resolveSslConfig(SSL_URL, {
    DATABASE_SSL_REJECT_UNAUTHORIZED: "true",
  });
  assert.deepEqual(ssl, { rejectUnauthorized: true });
  assert.equal(warning, undefined);
});

test("sslConfig: explicit override=false relaxes without warning (local-dev hatch)", () => {
  const { ssl, warning } = resolveSslConfig(SSL_URL, {
    DATABASE_SSL_REJECT_UNAUTHORIZED: "false",
  });
  assert.deepEqual(ssl, { rejectUnauthorized: false });
  assert.equal(warning, undefined);
});

test("sslConfig: sslmode without CA stays relaxed but WARNS", () => {
  const { ssl, warning } = resolveSslConfig(SSL_URL, {});
  assert.deepEqual(ssl, { rejectUnauthorized: false });
  assert.match(warning ?? "", /NOT verified/);
});
