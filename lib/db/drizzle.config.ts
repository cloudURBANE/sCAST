import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

function parseDatabaseUrl(url: string) {
  const parsed = new URL(url);
  const database = parsed.pathname.replace(/^\/+/, "");
  const sslOverride = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED
    ?.trim()
    .toLowerCase();
  const sslMode = parsed.searchParams.get("sslmode")?.toLowerCase();

  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
    ssl:
      sslOverride === "true"
        ? "verify-full"
        : sslOverride === "false" || (sslMode && sslMode !== "disable")
          ? "require"
          : undefined,
  };
}

export default defineConfig({
  schema: "./src/schema/*.ts",
  dialect: "postgresql",
  dbCredentials: parseDatabaseUrl(process.env.DATABASE_URL),
});
