import React from "react";
import {
  BUILD_ID,
  clearTrace,
  getPreviousSession,
  previousLoadLooksLikeCrash,
  type TraceSession,
} from "@/lib/crashTrace";

/**
 * Tiny always-on diagnostic chip (bottom-left). It serves two jobs while we
 * chase the iOS "A problem repeatedly occurred" crash:
 *
 *  1. Shows the BUILD_ID so we can confirm the device is on a fresh deploy.
 *  2. If the *previous* page load ended in an abnormal kill (no clean `unload`),
 *     it auto-expands and lists the final breadcrumbs — the last one names the
 *     phase that was executing when the WebContent process died.
 *
 * Temporary instrumentation; remove with crashTrace.ts once the crash is fixed.
 */
export function CrashTraceBadge(): React.ReactElement {
  const prev = React.useRef<TraceSession | null>(getPreviousSession()).current;
  const crashed = previousLoadLooksLikeCrash(prev);
  const [open, setOpen] = React.useState(crashed);

  const tail = prev ? prev.crumbs.slice(-12) : [];

  return (
    <div
      style={{
        position: "fixed",
        left: "env(safe-area-inset-left, 0px)",
        bottom: "env(safe-area-inset-bottom, 0px)",
        zIndex: 2147483647,
        margin: 6,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 10,
        lineHeight: 1.35,
        maxWidth: "min(92vw, 360px)",
        pointerEvents: "auto",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "inline-block",
          padding: "3px 7px",
          borderRadius: 6,
          color: crashed ? "#fff" : "rgba(255,255,255,0.62)",
          background: crashed ? "rgba(190,30,30,0.92)" : "rgba(0,0,0,0.55)",
          border: "1px solid rgba(255,255,255,0.18)",
          backdropFilter: "blur(2px)",
        }}
      >
        {crashed ? "⚠ crash " : "build "}
        {BUILD_ID}
      </button>

      {open && (
        <div
          style={{
            marginTop: 4,
            padding: "6px 8px",
            borderRadius: 6,
            color: "rgba(255,255,255,0.9)",
            background: "rgba(0,0,0,0.82)",
            border: "1px solid rgba(255,255,255,0.18)",
            maxHeight: "40vh",
            overflow: "auto",
          }}
        >
          <div style={{ opacity: 0.7, marginBottom: 4 }}>
            build {BUILD_ID}
            {prev ? ` · prev session, last ${tail.length} steps:` : " · no prior trail"}
          </div>
          {tail.map((c, i) => {
            const isLast = i === tail.length - 1;
            return (
              <div
                key={i}
                style={{
                  color: isLast && crashed ? "#ff8a8a" : undefined,
                  fontWeight: isLast && crashed ? 700 : 400,
                }}
              >
                {String(c.t).padStart(6, " ")}ms  {c.label}
                {isLast && crashed ? "  ⟵ died here" : ""}
              </div>
            );
          })}
          {prev && (
            <button
              type="button"
              onClick={() => {
                clearTrace();
                setOpen(false);
              }}
              style={{
                all: "unset",
                cursor: "pointer",
                marginTop: 6,
                padding: "2px 6px",
                borderRadius: 5,
                color: "rgba(255,255,255,0.85)",
                border: "1px solid rgba(255,255,255,0.25)",
              }}
            >
              clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
