"use client";

import { useCallback, useEffect, useState } from "react";
import { PaperPlaneTiltIcon, SpinnerGapIcon } from "@/components/icons";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { useConductorStore } from "../stores/conductor-store";
import { useConductorHost } from "../host";

/** Canvas-owned agent composer; requests and actions stay inside the plugin. */
export function ConductorComposer() {
  const host = useConductorHost();
  const [value, setValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [reply, setReply] = useState("");
  const [providerReady, setProviderReady] = useState<boolean | null>(null);
  const { activeCanvasId, conductorModels, conductorModel, conductorModelsLoading, fetchConductorModels, setConductorModel, setUiError } = useConductorStore();

  useEffect(() => {
    void fetchConductorModels();
    const refresh = () => void fetchConductorModels();
    window.addEventListener("focus", refresh);
    void host.providers.status().then((status) => setProviderReady(status.configured && status.hasApiKey)).catch(() => setProviderReady(false));
    return () => window.removeEventListener("focus", refresh);
  }, [fetchConductorModels, host]);

  const handleSend = useCallback(async () => {
    const prompt = value.trim();
    if (!prompt || !activeCanvasId || isSending) return;
    setIsSending(true);
    setReply("");
    setUiError(null);
    try {
      const result = await host.agent.callCanvasRequest({ canvasId: activeCanvasId, prompt, ...(conductorModel ? { model: conductorModel } : {}) });
      setReply(result.message || (result.applied.length ? `Applied ${result.applied.length} canvas change${result.applied.length === 1 ? "" : "s"}.` : "No changes were needed."));
      setValue("");
      window.dispatchEvent(new CustomEvent("plugin-canvas:changed", { detail: activeCanvasId }));
    } catch (error) {
      setUiError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSending(false);
    }
  }, [activeCanvasId, conductorModel, host, isSending, setUiError, value]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void handleSend(); }
  };
  const canSend = Boolean(value.trim() && activeCanvasId && providerReady && !isSending);

  return <div className="flex-shrink-0 bg-transparent">
    {reply && <p className="px-3 pb-2 text-xs text-[var(--muted)]" role="status">{reply}</p>}
    {providerReady === false && <p className="px-3 pb-2 text-xs text-[var(--muted)]">Configure an OpenAI-compatible provider in Canvas Settings to use the canvas agent.</p>}
    <div className="flex items-center gap-2 bg-[var(--main-bg)] rounded-lg px-3 h-10">
      {isSending && <SpinnerGapIcon size={14} className="animate-spin text-[var(--muted)] flex-shrink-0" />}
      <textarea value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={handleKeyDown} placeholder="Describe what you want on the canvas..." rows={1} className="flex-1 bg-transparent border-none outline-none resize-none text-[13px] text-[var(--text)] placeholder:text-[var(--muted)] placeholder:opacity-50 min-h-0 max-h-[92px] py-0" />
      <div className="flex-shrink-0"><ModelSelector models={conductorModels} selectedModelId={conductorModel} onSelect={setConductorModel} disabled={isSending || conductorModels.length === 0} loading={conductorModelsLoading} variant="compact" /></div>
      <button type="button" onClick={() => void handleSend()} disabled={!canSend} aria-label="Send canvas request" className="flex items-center justify-center w-7 h-7 rounded-full bg-[var(--send-btn)] text-white hover:bg-[var(--send-btn-hover)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"><PaperPlaneTiltIcon size={14} /></button>
    </div>
  </div>;
}
