// Flat ESLint config (production-readiness F2). Intentionally NARROW: each
// package gets a small set of high-value correctness rules promoted to error,
// rather than a recommended-type-checked preset that would drown CI in
// thousands of pre-existing warnings. Scope so far: api-server + scent-cast
// (S6). Expand package-by-package as code is cleaned, not all at once.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    // Never lint build output, deps, or generated code.
    ignores: [
      "**/dist/**",
      "**/dist-beam/**",
      "**/dist/public/**",
      "**/node_modules/**",
      "**/*.tsbuildinfo",
      "lib/api-client-react/src/generated/**",
      "lib/api-zod/src/generated/**",
      "artifacts/mockup-sandbox/**",
      "**/.image-cache/**",
    ],
  },
  {
    // Scope: the API server's runtime source. Tests and standalone CLI scripts
    // are excluded — they legitimately use console and top-level side effects.
    files: ["artifacts/api-server/src/**/*.ts"],
    ignores: [
      "artifacts/api-server/src/**/*.test.ts",
      "artifacts/api-server/src/scripts/**",
      "artifacts/api-server/src/services/verifyPoofPaths.ts",
      "artifacts/api-server/src/lib/scent-facts/backtest.ts",
      "artifacts/api-server/src/beam-agent/mcp/mintOwnerToken.ts",
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    // No broad preset on purpose — only the rules we intend to enforce, so the
    // gate is meaningful and stays green. The TypeScript compiler already owns
    // undefined-var / unused / type checks via `pnpm run typecheck`.
    rules: {
      // Flagship correctness rule: an un-awaited promise silently swallows
      // errors and reorders effects — the class of bug that most needs a gate.
      // Currently zero violations in this scope, so it starts green as an error.
      "@typescript-eslint/no-floating-promises": "error",
      // The console sweep (A6) is not fully complete in this package, so keep
      // this a WARNING for now (visible, non-blocking). Flip to "error" once the
      // remaining runtime console.* sites are moved to the pino logger.
      "no-console": "warn",
    },
  },
  {
    // Scope: the SPA's runtime source (readiness gap S6) — where an un-awaited
    // promise or stray console most often ships. Same narrow-rules approach as
    // the api-server block above.
    files: ["artifacts/scent-cast/src/**/*.ts", "artifacts/scent-cast/src/**/*.tsx"],
    ignores: [
      "artifacts/scent-cast/src/**/*.test.ts",
      "artifacts/scent-cast/src/**/*.test.tsx",
      // The service worker builds under its own tsconfig (WebWorker lib), so the
      // project service can't type it here.
      "artifacts/scent-cast/src/sw.ts",
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin, "react-hooks": reactHooks },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      // A hook called conditionally/in a loop is a guaranteed runtime bug class.
      "react-hooks/rules-of-hooks": "error",
      // Warn-only: several call sites carry deliberate, commented disable
      // directives for this rule; enforcing it wholesale would churn working
      // effect code. The plugin being registered also makes those existing
      // `eslint-disable react-hooks/exhaustive-deps` comments resolvable.
      "react-hooks/exhaustive-deps": "warn",
      // Deliberate debug/diagnostic consoles exist in the SPA (crash tracing,
      // PWA update logging); keep visibility without blocking while they're
      // migrated to a leveled reporter.
      "no-console": "warn",
    },
  },
);
