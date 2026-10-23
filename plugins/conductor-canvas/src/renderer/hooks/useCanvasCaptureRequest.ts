"use client";

import { useEffect } from "react";
import { captureCanvasView, type CaptureScope } from "../refine/screenshot";
import { canvasTransformState } from "../domain/canvas/transform-state";
import { pluginBridge } from "../plugin-bridge";

type CaptureRequest = {
  requestId: string;
  canvasId: string;
  scope: CaptureScope | "full";
  elementId?: string;
  region?: { x: number; y: number; w: number; h: number; unit?: "grid" | "px" };
};

/** Respond to capture requests routed through this plugin's MCP bridge. */
export function useCanvasCaptureRequest(activeCanvasId?: string | null): void {
  useEffect(() => {
    let stopped = false;
    let busy = false;
    const seen = new Set<string>();

    const poll = async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        const response = await pluginBridge.call<{ requests?: CaptureRequest[] }>("canvas_capture_poll", {});
        for (const request of response?.requests || []) {
          if (seen.has(request.requestId)) continue;
          seen.add(request.requestId);
          // Keep this set bounded in case the app stays open for a long time.
          if (seen.size > 500) seen.clear();
          if (!activeCanvasId || request.canvasId !== activeCanvasId) {
            await pluginBridge.call("canvas_capture_complete", {
              requestId: request.requestId,
              error: !activeCanvasId
                ? "No Canvas is open. Open the requested canvas in the Canvas app and retry."
                : `Requested canvas ${request.canvasId} is not the active canvas (${activeCanvasId}). Open it and retry.`,
            });
            continue;
          }
          try {
            const viewport = document.querySelector<HTMLElement>(".canvas-area");
            const inner = viewport?.querySelector<HTMLElement>(".canvas-inner") || null;
            if (!viewport) throw new Error("Canvas viewport is not mounted. Open the Canvas editor and retry.");
            let scope = request.scope === "full" ? "viewport" : request.scope;
            let region = request.region;
            if (request.scope === "full") {
              if (!inner) throw new Error("Canvas content layer is not mounted.");
              const targets = inner.querySelectorAll<HTMLElement>(
                "[data-native-element-id], [data-testid^='widget-shell-']",
              );
              const viewportRect = viewport.getBoundingClientRect();
              const zoom = canvasTransformState.zoom;
              const boxes = Array.from(targets, (target) => target.getBoundingClientRect())
                .filter((rect) => rect.width > 0 && rect.height > 0)
                .map((rect) => ({
                  x: (rect.left - viewportRect.left - canvasTransformState.panX) / zoom,
                  y: (rect.top - viewportRect.top - canvasTransformState.panY) / zoom,
                  w: rect.width / zoom,
                  h: rect.height / zoom,
                }));
              if (!boxes.length) throw new Error("The active canvas has no visible elements to capture.");
              const x = Math.min(...boxes.map((box) => box.x));
              const y = Math.min(...boxes.map((box) => box.y));
              const right = Math.max(...boxes.map((box) => box.x + box.w));
              const bottom = Math.max(...boxes.map((box) => box.y + box.h));
              scope = "region";
              region = { x, y, w: right - x, h: bottom - y, unit: "px" };
            }
            const captured = await captureCanvasView(viewport, inner, {
              scope: scope as CaptureScope,
              ...(request.elementId ? { elementId: request.elementId } : {}),
              ...(region ? { region } : {}),
            });
            await pluginBridge.call("canvas_capture_complete", {
              requestId: request.requestId,
              image: {
                base64: captured.pngBase64,
                mimeType: "image/png",
                width: captured.width,
                height: captured.height,
              },
            });
          } catch (error) {
            await pluginBridge.call("canvas_capture_complete", {
              requestId: request.requestId,
              error: error instanceof Error ? error.message : "Canvas capture failed.",
            }).catch(() => {});
          }
        }
      } catch {
        // The app may start before the plugin MCP host. Retry on the next tick.
      } finally {
        busy = false;
      }
    };

    const timer = window.setInterval(() => void poll(), 500);
    void poll();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeCanvasId]);
}
