import { useEffect } from "react";

import { useAuth } from "@/context/AuthContext";
import { clearAppBadgeAndServer } from "@/lib/pushNotifications";

/**
 * Clears the app-icon badge whenever a signed-in user brings the app to the
 * foreground. Opening (or returning to) ScentBeam means the pending nudges have
 * been "seen", so we zero both the OS badge and the server's authoritative
 * count — keeping every device consistent on the next push.
 *
 * Renders nothing; mounted once near the app root (no standalone/permission
 * gate, since clearing is a quiet no-op when the Badge API is unavailable).
 */
export function BadgeClearer() {
  const { authToken } = useAuth();

  useEffect(() => {
    if (!authToken) return;

    const clear = () => {
      if (document.visibilityState === "visible") void clearAppBadgeAndServer(authToken);
    };

    clear(); // clear on mount / sign-in
    document.addEventListener("visibilitychange", clear);
    window.addEventListener("focus", clear);
    return () => {
      document.removeEventListener("visibilitychange", clear);
      window.removeEventListener("focus", clear);
    };
  }, [authToken]);

  return null;
}
