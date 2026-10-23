import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConductorHostContext, type ConductorHost, type ConductorProvider, type ConductorProviderStatus } from "../../src/renderer/host";
import { pluginBridge } from "../../src/renderer/plugin-bridge";
import { ConductorView } from "../../src/renderer/components/ConductorView";
import "../../src/app.css";

const host: ConductorHost = {
  listProviders: async () => {
    const result = await pluginBridge.call<{ providers?: ConductorProvider[] }>("canvas_provider_list");
    return result.providers ?? [];
  },
  agent: {
    callRefine: async (args) => pluginBridge.call("canvas_refine_call", args),
    callCanvasRequest: async (args) => pluginBridge.call("canvas_agent_request", args),
  },
  providers: {
    status: async () => pluginBridge.call<ConductorProviderStatus>("canvas_provider_status"),
    configure: async (args) => { await pluginBridge.call("canvas_provider_configure", args); },
  },
  settings: {
    getJson: async <T,>(key: string, fallback: T): Promise<T> => {
      const result = await pluginBridge.call<{ value?: T }>("canvas_settings_get", { key });
      return result && Object.hasOwn(result, "value") ? result.value as T : fallback;
    },
    setJson: async <T,>(key: string, value: T) => { await pluginBridge.call("canvas_settings_set", { key, value }); },
    getString: async (key: string) => {
      const result = await pluginBridge.call<{ value?: unknown }>("canvas_settings_get", { key });
      return typeof result?.value === "string" ? result.value : null;
    },
    setString: async (key: string, value: string) => { await pluginBridge.call("canvas_settings_set", { key, value }); },
  },
};

function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void pluginBridge.bind().then(() => { if (active) setReady(true); }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    const revoke = () => { void pluginBridge.revoke(); };
    window.addEventListener("pagehide", revoke);
    return () => { active = false; window.removeEventListener("pagehide", revoke); revoke(); };
  }, [attempt]);
  if (!ready) return <main className="plugin-app-status"><h1>Conductor Canvas</h1>{error ? <><p>{error}</p><button onClick={() => { setError(""); setAttempt((value) => value + 1); }}>Reconnect</button></> : <p>Connecting to the Canvas plugin…</p>}</main>;
  return <ConductorHostContext.Provider value={host}><ConductorView /></ConductorHostContext.Provider>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Canvas app root element is missing.");
createRoot(root).render(<App />);
