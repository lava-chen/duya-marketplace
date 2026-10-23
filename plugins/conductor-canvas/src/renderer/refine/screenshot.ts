/**
 * Widget DOM screenshot for the iterative refinement loop.
 *
 * Converts the live DOM to an inline-styled SVG foreignObject snapshot. This
 * stays in the current document and avoids html2canvas' sandbox iframe, which
 * cannot inspect an opaque-origin widget frame.
 *
 * Returns a PNG data URL (base64) matching the element's on-screen size,
 * scaled by devicePixelRatio for retina fidelity.
 */

import { canvasTransformState } from "../domain/canvas/transform-state";
import {
  canvasRectToScreen,
  clipRectToViewport,
  computeFitTransform,
  isRectFullyVisible,
  regionToCanvasPx,
  screenPointToCanvas,
  type CaptureRect,
  type CanvasTransform,
} from "./region-fit";

export interface CapturedScreenshot {
  pngBase64: string;
  width: number;
  height: number;
  pixelRatio: number;
}

/**
 * Normalize computed CSS Color 4 channels for SVG foreignObject renderers
 * that do not understand Chromium's color() syntax.
 *
 * This intentionally leaves unknown color spaces alone. Replacing an unknown
 * color with a guessed value is worse than retaining the browser's original
 * declaration, and current DUYA themes emit numeric channels handled here.
 */
export function normalizeHtml2CanvasColor(value: string): string | null {
  const match = value.trim().match(/^color\(\s*[a-z0-9-]+\s+(.+?)\s*\)$/i);
  if (!match) return null;

  const [rawChannels, rawAlpha] = match[1].split("/").map((part) => part.trim());
  const channels = rawChannels.split(/\s+/).map(parseColorChannel);
  const alpha = rawAlpha === undefined ? 1 : parseColorChannel(rawAlpha);
  if (channels.length !== 3 || channels.some((channel) => channel === null) || alpha === null) {
    return null;
  }

  const [red, green, blue] = channels as number[];
  const opacity = alpha as number;
  const rgb = [red, green, blue].map((channel) => Math.round(channel * 255));
  return opacity >= 1
    ? `rgb(${rgb.join(", ")})`
    : `rgba(${rgb.join(", ")}, ${roundOpacity(opacity)})`;
}

/** Replace every supported CSS Color 4 function inside a CSS declaration. */
export function normalizeHtml2CanvasColors(value: string): string {
  return value.replace(/color\(\s*[a-z0-9-]+\s+[^()]+?\s*\)/gi, (color) =>
    normalizeHtml2CanvasColor(color) ?? color,
  );
}

function parseColorChannel(value: string): number | null {
  const parsed = value.endsWith("%")
    ? Number.parseFloat(value) / 100
    : Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : null;
}

function roundOpacity(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Legacy compatibility helper retained for existing callers. The screenshot
 * path below copies all computed properties into an isolated DOM clone.
 */
export function normalizeHtml2CanvasClone(clonedDocument: Document): void {
  const view = clonedDocument.defaultView;
  if (!view) return;

  for (const element of clonedDocument.querySelectorAll<HTMLElement>("*")) {
    const computed = view.getComputedStyle(element);
    for (const property of computed) {
      const value = computed.getPropertyValue(property);
      if (!value.includes("color(")) continue;
      const normalized = normalizeHtml2CanvasColors(value);
      if (normalized !== value) {
        element.style.setProperty(property, normalized, "important");
      }
    }
  }
}

export async function captureWidgetEl(
  el: HTMLElement,
): Promise<CapturedScreenshot> {
  const rect = el.getBoundingClientRect();
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);

  const canvas = await renderDomSnapshot(el, Math.max(1, rect.width), Math.max(1, rect.height), {
    x: 0, y: 0, w: Math.max(1, rect.width), h: Math.max(1, rect.height),
  }, pixelRatio);

  const pngBase64 = canvas.toDataURL("image/png").replace(
    /^data:image\/png;base64,/,
    "",
  );

  return {
    pngBase64,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    pixelRatio,
  };
}

// ── Canvas-level capture for agent visual analysis ──────────────────

/**
 * Scope of canvas capture.
 * - `viewport`: capture what the user currently sees (visible canvas area)
 * - `element`: capture a single element by its DOM selector
 * - `region`: capture a rectangle given in CANVAS coordinates — grid units
 *   by default, the same coordinate space agents use when placing elements
 */
export type CaptureScope = "viewport" | "element" | "region";

export interface CanvasCaptureOptions {
  scope: CaptureScope;
  /** When scope is 'element', the element ID to capture. */
  elementId?: string;
  /**
   * When scope is 'region', the rectangle in canvas coordinates — grid
   * units by default (`unit: 'grid'`, identical to the position values of
   * canvas_create_element) or raw canvas pixels (`unit: 'px'`). The view
   * does NOT need to show this area: the renderer temporarily pans/zooms
   * to frame it, captures, then restores the previous view.
   */
  region?: { x: number; y: number; w: number; h: number; unit?: "grid" | "px" };
}

export interface CanvasCaptureResult extends CapturedScreenshot {
  scope: CaptureScope;
  /** ISO timestamp of capture. */
  capturedAt: string;
  /** Data URL ready for <img> src or LLM image content block. */
  dataUrl: string;
}

/** A framed, viewport-clipped crop ready to render from the live DOM. */
interface CropPlan {
  /** Viewport-relative crop rect (already clipped to the viewport). */
  screen: CaptureRect;
  /**
   * Restores the live view transform after the render, when the plan had
   * to move it. No-op for crops that did not reframe anything.
   */
  restore: () => Promise<void>;
}

/**
 * Captures are serialized: each one may temporarily move the live view
 * transform, so overlapping requests would photograph each other's
 * intermediate framing.
 */
let captureQueue: Promise<unknown> = Promise.resolve();

export function captureCanvasView(
  viewportEl: HTMLElement,
  canvasInnerEl: HTMLElement | null,
  options: CanvasCaptureOptions,
): Promise<CanvasCaptureResult> {
  const run = captureQueue.then(() =>
    captureCanvasViewInner(viewportEl, canvasInnerEl, options),
  );
  // Keep the queue alive on failure so later requests still run — and
  // still see a fully restored view.
  captureQueue = run.catch(() => undefined);
  return run;
}

async function captureCanvasViewInner(
  viewportEl: HTMLElement,
  canvasInnerEl: HTMLElement | null,
  options: CanvasCaptureOptions,
): Promise<CanvasCaptureResult> {
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  // Cap scale to keep capture fast and file sizes reasonable for LLM vision.
  const scale = Math.min(pixelRatio, 1.5);
  const viewportRect = viewportEl.getBoundingClientRect();
  const viewportW = Math.max(0, Math.floor(viewportRect.width));
  const viewportH = Math.max(0, Math.floor(viewportRect.height));

  let plan: CropPlan;

  if (options.scope === "element") {
    if (!canvasInnerEl || !options.elementId) {
      throw new Error("element scope requires elementId and canvasInnerEl");
    }
    // Native elements use data-native-element-id, widgets use data-testid="widget-shell-<id>"
    const escaped = CSS.escape(options.elementId);
    const el =
      canvasInnerEl.querySelector<HTMLElement>(
        `[data-native-element-id="${escaped}"]`,
      ) ||
      canvasInnerEl.querySelector<HTMLElement>(
        `[data-testid="widget-shell-${escaped}"]`,
      );
    if (!el) {
      throw new Error(`Element not found: ${options.elementId}`);
    }
    // Map the element's current on-screen rect back into canvas space so
    // off-screen elements go through the same frame-and-capture path as
    // explicit regions.
    const t = readTransform();
    const rect = el.getBoundingClientRect();
    const topLeft = screenPointToCanvas(
      rect.left - viewportRect.left,
      rect.top - viewportRect.top,
      t,
    );
    const canvasRect: CaptureRect = {
      x: topLeft.x,
      y: topLeft.y,
      w: rect.width / t.zoom,
      h: rect.height / t.zoom,
    };
    plan = await frameOnScreen(canvasRect, canvasInnerEl, viewportW, viewportH);
  } else if (options.scope === "region") {
    const requested = options.region;
    if (!requested) {
      throw new Error("region scope requires region option");
    }
    if (
      !Number.isFinite(requested.x) ||
      !Number.isFinite(requested.y) ||
      !Number.isFinite(requested.w) ||
      !Number.isFinite(requested.h)
    ) {
      throw new Error(
        `region scope received non-finite coords: ${JSON.stringify(requested)}`,
      );
    }
    if (requested.w <= 0 || requested.h <= 0) {
      throw new Error(
        `region scope requires positive w/h, got ${requested.w}x${requested.h}`,
      );
    }
    const unit = requested.unit ?? "grid";
    const canvasRect = regionToCanvasPx(requested, unit);
    plan = await frameOnScreen(canvasRect, canvasInnerEl, viewportW, viewportH);
  } else {
    // viewport — no reframing needed; capture the visible area as-is.
    plan = {
      screen: { x: 0, y: 0, w: viewportW, h: viewportH },
      restore: async () => {},
    };
  }

  try {
    // Downsample very large captures so html2canvas stays fast and the
    // resulting PNG stays small enough to save and send to vision models.
    // html2canvas output size is (width * scale), so cap that product.
    const MAX_CAPTURE_WIDTH = 1920;
    const renderScale =
      plan.screen.w * scale > MAX_CAPTURE_WIDTH
        ? MAX_CAPTURE_WIDTH / plan.screen.w
        : scale;

    const canvas = await renderDomSnapshot(
      viewportEl,
      Math.max(1, viewportW),
      Math.max(1, viewportH),
      plan.screen,
      renderScale,
    );

    const dataUrl = canvas.toDataURL("image/png");
    const pngBase64 = dataUrl.replace(/^data:image\/png;base64,/, "");

    return {
      pngBase64,
      width: canvas.width,
      height: canvas.height,
      pixelRatio,
      scope: options.scope,
      capturedAt: new Date().toISOString(),
      dataUrl,
    };
  } finally {
    await plan.restore();
  }
}

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_INLINE_RESOURCE_BYTES = 8 * 1024 * 1024;

/**
 * Render a live DOM subtree through SVG foreignObject without creating an
 * iframe or reading any frame's document. Computed styles and paintable
 * resources are copied into a detached clone; the live app DOM is untouched.
 */
async function renderDomSnapshot(
  source: HTMLElement,
  sourceWidth: number,
  sourceHeight: number,
  crop: CaptureRect,
  scale: number,
): Promise<HTMLCanvasElement> {
  const sourceNodes: Element[] = [source, ...Array.from(source.querySelectorAll("*"))];
  const clone = source.cloneNode(true) as HTMLElement;
  const cloneNodes: Element[] = [clone, ...Array.from(clone.querySelectorAll("*"))];
  const sourceWindow = source.ownerDocument.defaultView;
  if (!sourceWindow) throw new Error("Cannot render a detached Canvas document.");
  const warnings: string[] = [];
  const resourceCache = new Map<string, Promise<string>>();
  const pairs = sourceNodes.map((node, index) => [node, cloneNodes[index]] as const);
  const resourceTasks: Promise<void>[] = [];

  for (const [original, copy] of pairs) {
    if (original instanceof HTMLElement && original.dataset.captureIgnore === "") {
      copy.remove();
      continue;
    }
    const computed = sourceWindow.getComputedStyle(original);
    const style = (copy as HTMLElement | SVGElement).style;
    for (const property of computed) {
      let value = normalizeHtml2CanvasColors(computed.getPropertyValue(property));
      if (value.includes("url(")) value = await inlineCssUrls(value, warnings, resourceCache);
      style.setProperty(property, value, "important");
    }
    if (original instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
      copy.value = original.value;
      copy.checked = original.checked;
    } else if (original instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement) {
      copy.value = original.value;
      copy.textContent = original.value;
    } else if (original instanceof HTMLSelectElement && copy instanceof HTMLSelectElement) {
      copy.value = original.value;
    }
    resourceTasks.push(copyPaintResource(original, copy, warnings, resourceCache));
    copyPseudoElement(original, copy, "::before", sourceWindow);
    copyPseudoElement(original, copy, "::after", sourceWindow);
  }
  await Promise.all(resourceTasks);

  clone.style.setProperty("width", `${sourceWidth}px`, "important");
  clone.style.setProperty("height", `${sourceHeight}px`, "important");
  clone.style.setProperty("max-width", "none", "important");
  clone.style.setProperty("max-height", "none", "important");
  clone.style.setProperty("overflow", "hidden", "important");
  clone.style.setProperty("box-sizing", "border-box", "important");
  clone.setAttribute("xmlns", HTML_NS);

  // Sandboxed widgets and PDF previews cannot expose their document to the
  // parent. Show an explicit marker in the image instead of silently omitting
  // their pixels or attempting to loosen their sandbox.
  for (const frame of Array.from(clone.querySelectorAll("iframe, frame"))) {
    const placeholder = source.ownerDocument.createElement("div");
    placeholder.textContent = "Embedded sandbox content omitted";
    placeholder.setAttribute("style", frame.getAttribute("style") || "");
    placeholder.style.setProperty("display", "flex", "important");
    placeholder.style.setProperty("align-items", "center", "important");
    placeholder.style.setProperty("justify-content", "center", "important");
    placeholder.style.setProperty("box-sizing", "border-box", "important");
    placeholder.style.setProperty("border", "1px dashed #888", "important");
    placeholder.style.setProperty("background", "#f2f2f2", "important");
    placeholder.style.setProperty("color", "#444", "important");
    placeholder.style.setProperty("font", "12px sans-serif", "important");
    frame.replaceWith(placeholder);
    warnings.push("Sandboxed iframe content is marked as omitted in the screenshot.");
  }

  const foreignObject = `<foreignObject x="0" y="0" width="${sourceWidth}" height="${sourceHeight}"><div xmlns="${HTML_NS}">${new XMLSerializer().serializeToString(clone)}</div></foreignObject>`;
  const svg = `<svg xmlns="${SVG_NS}" xmlns:xhtml="${HTML_NS}" width="${Math.ceil(sourceWidth * scale)}" height="${Math.ceil(sourceHeight * scale)}" viewBox="0 0 ${sourceWidth} ${sourceHeight}">${foreignObject}</svg>`;
  const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = await loadImage(svgDataUrl);
  const canvas = source.ownerDocument.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(crop.w * scale));
  canvas.height = Math.max(1, Math.ceil(crop.h * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable for screenshot rendering.");
  context.drawImage(
    image,
    crop.x * scale,
    crop.y * scale,
    crop.w * scale,
    crop.h * scale,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  if (warnings.length) {
    const note = `Capture note: ${[...new Set(warnings)].slice(0, 3).join(" ")}`;
    context.save();
    context.font = `${Math.max(10, Math.round(11 * scale))}px sans-serif`;
    const barHeight = Math.max(24, Math.ceil(18 * scale));
    context.fillStyle = "rgba(35, 35, 35, 0.88)";
    context.fillRect(0, 0, canvas.width, barHeight);
    context.fillStyle = "#fff";
    context.fillText(note.slice(0, 260), Math.ceil(8 * scale), Math.ceil(barHeight * 0.68), Math.max(1, canvas.width - 16 * scale));
    context.restore();
  }
  try {
    canvas.toDataURL("image/png");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Canvas screenshot contains a resource that cannot be exported safely: ${reason}`);
  }
  // Keep warnings visible in DevTools for local captures; iframe omissions
  // are also drawn as an in-image label so MCP users see the limitation.
  if (warnings.length) console.warn("Canvas screenshot notes:", [...new Set(warnings)]);
  return canvas;
}

async function copyPaintResource(original: Element, copy: Element, warnings: string[], resourceCache: Map<string, Promise<string>>): Promise<void> {
  if (original instanceof HTMLIFrameElement && copy instanceof HTMLIFrameElement) {
    if (original.hasAttribute("srcdoc") && original.sandbox.contains("allow-scripts")) {
      try {
        const dataUrl = await requestWidgetFrameCapture(original);
        const image = original.ownerDocument.createElement("img");
        image.src = dataUrl;
        image.alt = "Captured sandbox widget";
        image.setAttribute("style", (copy as HTMLElement).getAttribute("style") || "");
        copy.replaceWith(image);
      } catch {
        replaceWithResourceNotice(copy, "Sandbox widget screenshot unavailable");
        warnings.push("Sandbox widget capture was unavailable; its frame is marked in the image.");
      }
    } else {
      replaceWithResourceNotice(copy, "Embedded frame content omitted");
      warnings.push("A non-widget embedded frame cannot be captured from its origin.");
    }
  } else if (original instanceof HTMLImageElement && copy instanceof HTMLImageElement) {
    if (original.currentSrc || original.src) {
      try {
        copy.src = await imageUrlToPng(original.currentSrc || original.src, resourceCache);
        copy.removeAttribute("srcset");
        await copy.decode().catch(() => {});
      } catch {
        copy.removeAttribute("src");
        warnings.push(`Image resource could not be embedded: ${safeResourceName(original.currentSrc || original.src)}`);
      }
    }
  } else if (original instanceof SVGImageElement && copy instanceof SVGImageElement) {
    const source = original.href.baseVal || original.getAttribute("xlink:href") || "";
    if (source && !source.startsWith("#")) {
      try {
        const embedded = await imageUrlToPng(new URL(source, original.ownerDocument.baseURI).href, resourceCache);
        copy.href.baseVal = embedded;
        copy.removeAttribute("xlink:href");
      } catch {
        copy.removeAttribute("href");
        copy.removeAttribute("xlink:href");
        warnings.push(`SVG image resource could not be embedded: ${safeResourceName(source)}`);
      }
    }
  } else if (original instanceof HTMLCanvasElement) {
    try {
      const image = original.ownerDocument.createElement("img");
      image.src = original.toDataURL("image/png");
      image.width = original.width;
      image.height = original.height;
      image.setAttribute("style", (copy as HTMLElement).getAttribute("style") || "");
      copy.replaceWith(image);
    } catch {
      replaceWithResourceNotice(copy, "Canvas image unavailable");
      warnings.push("A canvas drawing could not be exported safely.");
    }
  } else if (original instanceof HTMLVideoElement) {
    try {
      const frame = original.ownerDocument.createElement("canvas");
      frame.width = Math.max(1, original.videoWidth);
      frame.height = Math.max(1, original.videoHeight);
      frame.getContext("2d")?.drawImage(original, 0, 0);
      const image = original.ownerDocument.createElement("img");
      image.src = frame.toDataURL("image/png");
      image.setAttribute("style", (copy as HTMLElement).getAttribute("style") || "");
      copy.replaceWith(image);
    } catch {
      replaceWithResourceNotice(copy, "Video frame unavailable");
      warnings.push("A video frame could not be exported safely.");
    }
  }
}

function replaceWithResourceNotice(element: Element, text: string): void {
  const notice = element.ownerDocument.createElement("span");
  notice.textContent = text;
  notice.setAttribute("style", (element as HTMLElement).getAttribute("style") || "");
  notice.style.setProperty("display", "inline-flex", "important");
  notice.style.setProperty("align-items", "center", "important");
  notice.style.setProperty("justify-content", "center", "important");
  notice.style.setProperty("background", "#f2f2f2", "important");
  notice.style.setProperty("color", "#444", "important");
  element.replaceWith(notice);
}

function copyPseudoElement(element: Element, clone: Element, pseudo: "::before" | "::after", view: Window): void {
  const computed = view.getComputedStyle(element, pseudo);
  const content = computed.content;
  if (!content || content === "none" || content === "normal" || content === "\"\"" || content === "''") return;
  const text = content.match(/^(?:"(.*)"|'(.*)')$/)?.slice(1).find((part) => part !== undefined) ?? "";
  if (!text) return;
  const span = clone.ownerDocument.createElement("span");
  span.textContent = text;
  span.setAttribute("data-screenshot-pseudo", pseudo);
  for (const property of computed) {
    span.style.setProperty(property, normalizeHtml2CanvasColors(computed.getPropertyValue(property)), "important");
  }
  if (pseudo === "::before") clone.prepend(span); else clone.append(span);
}

async function inlineCssUrls(value: string, warnings: string[], resourceCache: Map<string, Promise<string>>): Promise<string> {
  const matches = Array.from(value.matchAll(/url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/gi));
  let result = value;
  for (const match of matches) {
    const url = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!url || url.startsWith("#") || url.startsWith("data:")) continue;
    try {
      const dataUrl = await resourceToDataUrl(new URL(url, document.baseURI).href, resourceCache);
      result = result.replace(match[0], `url("${dataUrl}")`);
    } catch {
      result = result.replace(match[0], "none");
      warnings.push(`CSS image resource could not be embedded: ${safeResourceName(url)}`);
    }
  }
  return result;
}

function imageUrlToPng(url: string, resourceCache: Map<string, Promise<string>>): Promise<string> {
  const key = `png:${url}`;
  const cached = resourceCache.get(key);
  if (cached) return cached;
  const pending = rasterizeImageUrlToPng(url, resourceCache);
  resourceCache.set(key, pending);
  pending.catch(() => resourceCache.delete(key));
  return pending;
}

async function rasterizeImageUrlToPng(url: string, resourceCache: Map<string, Promise<string>>): Promise<string> {
  const dataUrl = await resourceToDataUrl(url, resourceCache);
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, image.naturalWidth || image.width);
  canvas.height = Math.max(1, image.naturalHeight || image.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D context unavailable");
  context.drawImage(image, 0, 0);
  return canvas.toDataURL("image/png");
}

async function resourceToDataUrl(url: string, resourceCache: Map<string, Promise<string>>): Promise<string> {
  if (url.startsWith("data:")) {
    const match = url.match(/^data:(image\/[\w.+-]+)(;[^,]*)?,(.*)$/is);
    if (!match) throw new Error("Invalid data image");
    const header = match[2] || "";
    const payload = match[3];
    if (!/^image\/(?:png|jpe?g|gif|webp|svg\+xml|bmp|avif)$/i.test(match[1]) || !payload) {
      throw new Error("Invalid or oversized data image");
    }
    const decodedSize = /;base64/i.test(header)
      ? Math.floor(payload.replace(/\s/g, "").length * 0.75)
      : new TextEncoder().encode(decodeURIComponent(payload)).byteLength;
    if (decodedSize > MAX_INLINE_RESOURCE_BYTES) throw new Error("Invalid or oversized data image");
    return url;
  }
  const cached = resourceCache.get(url);
  if (cached) return cached;
  const pending = fetchResourceDataUrl(url);
  resourceCache.set(url, pending);
  try { return await pending; }
  catch (error) { resourceCache.delete(url); throw error; }
}

async function fetchResourceDataUrl(url: string): Promise<string> {
  const response = await fetch(url, { mode: "cors", credentials: "same-origin" });
  if (!response.ok) throw new Error(`Resource request failed (${response.status})`);
  const blob = await response.blob();
  if (blob.size > MAX_INLINE_RESOURCE_BYTES) throw new Error("Resource exceeds inline size limit");
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Could not read resource"));
    reader.readAsDataURL(blob);
  });
}

function requestWidgetFrameCapture(frame: HTMLIFrameElement): Promise<string> {
  const frameWindow = frame.contentWindow;
  if (!frameWindow) return Promise.reject(new Error("Widget frame is not available."));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error("Sandbox widget capture timed out.")), 1800);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameWindow) return;
      const message = event.data;
      if (!message || message.type !== "duya:canvas-capture-response" || message.requestId !== requestId) return;
      if (typeof message.error === "string") return finish(new Error(message.error));
      if (typeof message.dataUrl !== "string") return finish(new Error("Sandbox widget returned no image."));
      const match = message.dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
      if (!match || match[1].length * 0.75 > 6 * 1024 * 1024) {
        return finish(new Error("Sandbox widget returned an invalid or oversized PNG."));
      }
      finish(undefined, message.dataUrl);
    };
    const finish = (error?: Error, result?: string) => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (error) reject(error); else resolve(result!);
    };
    window.addEventListener("message", onMessage);
    frameWindow.postMessage({ type: "duya:canvas-capture-request", requestId }, "*");
  });
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image renderer rejected the screenshot source"));
    image.src = source;
  });
}

function safeResourceName(value: string): string {
  try { return new URL(value, document.baseURI).hostname || "local resource"; }
  catch { return "local resource"; }
}

/**
 * Turn a canvas-space rectangle into a concrete crop plan:
 *
 * 1. If the rect is not fully visible under the current view transform,
 *    temporarily apply a fit transform to `.canvas-inner` (pan/zoom only
 *    shrinks; never magnifies past the user's current zoom) and wait for
 *    paint. `plan.restore()` puts the previous transform back.
 * 2. Clip the on-screen projection to the viewport bounds. A rect too
 *    large for the zoom floor yields the largest visible intersection —
 *    callers report actual size via the returned width/height.
 */
async function frameOnScreen(
  canvasRect: CaptureRect,
  canvasInnerEl: HTMLElement | null,
  viewportW: number,
  viewportH: number,
): Promise<CropPlan> {
  const t = readTransform();
  let screen = canvasRectToScreen(canvasRect, t);

  if (!isRectFullyVisible(screen, viewportW, viewportH)) {
    if (!canvasInnerEl) {
      throw new Error(
        "Canvas content layer (.canvas-inner) is not mounted; cannot frame the requested canvas area.",
      );
    }
    const fit = computeFitTransform(canvasRect, viewportW, viewportH, t);
    const previousTransform = canvasInnerEl.style.transform;
    canvasInnerEl.style.transform =
      `translate(${fit.transform.panX}px, ${fit.transform.panY}px) ` +
      `scale(${fit.transform.zoom})`;
    await waitForPaint(2);
    screen = fit.screenRect;
    return {
      screen,
      restore: async () => {
        canvasInnerEl.style.transform = previousTransform;
        await waitForPaint(1);
      },
    };
  }

  const clipped = clipRectToViewport(screen, viewportW, viewportH);
  if (!clipped) {
    throw new Error(
      `Requested canvas rect (${canvasRect.x}, ${canvasRect.y}, ` +
        `${canvasRect.w}, ${canvasRect.h}) has no on-screen intersection.`,
    );
  }
  return { screen: clipped, restore: async () => {} };
}

function readTransform(): CanvasTransform {
  return {
    panX: canvasTransformState.panX,
    panY: canvasTransformState.panY,
    zoom: canvasTransformState.zoom,
  };
}

/**
 * Yield to the browser for `frames` animation frames so React commit and
 * paint actually finish before html2canvas walks the transformed DOM.
 * Falls back to timeouts in environments without rAF (jsdom tests).
 */
async function waitForPaint(frames: number): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resolve());
      } else {
        setTimeout(resolve, 16);
      }
    });
  }
}
