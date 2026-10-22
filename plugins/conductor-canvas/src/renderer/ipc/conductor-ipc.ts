import { pluginBridge } from "../plugin-bridge";
import type { ConductorCanvas, ConductorCanvasGroup, ConductorWidget, ConductorSnapshot, ConductorActionRequest } from "../types/conductor";
import type { ConnectorEndpoint, LinkSnapshotMode } from "../types/canvas-node";

export interface UploadedAsset {
  assetId: string;
  url: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
}

type PluginCanvas = Record<string, any>;
function normalizeCanvas(raw: PluginCanvas): ConductorCanvas {
  const timestamp = (value: unknown) => typeof value === "number" ? value : Date.parse(String(value || "")) || Date.now();
  return {
    id: String(raw.id), name: String(raw.name || "Untitled canvas"), description: raw.description ?? null,
    layoutConfig: raw.layoutConfig && typeof raw.layoutConfig === "object" ? raw.layoutConfig : {},
    sortOrder: Number(raw.sortOrder) || 0, createdAt: timestamp(raw.createdAt), updatedAt: timestamp(raw.updatedAt),
    projectPath: raw.projectPath ?? null, isFavorite: raw.isFavorite === true, groupId: raw.groupId || null,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag: unknown): tag is string => typeof tag === "string") : [],
  };
}

function normalizeSnapshot(raw: PluginCanvas): ConductorSnapshot {
  const canvas = normalizeCanvas(raw.canvas || {});
  const elements = (Array.isArray(raw.elements) ? raw.elements : []).map((element: PluginCanvas) => ({
    ...element,
    elementKind: element.elementKind || (element.type === "widget" ? "widget/dynamic" : `native/${element.type || "sticky"}`),
    native_kind: element.native_kind || element.nativeKind || undefined,
    canvasId: element.canvasId || canvas.id,
    state: element.state || "idle", dataVersion: element.dataVersion || 1,
    vizSpec: element.vizSpec ?? null, sourceCode: element.sourceCode ?? null,
    permissions: element.permissions || { agentCanRead: true, agentCanWrite: true, agentCanDelete: true },
    metadata: element.metadata || { label: element.type || "element", tags: [], createdBy: "user" },
    position: { zIndex: 0, rotation: 0, ...element.position },
  }));
  const widgets = Array.isArray(raw.widgets) ? raw.widgets as ConductorWidget[] : [];
  return { canvas, widgets, actions: Array.isArray(raw.actions) ? raw.actions : [], canUndo: raw.canUndo === true, canRedo: raw.canRedo === true, actionCursor: Number(raw.actionCursor) || 0, elements } as unknown as ConductorSnapshot;
}

export async function listCanvases(): Promise<ConductorCanvas[]> {
  const result = await pluginBridge.call<{ canvases?: PluginCanvas[] }>("canvas_manage", { action: "list" });
  return (result.canvases || []).map(normalizeCanvas);
}
export async function getCanvasByProjectPath(projectPath: string): Promise<ConductorCanvas | null> {
  return (await listCanvases()).find((canvas) => canvas.projectPath === projectPath) || null;
}
export async function createCanvas(name: string, description?: string, projectPath?: string | null): Promise<ConductorCanvas> {
  const result = await pluginBridge.call<{ canvas: PluginCanvas }>("canvas_create", { name, description, projectPath });
  return normalizeCanvas(result.canvas);
}
export async function updateCanvas(id: string, data: Record<string, unknown>): Promise<ConductorCanvas | null> {
  const result = await pluginBridge.call<{ canvas: PluginCanvas }>("canvas_update", { canvasId: id, ...data });
  return result.canvas ? normalizeCanvas(result.canvas) : null;
}
export async function listCanvasGroups(projectPath?: string | null): Promise<ConductorCanvasGroup[]> {
  const result = await pluginBridge.call<{ groups?: ConductorCanvasGroup[] }>("canvas_group_list", { projectPath });
  return result.groups || [];
}
export async function createCanvasGroup(data: { name: string; projectPath?: string | null }): Promise<ConductorCanvasGroup> {
  const result = await pluginBridge.call<{ group: ConductorCanvasGroup }>("canvas_group_create", data);
  return result.group;
}
export async function updateCanvasGroup(id: string, data: { name?: string; sortOrder?: number }): Promise<ConductorCanvasGroup | null> {
  const result = await pluginBridge.call<{ group: ConductorCanvasGroup }>("canvas_group_rename", { groupId: id, ...data });
  return result.group || null;
}
export async function deleteCanvasGroup(id: string): Promise<boolean> {
  await pluginBridge.call("canvas_group_delete", { groupId: id }); return true;
}
export async function deleteCanvas(id: string): Promise<boolean> {
  await pluginBridge.call("canvas_delete", { canvasId: id }); return true;
}
export async function getSnapshot(canvasId: string): Promise<ConductorSnapshot | null> {
  const raw = await pluginBridge.call<PluginCanvas>("canvas_get_snapshot", { canvasId });
  return raw?.canvas ? normalizeSnapshot(raw) : null;
}
export async function executeAction(request: ConductorActionRequest & { actor?: string }): Promise<any> {
  const result = await pluginBridge.call<any>("canvas_execute_action", { action: request });
  window.dispatchEvent(new CustomEvent("plugin-canvas:changed", { detail: request.canvasId }));
  return result;
}
export async function addWidget(canvasId: string, kind: string, type: string, data: Record<string, unknown>, config: Record<string, unknown>, position: { x: number; y: number; w: number; h: number }): Promise<any> {
  return executeAction({ action: "widget.create", canvasId, kind: kind as "builtin", type, data, config, position });
}
export async function undoAction(canvasId: string): Promise<any> {
  const result = await pluginBridge.call<{ undone: boolean; [key: string]: unknown }>("canvas_undo", { canvasId });
  window.dispatchEvent(new CustomEvent("plugin-canvas:changed", { detail: canvasId }));
  return { ...result, success: result.undone === true };
}
export async function redoAction(canvasId: string): Promise<any> {
  const result = await pluginBridge.call<{ redone: boolean; [key: string]: unknown }>("canvas_redo", { canvasId });
  window.dispatchEvent(new CustomEvent("plugin-canvas:changed", { detail: canvasId }));
  return { ...result, success: result.redone === true };
}
export async function createElement(canvasId: string, elementKind: string, position: { x: number; y: number; w: number; h: number; zIndex: number; rotation: number }, vizSpec?: Record<string, unknown> | null, config?: Record<string, unknown>): Promise<any> {
  return executeAction({ action: "element.create", canvasId, elementKind: elementKind as any, position, vizSpec: vizSpec as any, config });
}
export async function createNativeElement(canvasId: string, nodeType: string, position: { x: number; y: number; w: number; h: number; zIndex: number; rotation: number }, content: Record<string, unknown>, style?: Record<string, unknown>): Promise<any> {
  return executeAction({ action: "element.create_native", canvasId, nodeType, position, content: { ...content, ...(style || {}) } });
}
export async function createConnector(canvasId: string, source: ConnectorEndpoint, target: ConnectorEndpoint, options: Record<string, unknown> = {}): Promise<any> {
  return executeAction({ action: "connector.create", canvasId, source, target, ...options } as any);
}
export async function updateElementContent(elementId: string, canvasId: string, content: Record<string, unknown>): Promise<any> {
  return executeAction({ action: "element.update_content", elementId, canvasId, content });
}
export async function reparentElement(elementId: string, canvasId: string, parentId: string | null): Promise<any> {
  return executeAction({ action: "element.reparent", elementId, canvasId, parentId });
}
export async function uploadAsset(canvasId: string, file: File): Promise<UploadedAsset> {
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
    reader.onerror = () => reject(reader.error); reader.readAsDataURL(file);
  });
  const result = await pluginBridge.call<any>("canvas_asset_put", { name: file.name, mimeType: file.type || "application/octet-stream", base64 });
  return { assetId: result.assetId, url: `data:${result.mimeType};base64,${base64}`, fileName: result.name, mimeType: result.mimeType, size: result.size, kind: result.mimeType.startsWith("image/") ? "image" : "file" };
}
export async function getAssetUrl(assetId: string): Promise<string> {
  const result = await pluginBridge.call<any>("canvas_asset_get", { assetId });
  return `data:${result.mimeType};base64,${result.base64}`;
}
export async function captureLinkSnapshot(_canvasId: string, _elementId: string, _url: string, _mode: Exclude<LinkSnapshotMode, "none">): Promise<{ assetId: string; url: string; width: number; height: number }> {
  const result = await pluginBridge.call<{ assetId: string; mimeType: string; width: number; height: number; base64: string }>(
    "canvas_link_snapshot",
    { url: _url, mode: _mode },
  );
  if (!result?.assetId || !result.base64) throw new Error("The Canvas snapshot service returned an incomplete image.");
  return {
    assetId: result.assetId,
    url: `data:${result.mimeType || "image/jpeg"};base64,${result.base64}`,
    width: result.width,
    height: result.height,
  };
}
export async function widgetAction(request: { canvasId: string; elementId: string; action: { kind: "refresh"; sourceId?: string } }): Promise<unknown> {
  return executeAction({ action: "widget.action", canvasId: request.canvasId, elementId: request.elementId, widgetAction: request.action } as any);
}
export type { ConductorCanvas, ConductorCanvasGroup, ConductorWidget, ConductorSnapshot, ConductorActionRequest, CanvasElement, ConductorV2Snapshot } from "../types/conductor";
