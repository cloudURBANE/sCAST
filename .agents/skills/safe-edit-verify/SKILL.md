---
name: safe-edit-verify
description: Make minimal targeted repository edits, preserve architecture and unaffected behavior, and prove fixes with proportional tests, typechecks, lint, builds, or focused runtime observation. Use after ownership is established and before completion, commit, or push.
---

# Edit and Verify Safely

Goal: change only the proven owner and gather enough evidence to support the fix.

Before editing, inspect git status and the relevant diff. Treat unrelated changes as user-owned. Define the smallest patch and its expected behavioral effect.

Apply surgical edits:

- preserve current architecture, contracts, visual language, and working behavior;
- avoid broad refactors, unrelated cleanup, dependency additions, generated-file edits, and global styling changes;
- update connected tests or contract artifacts only when the behavior requires it;
- stop and re-investigate if the patch expands beyond the proven ownership graph.

Verify cheapest-first:

1. Review the diff for unintended files or scope.
2. Run the nearest deterministic test.
3. Run the owning package typecheck or lint command.
4. Run the owning build when bundling, configuration, styles, assets, or generated output may differ.
5. Use one focused runtime or rendered check only when static checks cannot prove the behavior.

Use $dev-commands and $verify-without-regression for repository-specific commands. Skip repetitive browser/device scenarios unless the changed behavior specifically requires them. Never claim full verification from a partial check.

Record commands and exact outcomes. Separate proven pre-existing failures from regressions only when evidence supports that distinction. Report remaining risk when an environment, service, credential, or device prevents a relevant check.
