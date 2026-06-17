---
name: verify-without-regression
description: Choose proportional, evidence-based verification for ScentBeam changes using targeted tests, package typechecks, builds, contract checks, and only necessary runtime observation. Use after code or configuration edits and before claiming completion, committing, or pushing. Avoid broad browser/device scenario suites unless the changed behavior specifically requires them.
---

# Verify proportionally

Prove the changed behavior at the narrowest useful layer, then cover compilation and affected boundaries. Stop at the first failure.

## Select checks from changed paths

| Changed area                                       | Required baseline                                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `artifacts/scent-cast/src/lib/` or tested UI logic | nearest test, frontend typecheck                                                                   |
| React components or CSS                            | frontend typecheck, frontend build, targeted visual observation only if layout/interaction changed |
| `artifacts/api-server/src/`                        | nearest test or API suite, API typecheck, API build when runtime bundling changed                  |
| `artifacts/api-server/src/beam-agent/`             | Beam-adjacent tests, API typecheck; build MCP when MCP entrypoints changed                         |
| `lib/scent-weather-engine/`                        | library tests, root typecheck if consumers/types changed                                           |
| `lib/api-spec/openapi.yaml`                        | codegen, generated diff review, root typecheck                                                     |
| `lib/db/src/`                                      | root typecheck and schema/export inspection; do not push a database merely to verify code          |
| `hermes-beam/` or skill Markdown                   | structural validation and referenced-path/tool-name checks                                         |
| root deployment configuration                      | syntax/config inspection plus the narrow relevant build                                            |

Commands live in `$dev-commands`.

## Use the cheapest-first ladder

1. Inspect the diff and confirm only intended files changed.
2. Run the nearest deterministic test.
3. Run the owning package typecheck.
4. Run the owning build when bundling, assets, configuration, or generated output could differ.
5. Exercise one focused runtime path only when static checks cannot prove the behavior.

Do not run repetitive browser scenario suites, every breakpoint, or unrelated end-to-end flows by default. For a layout or pointer change, inspect the affected surface at the relevant viewport and one nearby edge case. Expand only when the implementation or failure history supports it.

## Check boundaries explicitly

- For `fragranceApi.ts`, `source_coverage`, or `derived_metrics`, verify normalization tests and the external-engine contract assumptions.
- For OpenAPI changes, regenerate rather than editing output.
- For DB changes, verify schema exports and callers; a database push needs separate authorization and a confirmed safe target.
- For image/search changes, run the closest service tests before any live external integration call.

## Report evidence precisely

State which commands passed, failed, or were not run. Do not say "fully verified" after only a typecheck. Separate pre-existing failures from regressions only when the evidence proves that distinction.
