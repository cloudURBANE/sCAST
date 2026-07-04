// Async feature bundle for framer-motion's LazyMotion.
//
// The app renders `m.*` components (not `motion.*`), so the animation feature
// set loads through this dynamic import instead of shipping in the entry
// bundle — a meaningful main-thread saving on iPhone-class WebKit where parse/
// execute time directly delays first interaction. `domMax` (not `domAnimation`)
// is required because the wardrobe bottle morph uses shared-layout `layoutId`
// animations (VaultGridTile → detail modal) and App.tsx uses `layout` FLIP
// transitions on desktop.
//
// Until this chunk resolves, `m.*` components render their `initial` styles
// statically and start animating when features arrive — content stays visible
// and correct, only the motion is deferred.
export { domMax as default } from "framer-motion";
