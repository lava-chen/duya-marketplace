"use client";

/** Standalone Apps have no host screenshot request channel. Capture remains
 * available in the local editor through the refine screenshot helpers. */
export function useCanvasCaptureRequest(_activeCanvasId?: string | null): void {}
