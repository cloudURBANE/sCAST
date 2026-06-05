import * as React from "react";
import {
  getPreviousSession,
  previousLoadLooksLikeCrash,
  clearTrace,
} from "@/lib/crashTrace";

/**
 * Invisible-by-default readback for the iOS detail-modal crash tracer.
 *
 * Renders NOTHING on the live site. It only surfaces the previous (crashed)
 * page load's breadcrumb trail when the URL carries the secret `?__mcdiag`
 * param — so a normal visitor never sees any diagnostic UI. After reproducing
 * the crash on the device, open `<site>/?__mcdiag=1` and screenshot the panel.
 *
 * Temporary; remove with crashTrace.ts once the crash is fixed.
 */
export function CrashDiag(): React.ReactElement | null {
  const enabled = React.useMemo(() => {
    if (typeof window === "undefined") return false;
    try {
      return new URLSearchParams(window.location.search).has("__mcdiag");
    } catch {
      return false;
    }
  }, []);

  if (!enabled) return null;

  const prev = getPreviousSession();
  const crashed = previousLoadLooksLikeCrash(prev);
  const payload = prev
    ? JSON.stringify(
        { crashed, facts: prev.facts, crumbs: prev.crumbs },
        null,
        2,
      )
    : "(no previous-session trail found — reproduce the crash, then reopen this URL)";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483647,
        background: "#000",
        color: crashed ? "#ff7676" : "#9fe6a0",
        font: "11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace",
        padding: "16px",
        overflow: "auto",
        WebkitUserSelect: "text",
        userSelect: "text",
      }}
    >
      <div style={{ marginBottom: 10, color: "#fff" }}>
        modal-crash trace — {crashed ? "PREVIOUS LOAD WAS KILLED" : "previous load ended cleanly"}
        {"  "}
        <button
          type="button"
          onClick={() => {
            clearTrace();
            window.location.search = "";
          }}
          style={{
            marginLeft: 8,
            background: "#222",
            color: "#fff",
            border: "1px solid #555",
            borderRadius: 4,
            padding: "2px 8px",
          }}
        >
          clear &amp; exit
        </button>
      </div>
      <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{payload}</pre>
    </div>
  );
}
