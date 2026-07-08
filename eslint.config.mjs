// Flat ESLint config — production-readiness F2.
//
// Deliberately scoped: linting starts with @workspace/api-server's runtime
// sources only (the package where an unawaited promise or stray console.log
// is an outage- or log-hygiene-shaped bug), with two rules promoted to error:
//
//   - @typescript-eslint/no-floating-promises — every dropped promise is a
//     silently swallowed failure in Express handlers/workers.
//   - no-console — the A6 sweep moved runtime logging to pino; this stops
//     regressions. CLI entrypoints and offline verification scripts keep
//     stdout on purpose (see the override block below).
//
// Expand package-by-package (scent-cast next), fixing or explicitly disabling
// as each package is brought in — do not turn on the whole workspace at once.
//
// Type-aware rules need the package tsconfig; test files are excluded from
// artifacts/api-server/tsconfig.json, so they are not linted here (the test
// runner exercises them instead).
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    files: ["artifacts/api-server/src/**/*.ts"],
    ignores: [
      "artifacts/api-server/src/**/*.test.ts",
      "artifacts/api-server/src/test-*.ts",
    ],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      // Some disable directives guard rules that only arrive when the
      // recommended set expands (staged rollout) — don't flag them as unused.
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "no-console": "error",
    },
  },
  {
    // Deliberate stdout users: CLI/MCP entrypoints and offline verification
    // scripts where the console IS the interface, not stray debug logging.
    files: [
      "artifacts/api-server/src/scripts/**/*.ts",
      "artifacts/api-server/src/beam-agent/mcp/mcpMain.ts",
      "artifacts/api-server/src/beam-agent/mcp/mintOwnerToken.ts",
      "artifacts/api-server/src/services/verifyPoofPaths.ts",
      "artifacts/api-server/src/lib/scent-facts/backtest.ts",
    ],
    rules: {
      "no-console": "off",
    },
  },
);
