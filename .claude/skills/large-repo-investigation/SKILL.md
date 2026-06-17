---
name: large-repo-investigation
description: Investigate and fix unfamiliar large-repository issues by proving route, component, state, data, styling, and test ownership before editing. Use for bug fixes, UI or mobile defects, conversation or agent failures, cross-package changes, and any task where broad searching or guessed ownership risks regressions.
---

# Large Repo Investigation Protocol

Goal: prove ownership, make the smallest safe change, and verify the affected behavior without wasting context.

## Do not edit immediately

First identify:

- the user-visible symptom;
- the likely route, page, or component;
- the state or data flow involved;
- the styling or layout layer involved;
- the verification method that can prove the fix.

If any item is unknown, continue tracing. State assumptions explicitly and do not present them as evidence.

## Investigation order

1. Load repo-navigation and locate the route or page entry.
2. Trace imports to the component that owns the behavior.
3. Identify connected hooks, stores, context providers, API calls, cache layers, and style files.
4. For visual or responsive issues, load visual-ui-debug.
5. For conversation, memory, context, or agent-response issues, load state-agent-debug.
6. Open only files directly connected by imports, calls, selectors, routes, or tests.
7. Summarize the ownership evidence and proposed verification before editing.
8. Load safe-edit-verify to apply the smallest safe change and run proportional checks.
9. Load commit-discipline when a commit is in scope.

## Evidence checkpoint

Before patching, name:

- the canonical owning file and symbol;
- the caller, consumer, or rendered route;
- the relevant state/data/style boundary;
- the nearest useful test or runtime check;
- any unresolved uncertainty or cross-service impact.

Do not patch until ownership is supported by repository evidence. If confidence is below 95%, keep investigating or ask for the missing information.

## Hard rules

- Never guess ownership from names alone or invent files, functions, routes, or components.
- Never rewrite unrelated architecture or clean up unrelated code.
- Preserve working behavior and the existing visual language unless the issue requires a change.
- Never change fonts, font stacks, letter spacing, design tokens, or global styling unless explicitly requested.
- Map UI symptoms to exact component, layout, and style ownership before editing.
- For mobile bugs, inspect responsive classes, viewport constraints, overflow, sticky/fixed elements, and container sizing before changing logic.
- For conversation or agent bugs, prove where context is captured, transformed, lost, ignored, or overwritten.
- Prefer surgical patches. Do not add dependencies unless clearly necessary and justified.
- Protect desktop, tablet, mobile, PWA, and existing feature behavior.
- Follow route → component → state/hook → data layer → styling → tests/runtime. Do not wander randomly.

## Completion report

Report the exact fix, files changed and why, commands run with outcomes, rendered verification when relevant, and remaining risks or unverified boundaries.
