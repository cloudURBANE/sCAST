# AGENTS.md

These instructions apply repo-wide. Read the nearest nested AGENTS.md as well when working below a directory that has one.

## Shared issue-fixing doctrine

For unfamiliar fixes, load .agents/skills/large-repo-investigation/SKILL.md and the focused skills it selects.

Do not edit immediately. First identify the user-visible symptom, likely route/page/component, state or data flow, styling/layout layer, and verification method. Trace route → component → state/hook → data layer → styling → tests/runtime, opening only files connected by repository evidence.

Before patching, summarize the canonical owner, caller/consumer, relevant state/data/style boundary, nearest verification target, and remaining uncertainty. Do not patch below 95% confidence in ownership; investigate further or ask for missing information.

## Hard rules

- Never guess ownership from names alone or hallucinate files, functions, routes, or components.
- Never rewrite unrelated architecture or clean up unrelated code.
- Preserve current working behavior and visual language unless the issue requires changing them.
- Never change fonts, font stacks, letter spacing, design tokens, or global styling unless explicitly requested.
- Map UI symptoms to exact component/layout/style ownership before editing.
- For mobile UI bugs, inspect responsive classes, viewport constraints, overflow, sticky/fixed elements, and container sizing before changing logic.
- For conversation or agent bugs, prove where context is captured, transformed, lost, ignored, or overwritten.
- Prefer surgical patches. Do not introduce dependencies unless necessary and justified.
- Protect desktop, tablet, mobile, PWA, and existing feature behavior.
- Treat unrelated working-tree changes as user-owned and leave them untouched.
- Skip repetitive browser/device scenario suites unless the changed behavior specifically requires them.

## Reusable skill stack

| Skill                    | Purpose                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| large-repo-investigation | Orchestrate evidence-first investigation, editing, and verification. |
| repo-navigation          | Locate canonical ownership without random repository wandering.      |
| visual-ui-debug          | Map screenshots and UX symptoms to exact rendered/style ownership.   |
| state-agent-debug        | Trace state, memory, context, hook/store/API, and response failures. |
| safe-edit-verify         | Make the smallest patch and run proportional checks.                 |
| commit-discipline        | Keep one verified logical task per commit and report its scope.      |

Repository-specific routing, commands, and verification remain in repo-map, token-efficient-navigation, dev-commands, and verify-without-regression.

## Required completion report

State the exact fix, every file changed and why, commands run with outcomes, rendered verification when relevant, and any remaining risks or unverified boundaries.
