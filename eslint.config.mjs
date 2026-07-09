// Flat ESLint config (production-readiness F2). Intentionally NARROW: it starts
// scoped to artifacts/api-server/src with a small set of high-value correctness
// rules promoted to error, rather than turning on a recommended-type-checked
// preset that would drown CI in thousands of pre-existing warnings. Expand
// package-by-package (scent-cast next) as code is cleaned, not all at once.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Never lint build output, deps, generated code, or the SPA (not yet in scope).
    ignores: [
      "**/dist/**",
      "**/dist-beam/**",
      "**/dist/public/**",
      "**/node_modules/**",
      "**/*.tsbuildinfo",
      "lib/api-client-react/src/generated/**",
      "lib/api-zod/src/generated/**",
      "artifacts/scent-cast/**",
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
);
