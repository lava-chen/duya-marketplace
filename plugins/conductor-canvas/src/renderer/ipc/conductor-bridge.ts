import { getSnapshot } from "./conductor-ipc";
import type { ConductorSnapshot } from "../types/conductor";

type StatePatchHandler = (patch: Record<string, unknown>) => void;
type SnapshotHandler = (snapshot: ConductorSnapshot) => void;

class ConductorBridgeClass {
  private handlers = new Set<StatePatchHandler>();
  private snapshotHandlers = new Set<SnapshotHandler>();
  private timer: number | null = null;
  private canvasId: string | null = null;
  private lastSnapshot = "";
  private changeListener: EventListener | null = null;

  connect(canvasId: string): () => void {
    this.disconnect();
    this.canvasId = canvasId;
    const refresh = () => { void this.refreshSnapshot(); };
    this.changeListener = refresh;
    window.addEventListener("plugin-canvas:changed", refresh);
    void this.refreshSnapshot();
    this.timer = window.setInterval(refresh, 1200);
    return () => this.disconnect();
  }

  disconnect(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    if (this.changeListener) window.removeEventListener("plugin-canvas:changed", this.changeListener);
    this.changeListener = null;
    this.canvasId = null;
    this.lastSnapshot = "";
  }

  onStatePatch(handler: StatePatchHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async refreshSnapshot(): Promise<ConductorSnapshot | null> {
    if (!this.canvasId) return null;
    const snapshot = await getSnapshot(this.canvasId);
    if (!snapshot || this.canvasId !== snapshot.canvas.id) return null;
    const signature = JSON.stringify(snapshot);
    if (signature === this.lastSnapshot) return snapshot;
    this.lastSnapshot = signature;
    for (const handler of this.snapshotHandlers) {
      try { handler(snapshot); } catch { /* isolate subscriber errors */ }
    }
    const patch = { canvasId: snapshot.canvas.id, widgets: snapshot.widgets, elements: (snapshot as any).elements || [], actionCursor: snapshot.actionCursor };
    for (const handler of this.handlers) {
      try { handler(patch); } catch { /* isolate subscriber errors */ }
    }
    return snapshot;
  }

  onSnapshot(handler: SnapshotHandler): () => void {
    this.snapshotHandlers.add(handler);
    return () => this.snapshotHandlers.delete(handler);
  }

  destroy(): void {
    this.disconnect(); this.handlers.clear(); this.snapshotHandlers.clear();
  }
}

export const ConductorBridge = new ConductorBridgeClass();
