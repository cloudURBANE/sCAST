---
name: token-efficient-navigation
description: Locate relevant ScentBeam code with scoped ripgrep queries and small source slices while excluding generated output, dependencies, assets, caches, backups, and reports. Use before reading large or unfamiliar files, tracing a symbol or route, investigating ownership, or when repository exploration is producing noisy duplicate hits.
---

# Navigate with bounded context

Locate first, slice second, widen only when evidence requires it.

## Use the search loop

1. List likely files with `rg --files <owner-dir>` and a narrow glob.
2. Find symbols with `rg -n "<symbol-or-route>" <owner-dir>`.
3. Read only the matching region. In PowerShell:

   ```powershell
   Get-Content <file> | Select-Object -Skip <start> -First <count>
   ```

4. Inspect imports, callers, tests, and contract definitions for the selected symbol.
5. Widen to the next owning package only when the dependency edge requires it.

Batch independent searches or reads in one tool call. Do not repeatedly scan the repository root.

## Scope searches

Start in one of:

- `artifacts/scent-cast/src`
- `artifacts/api-server/src`
- `lib/<package>/src`
- `scripts/src`
- `hermes-beam`

Use globs such as `-g '*.ts'`, `-g '*.tsx'`, or `-g '*test.ts'`. Prefer source and nearby tests over reports that mention the same symbol.

## Avoid token traps

Never read these wholesale:

- `pnpm-lock.yaml`;
- `dist/**`, `dist-beam/**`, source maps, generated bundles;
- `node_modules/**`, `.local/**`, `.image-cache/**`;
- binary files under `artifacts/scent-cast/public/`;
- backup/recovery trees and JSON dumps;
- large UI files such as `Wardrobe.tsx`, `ScentMissionPanel.tsx`, `NotePyramid.tsx`, `index.css`, `App.tsx`, and `fragranceApi.ts`.

For a source file above roughly 50 KB or 1,500 lines, search for the symbol before reading. For unknown files, check size first:

```powershell
Get-Item <file> | Select-Object Length,FullName
```

## Stop when ownership is proven

Before editing, be able to name:

- the canonical source file;
- the caller or consumer;
- the nearest relevant test;
- any generated or cross-service boundary.

If those are unclear, load `$repo-map`; do not compensate by reading more unrelated files.
