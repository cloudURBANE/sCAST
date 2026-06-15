import { useEffect } from "react";

import { toast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { applyPwaUpdate, setupPwa } from "@/lib/pwa/registerPwa";

/**
 * Registers the service worker on mount and, when a new build is waiting,
 * surfaces a persistent "refresh" toast. Renders nothing. Mounted once near the
 * app root (main.tsx) — it does not depend on any context provider because
 * `toast()` dispatches to a module-level store the <Toaster> subscribes to.
 */
export function PwaUpdater() {
  useEffect(() => {
    setupPwa({
      onNeedRefresh() {
        toast({
          title: "Update available",
          description: "A new version of ScentBeam is ready.",
          // Persist until the user acts — an app update shouldn't auto-dismiss.
          duration: Infinity,
          action: (
            <ToastAction altText="Refresh to update" onClick={() => applyPwaUpdate()}>
              Refresh
            </ToastAction>
          ),
        });
      },
    });
  }, []);

  return null;
}
