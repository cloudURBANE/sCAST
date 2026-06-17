---
name: repo-navigation
description: Locate canonical routes, components, state owners, data boundaries, styles, and tests in a large repository without random wandering. Use at the start of unfamiliar issues, before opening large files, or whenever duplicate, generated, backup, or cross-package trees could obscure ownership.
---

# Navigate the Repository

Goal: find the smallest connected source graph that owns the reported behavior.

1. Resolve the repository root and read its AGENTS.md plus the nearest nested instructions.
2. Load $repo-map for canonical package boundaries and $token-efficient-navigation for scoped search mechanics.
3. Search for the user-visible route, label, API path, component symbol, or error text in the most likely source package.
4. Trace the route entry to imports, rendered components, hooks/stores/providers, API clients, styles, and nearby tests.
5. Widen to another package only when an import, call, contract, or generated-source edge proves the dependency.
6. Stop when the owner, consumer, and verification point are known.

Use rg --files for candidate files, rg -n for symbols, and small line slices for inspection. Check file size before opening unfamiliar large files.

Never infer ownership from filenames alone. Exclude generated output, dependencies, caches, backups, recovery trees, reports, and build artifacts unless the task explicitly targets them.

Before handing off to another skill, summarize the canonical file, owning symbol, call/import path, connected state or data layer, style owner if relevant, and closest verification target.
