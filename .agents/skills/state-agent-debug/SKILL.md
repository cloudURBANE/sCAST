---
name: state-agent-debug
description: Trace conversation state, memory, context capture and loss, hooks, stores, providers, API transformations, caches, persistence, and agent-response failures. Use when messages disappear, context is stale or ignored, state resets, responses use wrong data, or UI and server state diverge.
---

# Debug State and Agent Flow

Goal: prove the first boundary where expected state or context becomes incorrect.

Build an evidence chain:

1. Identify the triggering event and expected state transition.
2. Trace the UI handler into the hook, store, reducer, or context provider.
3. Trace serialization and request construction into the API boundary.
4. Trace server parsing, normalization, persistence, cache reads/writes, prompt or context assembly, provider calls, and response transformation.
5. Trace the response back through cache updates and rendering.
6. Compare the value at each boundary and identify where it is captured, transformed, dropped, ignored, overwritten, or read stale.

Inspect stable identifiers, message ordering, closure dependencies, optimistic updates, invalidation, hydration, persistence keys, cancellation, retries, and concurrent requests where relevant.

Do not fix the visible consumer until the first incorrect boundary is proven. Do not add fallback context that hides an upstream loss. Preserve response contracts and existing successful flows. Add or update the narrowest test that reproduces the failed transition, then use $safe-edit-verify.
