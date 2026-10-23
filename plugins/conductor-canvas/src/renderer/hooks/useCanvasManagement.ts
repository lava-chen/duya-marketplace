"use client";

import { useEffect } from "react";
import { listCanvases, listCanvasGroups } from "../ipc/conductor-ipc";
import { useConductorStore } from "../stores/conductor-store";

/** Keep the library fresh when the agent edits the shared plugin MCP store. */
export function useCanvasManagement(): void {
  const setCanvases = useConductorStore((state) => state.setCanvases);
  const setCanvasGroups = useConductorStore((state) => state.setCanvasGroups);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const [canvases, groups] = await Promise.all([listCanvases(), listCanvasGroups()]);
        if (!cancelled) { setCanvases(canvases); setCanvasGroups(groups); }
      } catch { /* transient host disconnect; next poll retries */ }
    };
    void refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [setCanvases, setCanvasGroups]);
}
