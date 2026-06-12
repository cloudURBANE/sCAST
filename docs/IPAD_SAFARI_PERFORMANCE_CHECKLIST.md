# iPad Safari Performance Checklist

Target device: real iPad Pro 11-inch M2 on Safari/iPadOS. Do not treat Chrome DevTools emulation or Lighthouse as acceptance.

## Device Snapshot

Record these values at the start of each run:

- `navigator.userAgent`
- `navigator.platform`
- `navigator.maxTouchPoints`
- `window.innerWidth` / `window.innerHeight`
- `window.devicePixelRatio`
- `window.visualViewport?.width` / `height` / `offsetTop` / `scale`
- orientation
- `matchMedia('(prefers-reduced-motion: reduce)').matches`
- iPadOS and Safari version from Settings

## Safari Web Inspector Timelines

Capture separate recordings for:

1. Initial load.
2. Add fragrance flow.
3. Opening a fragrance card/detail.
4. Interacting with the note pyramid.
5. Scrolling result and detail pages with the Safari address bar expanded and collapsed.

For each recording, inspect:

- long frames and repeated frame spikes
- layout recalculations after interaction
- repaint and compositing spikes
- image decode spikes during touch interaction
- JavaScript tasks over a frame budget
- memory growth across repeated open/close cycles

## Patch Sequence

1. Blur/filter/layer patch: iPad Safari performance mode disables live thread animation, live backdrop blur, heavy modal scale/shadow, pyramid SVG filters, pyramid blur tweens, and unnecessary persistent `will-change`.
2. Fixed/sticky/viewport patch: iPad Safari detail modals avoid the `body { position: fixed }` scroll lock while keeping the fixed opaque portal and tablet layout.
3. Scroll/touch patch: marquee drag transform writes are batched with `requestAnimationFrame`; non-canceling pointer listeners are passive.
4. Lazy/content-visibility patch: `content-visibility:auto` is disabled for the interactive vault section on iPad Safari.
5. Image/DOM patch: verify no large image decode begins during note pyramid or card open interactions; keep eager loading limited to current detail/enlarged imagery.

## Acceptance

- No visible hitch when adding fragrances.
- No stutter opening fragrance cards/details.
- No glitching during note pyramid touch interaction.
- No overlay/header/footer jumping while scrolling.
- No blank or late-rendered vault sections from lazy rendering.
- No repeated long frames during normal interaction.
