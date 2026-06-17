---
name: visual-ui-debug
description: Convert screenshots, visual complaints, responsive defects, clipping, overlap, spacing, or interaction symptoms into exact route, component, DOM, and style ownership before editing. Use for desktop, tablet, mobile, PWA, CSS, layout, viewport, sticky, fixed, overflow, or rendering issues.
---

# Debug Visual UI Ownership

Goal: connect the visible symptom to the exact rendered element and rule that causes it.

1. Record the route, viewport/device class, interaction state, expected appearance, and observed symptom.
2. Locate the route entry and component with $repo-navigation.
3. Trace the rendered DOM and every class, CSS selector, component wrapper, design primitive, and conditional state affecting the element.
4. Inspect responsive utilities and media queries, parent sizing, flex/grid constraints, min/max dimensions, overflow, viewport units, stacking context, sticky/fixed positioning, safe areas, and containment.
5. Determine whether the defect comes from markup, state, local styling, shared component styling, or global CSS.
6. State the causal chain before editing and select the narrowest rule or component boundary that can fix it.

Preserve the existing visual language. Do not change fonts, font stacks, letter spacing, design tokens, or global styles unless explicitly requested. Do not use fixed sizes to mask fluid-layout defects without proving the constraint.

For mobile fixes, check the affected width and one adjacent device class when possible. Do not run broad browser scenario suites by default. Use $safe-edit-verify for targeted rendered verification and protect desktop, tablet, mobile, and PWA behavior.
