import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConductorHostContext, type ConductorHost } from "../../src/renderer/host";
import { pluginBridge } from "../../src/renderer/plugin-bridge";
import { ConductorView } from "../../src/renderer/components/ConductorView";
import "../../src/app.css";

const settingCache = new Map<string, unknown>();
const host: ConductorHost = {
  listProviders: async () => [],
  agent: { callRefine: async () => { throw new Error("Refine requires a provider capability that this App has not been granted."); } },
  settings: {
    getJson: async <T,>(key: string, fallback: T): Promise<T> => settingCache.has(key) ? settingCache.get(key) as T : fallback,
    setJson: async <T,>(key: string, value: T) => { settingCache.set(key, value); },
    getString: async (key: string) => typeof settingCache.get(key) === "string" ? settingCache.get(key) as string : null,
    setString: async (key: string, value: string) => { settingCache.set(key, value); },
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
