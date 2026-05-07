# Image Pipeline Handoff

- Current patch blocks stale local `/api/image-objects/...` URLs from counting as usable images and lets preview save persist the exact preview URL.
- Finish later: add focused tests/debug audit for usable-vs-present image URLs, then run full typecheck.
- Also verify production object storage env; local storage is fragile outside dev.
