# iPad Freeze Device Test Protocol

## Test URL

Open the diagnostic route on the affected iPad:

`/debug/ipad-freeze`

Local dev server used for this patch:

`http://localhost:5174/debug/ipad-freeze`

Use the Network URL printed by Vite when testing from a physical iPad on the same Wi-Fi.

## Record Before Testing

- Device model:
- iPadOS version:
- Browser and version:
- Route/URL:
- Build/branch:
- Exact date/time:

## Required Recording

Start an iPad screen recording before the first interaction. Keep the debug overlay visible in the video. The key evidence is whether the overlay counters continue to change when the visible motion freezes.

Also capture Safari Web Inspector console output for the same run.

## Modes To Test

Test each mode from the overlay segmented control:

1. Production
2. DOM transform
3. CSS animation
4. Canvas 2D
5. Non-React

For each mode:

1. Tap `Reset`.
2. Wait 10 seconds without touching the page.
3. Slowly pan/scroll/gesture over the page for 20 seconds.
4. If a freeze appears, tap `Mark` immediately.
5. Continue recording for at least 10 seconds after the freeze.
6. Tap `Export` or `Copy` and save the JSON log.
7. Note whether the visual scene froze, whether overlay counters kept changing, and whether input counts changed during the freeze.

## Observation Table

| Mode | Freeze? | RAF changes during freeze? | Interval changes? | Input counts change? | React counts change? | Canvas draw count changes? | Model x/y/position changes? | Console errors/warnings? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Production |  |  |  |  |  |  |  |  |  |
| DOM transform |  |  |  |  |  | n/a |  |  |  |
| CSS animation |  |  |  |  |  | n/a |  |  |  |
| Canvas 2D |  |  |  |  |  |  |  |  |  |
| Non-React |  |  |  |  |  | n/a |  |  |  |

## Interpretation

- RAF stops: investigate lifecycle, timer throttling, focus/visibility, long tasks, or WebKit timer suspension.
- RAF continues and model coordinates continue, but visuals freeze: investigate compositor, presentation, GPU, or layer invalidation.
- Canvas draw count continues but canvas output freezes: stronger evidence for presentation/compositor/GPU failure than DOM layout.
- Input counts stop while RAF continues: investigate pointer capture, passive listeners, overlays, touch-action, gesture handling, or Safari input routing.
- React render/update counts stop while timers continue: investigate app state, subscriptions, stale closures, aborted effects, or update scheduling.
- Only Production freezes: bisect production-specific code paths before changing rendering strategy again.

Do not propose or ship another rendering fix until the table above is filled from the affected device.
